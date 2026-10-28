import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { compress } from "lzma1";
import { RangeOperation } from "../src/bundle/rangeIO.js";

import { assertMatchesGolden, loadFixture, type StreamFile } from "../../../fixtures/helpers.js";
import { readBundle } from "../src/bundle/BundleFile.js";
import { lzmaDecompress, streamLzma } from "../src/codec/lzma.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";

const hex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));

/**
 * Vectors from CPython's `lzma` module (liblzma), compressed as
 * `FORMAT_RAW` + `FILTER_LZMA1` with `dict_size=0x800000` - the same filter
 * UnityPy's writer uses - and recorded here as `props ++ bitstream`. The
 * payload is `("unity-asset-reader/" * 40)[:512]`.
 */
const PAYLOAD = Uint8Array.from({ length: 512 }, (_, i) =>
  "unity-asset-reader/".charCodeAt(i % 19),
);
const PROPS_5D = hex("5d00008000");
const STREAM_5D = hex(
  "003a9b8962453cf15ddc94ba6c46122fe93c3fc99e5ef5d7b185414bffffeb3b0000",
);
/** The same payload at `lc 0, lp 0, pb 3` - properties byte 135, legal LZMA. */
const PROPS_PB3 = hex("8700008000");
const STREAM_PB3 = hex(
  "003a9bfc40ca6a9d13ad7f559fd0b18be816356c508a9dc24535d067ffff40f80000",
);
/** An empty payload: a real stream that decodes to zero bytes. */
const STREAM_EMPTY = hex("0083fffbffffc0000000");

test("decodes a stream whose properties Unity always writes (0x5d: lc3/lp0/pb2)", () => {
  assert.deepEqual(lzmaDecompress(PROPS_5D, STREAM_5D, PAYLOAD.length), PAYLOAD);
});

test("decodes a zero-byte stream", () => {
  assert.deepEqual(lzmaDecompress(PROPS_5D, STREAM_EMPTY, 0), new Uint8Array(0));
});

test("does not read or write outside the buffers it was given", () => {
  const backing = new Uint8Array(STREAM_5D.length + 16).fill(0xee);
  const data = backing.subarray(8, 8 + STREAM_5D.length);
  data.set(STREAM_5D);
  assert.deepEqual(lzmaDecompress(PROPS_5D, data, PAYLOAD.length), PAYLOAD);
  assert.equal(backing[7], 0xee);
  assert.equal(backing[backing.length - 1], 0xee);
});

// --- The two Unity stream shapes, on committed fixtures --------------------

test("unpacks a UnityFS bundle whose blocks info and blocks are both LZMA", () => {
  // Shape 1, end to end: `readBundle` decompresses the blocks info and every
  // storage block through this codec. BundleFile.test.ts covers the same
  // fixture from the parser's side; this asserts it from the codec's.
  assertMatchesGolden("lzma.bundle", readBundle(loadFixture("lzma.bundle")).files);
});

test("decodes the LZMA level of a legacy UnityWeb bundle", () => {
  // Shape 2: the stream carries its own 13-byte header, so the u64 size is read
  // out of it instead of coming from the container. `readBundle` covers the
  // same fixture end to end (#18); this walks the v3 header by hand so the
  // assertion below - that the in-stream size is the one the codec is given -
  // is made against the bytes rather than against the parser.
  const bundle = loadFixture("unityweb-lzma.bundle");
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  let pos = 0;
  const stringToNull = (): string => {
    let out = "";
    while (bundle[pos] !== 0) out += String.fromCharCode(bundle[pos++] as number);
    pos++;
    return out;
  };
  const u32 = (): number => {
    const value = view.getUint32(pos);
    pos += 4;
    return value;
  };

  assert.equal(stringToNull(), "UnityWeb");
  assert.equal(u32(), 3, "fixture should be a format v3 legacy bundle");
  stringToNull(); // unityVersion
  stringToNull(); // unityRevision
  u32(); // minimum streamed bytes
  const headerSize = u32();
  u32(); // levels to download before streaming
  const levelCount = u32();
  // Upstream keeps only the last level; every level but the last is a prefix of it.
  let level = { compressedSize: 0, uncompressedSize: 0 };
  for (let i = 0; i < levelCount; i++) level = { compressedSize: u32(), uncompressedSize: u32() };

  const stream = bundle.subarray(headerSize, headerSize + level.compressedSize);
  const declaredSize = new DataView(
    stream.buffer,
    stream.byteOffset,
    stream.byteLength,
  ).getBigUint64(5, true);
  assert.equal(declaredSize, BigInt(level.uncompressedSize));

  const blob = lzmaDecompress(stream.subarray(0, 5), stream.subarray(13), Number(declaredSize));

  // The decompressed level is the directory: a node count, then path/offset/size.
  const blobView = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  pos = 0;
  const files: StreamFile[] = [];
  const nodeCount = blobView.getUint32(0);
  pos = 4;
  for (let i = 0; i < nodeCount; i++) {
    let path = "";
    while (blob[pos] !== 0) path += String.fromCharCode(blob[pos++] as number);
    pos++;
    const offset = blobView.getUint32(pos);
    const size = blobView.getUint32(pos + 4);
    pos += 8;
    files.push({ path, data: blob.subarray(offset, offset + size) });
  }

  assertMatchesGolden("unityweb-lzma.bundle", files);
});

// --- Unhappy paths ---------------------------------------------------------

test("rejects truncated input through the strict 0.6.1 raw decoder (R9)", () => {
  assert.throws(
    () => lzmaDecompress(PROPS_5D, STREAM_5D.subarray(0, 12), PAYLOAD.length),
    (error: unknown) =>
      error instanceof CorruptError &&
      /expected 512 bytes.*Truncated input/.test(String(error)),
  );
});

test("rejects an uncompressedSize the stream does not expand to", () => {
  assert.throws(
    () => lzmaDecompress(PROPS_5D, STREAM_5D, 1024),
    (error: unknown) =>
      error instanceof CorruptError &&
      /expected 1024 bytes.*end marker before the declared size/.test(error.message),
  );
});

test("rejects an uncompressedSize smaller than the stream expands to", () => {
  assert.throws(
    () => lzmaDecompress(PROPS_5D, STREAM_5D, 100),
    (error: unknown) =>
      error instanceof CorruptError && /expected 100 bytes/.test(String(error)),
  );
});

test("reports a stream lzma1 itself rejects as a CorruptError", () => {
  assert.throws(
    () => lzmaDecompress(PROPS_5D, new Uint8Array(0), 512),
    (error: unknown) =>
      error instanceof CorruptError &&
      /LZMA stream of 0 bytes failed to decode.*Truncated input/.test(String(error)),
  );
});

test("rejects an uncompressedSize that is not a byte count, as CorruptError (R9)", () => {
  for (const size of [2 ** 53, -1, Infinity, NaN, 1.5]) {
    assert.throws(
      () => lzmaDecompress(PROPS_5D, STREAM_5D, size),
      (error: unknown) =>
        error instanceof CorruptError &&
        error.message === `LZMA uncompressed size ${size} is not a byte count`,
      `size ${size} should be rejected as CorruptError`,
    );
  }
});

test("rejects properties that are not exactly five bytes", () => {
  for (const props of [hex(""), hex("5d000080"), hex("5d0000800000")]) {
    assert.throws(
      () => lzmaDecompress(props, STREAM_5D, PAYLOAD.length),
      (error: unknown) =>
        error instanceof CorruptError &&
        error.message === `LZMA properties are ${props.length} bytes, expected 5`,
    );
  }
});

test("rejects a properties byte that is not a legal lc/lp/pb triple", () => {
  // 225 and up decode to pb 5, which the format does not have.
  assert.throws(
    () => lzmaDecompress(hex("e100008000"), STREAM_5D, PAYLOAD.length),
    (error: unknown) =>
      error instanceof CorruptError &&
      error.message ===
        "LZMA properties byte 0xe1 is above the largest legal value 0xe0 (lc 8, lp 4, pb 4)",
  );
});

test("0.6.1 safely decodes the independently recorded legal pb3 vector", () => {
  assert.deepEqual(lzmaDecompress(PROPS_PB3, STREAM_PB3, PAYLOAD.length), PAYLOAD);
});

for (const [props, stream] of [[PROPS_5D, STREAM_5D], [PROPS_PB3, STREAM_PB3]]) {
  test(`incremental liblzma golden, including the buffered end tail (${props![0]})`, async () => {
    const operation = new RangeOperation();
    const chunks: Uint8Array[] = [];
    try {
      await streamLzma(props!, async (offset, size) => stream!.slice(offset, offset + size),
        stream!.length, PAYLOAD.length, async (bytes) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          chunks.push(bytes.slice());
        }, operation);
      assert.deepEqual(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])), PAYLOAD);
    } finally { operation.finish(); }
  });
}

test("cancelled waits observe eager and delayed rejections while preserving the abort reason", async () => {
  const abort = new AbortController();
  const reason = Object.freeze(new Error("original cancellation"));
  abort.abort(reason);
  const operation = new RangeOperation(abort.signal);
  try {
    // No catch is attached outside wait(): the Node test runner must see an
    // orphan if an already-cancelled operation neglects either input promise.
    await assert.rejects(operation.wait(Promise.reject(new Error("eager read failed"))),
      (error: unknown) => error === reason);
    let rejectInput!: (error: Error) => void;
    const input = new Promise<never>((_resolve, reject) => { rejectInput = reject; });
    await assert.rejects(operation.wait(input), (error: unknown) => error === reason);
    rejectInput(new Error("late read failed"));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.throws(() => operation.check(), (error: unknown) => error === reason);
  } finally { operation.finish(); }
});

test("cancelling active waits settles each once and observes later input outcomes", async () => {
  const operation = new RangeOperation();
  const reason = Object.freeze(new Error("active cancellation"));
  let resolveInput!: (bytes: Uint8Array) => void;
  let rejectInput!: (error: Error) => void;
  const first = operation.wait(new Promise<Uint8Array>((resolve) => { resolveInput = resolve; }));
  const second = operation.wait(new Promise<never>((_resolve, reject) => { rejectInput = reject; }));
  const outcomes = Promise.all([first, second].map((wait) =>
    assert.rejects(wait, (error: unknown) => error === reason)));
  try {
    operation.cancel(reason);
    operation.cancel(new Error("must not replace original cancellation"));
    await outcomes;
    resolveInput(new Uint8Array(16));
    rejectInput(new Error("read rejected after cancellation"));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.throws(() => operation.check(), (error: unknown) => error === reason);
  } finally { operation.finish(); }
});

test("incremental raw decoder rejects truncated, short-size and oversized-dictionary input", async () => {
  for (const [props, input, size, error] of [
    [PROPS_5D, STREAM_5D.subarray(0, 12), 512, CorruptError],
    [PROPS_5D, STREAM_5D, 1024, CorruptError],
    [PROPS_5D, STREAM_5D, 100, CorruptError],
    [hex("5dffffffff"), STREAM_5D, 512, UnsupportedError],
  ] as const) {
    const operation = new RangeOperation();
    try {
      await assert.rejects(streamLzma(props, async (at, length) => input.slice(at, at + length),
        input.length, size, async () => {}, operation), error);
    } finally { operation.finish(); }
    // Let delayed stream rejections surface within this test's lifetime.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
});

test("incremental raw decoder cancels stalled input, consumer and a large in-flight stream", async () => {
  for (const where of ["before", "input", "consumer", "turn"] as const) {
    const abort = new AbortController();
    const reason = new Error(`cancel ${where}`);
    if (where === "before") abort.abort(reason);
    const operation = new RangeOperation(abort.signal);
    const size = where === "turn" ? 4 * 1024 * 1024 : PAYLOAD.length;
    const container = where === "turn" ? compress(new Uint8Array(size).fill(65), {
      dictSize: 524288,
    }) : undefined;
    const input = container?.subarray(13) ?? STREAM_5D;
    const props = container?.subarray(0, 5) ?? PROPS_5D;
    let calls = 0;
    if (where === "turn") setTimeout(() => abort.abort(reason), 0);
    try {
      await assert.rejects(streamLzma(props, async (at, length) => {
        if (where === "input") {
          setTimeout(() => abort.abort(reason), 0);
          return new Promise<Uint8Array>(() => {});
        }
        return input.slice(at, at + length);
      }, input.length, size, async () => {
        calls++;
        if (where === "consumer") {
          setTimeout(() => abort.abort(reason), 0);
          await new Promise<void>(() => {});
        }
      }, operation), (error: unknown) => error === reason);
      if (where === "before" || where === "input") assert.equal(calls, 0);
    } finally { operation.finish(); }
  }
});

test("48 MiB one-block expansion bounds native queues and releases completed waits/output before finish", () => {
  // The expected bytes are specified independently (48 MiB of ASCII A). The
  // upstream encoder only writes this owned stress fixture, never its golden.
  // The smaller fixed vectors above are independent liblzma compatibility proof.
  const size = 48 * 1024 * 1024;
  const container = compress(new Uint8Array(size).fill(65), { dictSize: 524288 });
  const module = new URL("../src/codec/lzma.ts", import.meta.url).href;
  const io = new URL("../src/bundle/rangeIO.ts", import.meta.url).href;
  // Isolate controller instrumentation in a child: never replace streams in
  // the test runner or product. Native transform/backpressure semantics remain.
  const script = `
import assert from 'node:assert/strict';
const Native = globalThis.TransformStream;
let queued=0, peak=0, enqueues=0;
globalThis.TransformStream=class extends Native {
  constructor(transformer) {
    const wrapped={...transformer,start(controller) {
      transformer.start({enqueue(bytes) {
        queued+=bytes.length; peak=Math.max(peak,queued); enqueues++;
        controller.enqueue(bytes);
      }});
    }};
    super(wrapped);
    const get=this.readable.getReader.bind(this.readable);
    this.readable.getReader=(...args)=>{
      const reader=get(...args), read=reader.read.bind(reader);
      reader.read=async()=>{const result=await read();if(!result.done)queued-=result.value.length;return result;};
      return reader;
    };
  }
};
// tsx follows the nearest package type: these .ts files can be CommonJS
// namespace defaults when imported from this ESM eval child.
const codec=await import(${JSON.stringify(module)});
const ioModule=await import(${JSON.stringify(io)});
const streamLzma=codec.streamLzma??codec.default?.streamLzma;
const RangeOperation=ioModule.RangeOperation??ioModule.default?.RangeOperation;
assert.equal(typeof streamLzma,'function');
assert.equal(typeof RangeOperation,'function');
const bytes=Uint8Array.from(Buffer.from(${JSON.stringify(Buffer.from(container).toString("base64"))},'base64'));
const operation=new RangeOperation();
// An explicit root prevents the operation itself from becoming collectible:
// completed bytes must release while its cancellation machinery stays alive.
globalThis.retainedRangeOperation=operation;
assert.equal(typeof globalThis.gc,'function');
const completedWaits=[], completedOutput=[];
async function collectReleased(refs,allowance) {
  let retained=Infinity;
  for(let attempt=0;attempt<16;attempt++) {
    // WeakRef targets survive their creation/deref job. Cross real task and
    // full-GC boundaries, rather than sleeping or relying on heap estimates.
    await new Promise(resolve=>setImmediate(resolve));
    globalThis.gc();
    await new Promise(resolve=>setImmediate(resolve));
    retained=refs.reduce((sum,ref)=>sum+(ref.deref()?.byteLength??0),0);
    if(retained<=allowance) return retained;
  }
  assert.ok(retained<=allowance,'completed buffers retained '+retained+' bytes, allowance '+allowance);
  return retained;
}
async function manySmallWaits() {
  for(let index=0;index<2048;index++) {
    const value={bytes:new Uint8Array(16384),index};
    completedWaits.push(new WeakRef(value.bytes.buffer));
    if(index%2===0) {
      assert.equal(await operation.wait(Promise.resolve(value)),value);
    } else {
      await assert.rejects(operation.wait(Promise.reject(value)),error=>error===value);
    }
  }
}
let total=0, maximumCurrent=0, waitRetained=0, outputRetained=0;
try {
  await manySmallWaits();
  waitRetained=await collectReleased(completedWaits,2*16384);
  operation.check();
  await streamLzma(bytes.subarray(0,5),async(at,n)=>bytes.subarray(13+at,13+at+n),bytes.length-13,${size},async(chunk)=>{
    assert.ok(chunk.every(value=>value===65)); total+=chunk.length;
    completedOutput.push(new WeakRef(chunk.buffer));
    maximumCurrent=Math.max(maximumCurrent,chunk.length);
    const before=enqueues;
    await new Promise(resolve=>setTimeout(resolve,1));
    // A consumer may hold the preceding chunk while one bounded write runs.
    assert.ok(queued<=2*512*273*(16+64+1)+524288);
    assert.ok(enqueues>=before);
  },operation);
  assert.equal(total,${size}); assert.equal(queued,0); assert.ok(peak>0);
  assert.ok(peak+maximumCurrent<=2*512*273*(16+64+1)+2*524288);
  // Allow only a constant number of dictionary/current-chunk-sized buffers,
  // never the 48 MiB output history. Check before cancel() or finish().
  outputRetained=await collectReleased(completedOutput,2*524288+maximumCurrent);
  operation.check();
  assert.equal(globalThis.retainedRangeOperation,operation);
  console.log(JSON.stringify({total,peak,maximumCurrent,waitRetained,outputRetained}));
} finally {operation.finish();delete globalThis.retainedRangeOperation;}
`;
  const result = spawnSync(process.execPath, ["--expose-gc", "--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.total, size);
  assert.ok(measured.waitRetained <= 2 * 16384);
  assert.ok(measured.outputRetained <= 2 * 524288 + measured.maximumCurrent);
});
