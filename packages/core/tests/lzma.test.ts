import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
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

// Removing deliberate turns must not relax the codec's byte validation or its
// ownership of pending source and consumer promises.
for (const taskYieldPolicy of [undefined, "caller-owned"] as const) {
test(`incremental raw decoder rejects truncated, short-size and oversized-dictionary input${taskYieldPolicy ? ` (${taskYieldPolicy})` : ""}`, async () => {
  for (const [props, input, size, error] of [
    [PROPS_5D, STREAM_5D.subarray(0, 12), 512, CorruptError],
    [PROPS_5D, STREAM_5D, 1024, CorruptError],
    [PROPS_5D, STREAM_5D, 100, CorruptError],
    [hex("5dffffffff"), STREAM_5D, 512, UnsupportedError],
  ] as const) {
    const operation = new RangeOperation(undefined, undefined, taskYieldPolicy);
    try {
      await assert.rejects(streamLzma(props, async (at, length) => input.slice(at, at + length),
        input.length, size, async () => {}, operation), error);
    } finally { operation.finish(); }
    // Let delayed stream rejections surface within this test's lifetime.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
});

test(`incremental raw decoder cancels stalled input, consumer and a large in-flight stream${taskYieldPolicy ? ` (${taskYieldPolicy})` : ""}`, async () => {
  for (const where of ["before", "input", "consumer", "turn"] as const) {
    const abort = new AbortController();
    const reason = new Error(`cancel ${where}`);
    if (where === "before") abort.abort(reason);
    const operation = new RangeOperation(abort.signal, undefined, taskYieldPolicy);
    const size = where === "turn" ? 4 * 1024 * 1024 : PAYLOAD.length;
    const container = where === "turn" ? compress(new Uint8Array(size).fill(65), {
      dictSize: 524288,
    }) : undefined;
    const input = container?.subarray(13) ?? STREAM_5D;
    const props = container?.subarray(0, 5) ?? PROPS_5D;
    let calls = 0;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(streamLzma(props, async (at, length) => {
        if (where === "input") {
          cancelTimer = setTimeout(() => abort.abort(reason), 0);
          return new Promise<Uint8Array>(() => {});
        }
        return input.slice(at, at + length);
      }, input.length, size, async (bytes) => {
        calls++;
        if (where === "consumer") {
          cancelTimer = setTimeout(() => abort.abort(reason), 0);
          await new Promise<void>(() => {});
        }
        if (where === "turn") {
          // Abort at actual partial output, before stream completion can race a
          // timer. External task/message delivery is covered by the worker test.
          assert.ok(bytes.length > 0 && bytes.length < size, `cancel ${where}: partial output`);
          abort.abort(reason);
        }
      }, operation), (error: unknown) => error === reason, `cancel ${where}`);
      if (where === "before" || where === "input") assert.equal(calls, 0, `cancel ${where}`);
      if (where === "turn") assert.equal(calls, 1, `cancel ${where}: no later output`);
    } finally {
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
      operation.finish();
    }
  }
});
}

test("range task turns preserve concurrent waits, queued cancellation, worker messages and timer fallback", () => {
  const io = new URL("../src/bundle/rangeIO.ts", import.meta.url).href;
  // Bundle the actual module and its real imports into memory. The worker then
  // loads ordinary JS, independent of Node's strip-only/tsx interop; no fixture
  // class copy or generated source file can drift from the implementation.
  const bundle = buildSync({
    entryPoints: [fileURLToPath(io)], bundle: true, write: false,
    format: "esm", platform: "node", target: "es2020",
  });
  assert.equal(bundle.outputFiles.length, 1);
  const workerModule = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString("base64")}`;
  const workerScript = `
import assert from 'node:assert/strict';
import {parentPort,workerData} from 'node:worker_threads';
const module=await import(workerData);
const RangeOperation=module.RangeOperation??module.default?.RangeOperation;
const abort=new AbortController(), reason=new Error('worker message cancellation');
const operation=new RangeOperation(abort.signal);
let calls=0;
parentPort.once('message',()=>abort.abort(reason));
parentPort.postMessage('running');
try {
  while(true) {calls++;await operation.yield();}
} catch(error) {
  assert.equal(error,reason);
  parentPort.postMessage({cancelled:true,calls});
} finally {operation.finish();parentPort.close();}
`;
  // A child bounds a broken microtask-only implementation too: an in-process
  // timeout cannot fire if it starves the event loop. No speed assertion is made.
  const script = `
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
const module=await import(${JSON.stringify(io)});
const RangeOperation=module.RangeOperation??module.default?.RangeOperation;
const NativeChannel=globalThis.MessageChannel, nativeTimeout=globalThis.setTimeout;
let channels=0, closes=0;
globalThis.MessageChannel=class {
  constructor() {
    channels++;
    const channel=new NativeChannel();
    for(const port of [channel.port1,channel.port2]) {
      const close=port.close.bind(port);
      port.close=()=>{closes++;close();};
    }
    return channel;
  }
};
const operation=new RangeOperation();
try {
  for(let i=0;i<63;i++) await operation.yield();
  assert.equal(channels,0,'short work must not allocate ports');
  const producer=operation.yield();
  for(let i=0;i<63;i++) await operation.yield();
  const consumer=operation.yield();
  await Promise.all([producer,consumer]);
  assert.equal(channels,1,'concurrent turns share one channel, not one resolver');
} finally {operation.finish();operation.finish();}
assert.equal(closes,2,'finish closes both ports exactly once');
const abort=new AbortController(), reason=Object.freeze(new Error('queued task cancelled'));
const cancelled=new RangeOperation(abort.signal);
try {
  for(let i=0;i<63;i++) await cancelled.yield();
  const pending=cancelled.yield();
  const rejected=assert.rejects(pending,error=>error===reason);
  abort.abort(reason);
  await rejected;
  await assert.rejects(cancelled.yield(),error=>error===reason);
} finally {cancelled.finish();}
assert.equal(channels,2);assert.equal(closes,4,'cancel releases ports before finish');
const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(${JSON.stringify(workerScript)})),{
  workerData:${JSON.stringify(workerModule)},execArgv:[],
});
let reply;
try {
  const result=new Promise((resolve,reject)=>{
    worker.on('message',message=>{
      if(message==='running') worker.postMessage('abort');
      else {reply=message;resolve(message);}
    });
    worker.on('error',reject);
    worker.on('exit',()=>{if(!reply)reject(new Error('worker exited before reporting cancellation'));});
  });
  const exit=new Promise((resolve,reject)=>{
    worker.on('error',reject);
    worker.on('exit',code=>code===0?resolve():reject(new Error('worker exit '+code)));
  });
  await Promise.all([result,exit]);
  assert.equal(reply.cancelled,true);
  assert.ok(reply.calls>=64,'abort message must run while the yielding loop is active');
} finally {await worker.terminate();}
// Simulate only the missing host capability, retaining the real native timer.
globalThis.MessageChannel=undefined;
let timers=0;
globalThis.setTimeout=(...args)=>{timers++;return nativeTimeout(...args);};
const fallback=new RangeOperation();
try {
  for(let i=0;i<128;i++) await fallback.yield();
  assert.equal(timers,2,'fallback retains the shared 64-call task cadence');
} finally {
  fallback.finish();globalThis.MessageChannel=NativeChannel;globalThis.setTimeout=nativeTimeout;
}
console.log(JSON.stringify({channels,closes,workerCalls:reply.calls,timers}));
`;
  const result = spawnSync(process.execPath,
    ["--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, [result.stderr, result.stdout, String(result.error)].join("\n"));
});

for (const taskYieldPolicy of [undefined, "caller-owned"] as const) {
test(`48 MiB one-block expansion bounds native queues and releases completed waits/output before finish${taskYieldPolicy ? ` (${taskYieldPolicy})` : ""}`, () => {
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
const NativeChannel = globalThis.MessageChannel;
const nativeTimeout = globalThis.setTimeout;
let current, inYield=false;
const timings=[];
let channels=0, closedPorts=0;
// Observe native port tasks too; keep the original postMessage and delivery.
// Queue only timing scalars, never decoded output or a per-write trace.
globalThis.MessageChannel=class {
  constructor() {
    const channel=new NativeChannel(), sent=[];
    channels++;
    const post=channel.port2.postMessage.bind(channel.port2);
    channel.port2.postMessage=(...args)=>{
      const owner=inYield?current:undefined;
      sent.push({owner,began:performance.now()});
      if(owner) owner.yieldMessages++;
      return post(...args);
    };
    channel.port1.addEventListener('message',()=>{
      const delivery=sent.shift();
      if(delivery?.owner) delivery.owner.yieldMessageWaitMs+=performance.now()-delivery.began;
    });
    for(const port of [channel.port1,channel.port2]) {
      const close=port.close.bind(port);
      port.close=()=>{closedPorts++;close();};
    }
    return channel;
  }
};
// Observe only timers synchronously scheduled by the real yield method. Keep
// its cadence, native timer, stream pressure and cancellation path unchanged.
globalThis.setTimeout=(callback,delay,...args)=>{
  const owner=inYield?current:undefined, began=performance.now();
  if(owner) owner.yieldTimers++;
  return nativeTimeout(()=>{
    if(owner) owner.yieldTimerWaitMs+=performance.now()-began;
    callback(...args);
  },delay);
};
function observeOperation(operation) {
  const yieldTask=operation.yield.bind(operation);
  operation.yield=()=>{
    if(current) current.yieldCalls++;
    inYield=true;
    try {return yieldTask();} finally {inYield=false;}
  };
}
async function measure(label,inputBytes,outputBytes,consumer,work) {
  const record={label,inputBytes,expectedOutputBytes:outputBytes,consumer,context:'isolated Node child',
    runtime:process.version,dependency:'lzma1@0.6.1',dictSize:524288,
    source:'in-memory .lzma fixture; encoding excluded',observerOverhead:'included, not independently measured',
    accounting:'overlapping elapsed aggregates; do not sum or label waits as CPU',
    transformCalls:0,transformMs:0,flushMs:0,writeCalls:0,writeBytes:0,writeWaitMs:0,
    readWaitMs:0,readBytes:0,sourceCalls:0,sourceMs:0,consumerCalls:0,consumerMs:0,
    yieldCalls:0,yieldTimers:0,yieldTimerWaitMs:0,yieldMessages:0,yieldMessageWaitMs:0,peakQueuedBytes:0};
  current=record;
  const began=performance.now(), cpu=process.cpuUsage();
  const snapshot=outcome=>({...record,outcome,wallMs:performance.now()-began,
    // Process CPU includes validation/observers too; transformMs is synchronous
    // wall time (including native enqueue/copies), not an exclusive CPU clock.
    processCpuMicroseconds:process.cpuUsage(cpu)});
  const heartbeat=setInterval(()=>console.error('UnityLzmaAttribution '+JSON.stringify(snapshot('running'))),5000);
  let outcome='error';
  try {await work();outcome='success';}
  finally {
    clearInterval(heartbeat);
    const result=snapshot(outcome);
    timings.push(result);
    console.error('UnityLzmaAttribution '+JSON.stringify(result));
    current=undefined;
  }
}
async function source(bytes,at,n) {
  const began=performance.now();
  try {return bytes.subarray(13+at,13+at+n);}
  finally {current.sourceCalls++;current.sourceMs+=performance.now()-began;}
}
async function consume(work) {
  const owner=current, began=performance.now();
  owner.consumerCalls++;
  try {await work();} finally {owner.consumerMs+=performance.now()-began;}
}
let queued=0, peak=0, enqueues=0;
globalThis.TransformStream=class extends Native {
  constructor(transformer) {
    const wrapped={...transformer,start(controller) {
      transformer.start({enqueue(bytes) {
        queued+=bytes.length; peak=Math.max(peak,queued); enqueues++;
        if(current) current.peakQueuedBytes=Math.max(current.peakQueuedBytes,queued);
        controller.enqueue(bytes);
      }});
    },transform(chunk,controller) {
      const owner=current, began=performance.now();
      owner.transformCalls++;
      try {return transformer.transform(chunk,controller);}
      finally {owner.transformMs+=performance.now()-began;}
    },flush(controller) {
      const owner=current, began=performance.now();
      try {return transformer.flush(controller);}
      finally {owner.flushMs+=performance.now()-began;}
    }};
    super(wrapped);
    const get=this.readable.getReader.bind(this.readable);
    this.readable.getReader=(...args)=>{
      const reader=get(...args), read=reader.read.bind(reader);
      reader.read=async()=>{
        const owner=current, began=performance.now();
        try {
          const result=await read();
          if(!result.done) {queued-=result.value.length;owner.readBytes+=result.value.length;}
          return result;
        }
        finally {owner.readWaitMs+=performance.now()-began;}
      };
      return reader;
    };
    const getWriter=this.writable.getWriter.bind(this.writable);
    this.writable.getWriter=(...args)=>{
      const writer=getWriter(...args), write=writer.write.bind(writer);
      writer.write=chunk=>{
        const owner=current, began=performance.now();
        owner.writeCalls++;owner.writeBytes+=chunk.length;
        const pending=write(chunk);
        const settled=()=>{owner.writeWaitMs+=performance.now()-began;};
        // Observe settlement without replacing the native write promise.
        void pending.then(settled,settled);
        return pending;
      };
      return writer;
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
const taskYieldPolicy=${JSON.stringify(taskYieldPolicy) ?? "undefined"};
const operation=new RangeOperation(undefined,undefined,taskYieldPolicy);
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
  observeOperation(operation);
  await measure('48 MiB repeated A',bytes.length-13,${size},'byte validation plus deliberate 1 ms pacing',async()=>{
    await streamLzma(bytes.subarray(0,5),(at,n)=>source(bytes,at,n),bytes.length-13,${size},chunk=>consume(async()=>{
      assert.ok(chunk.every(value=>value===65)); total+=chunk.length;
      completedOutput.push(new WeakRef(chunk.buffer));
      maximumCurrent=Math.max(maximumCurrent,chunk.length);
      const before=enqueues;
      await new Promise(resolve=>setTimeout(resolve,1));
      // A consumer may hold the preceding chunk while one bounded write runs.
      assert.ok(queued<=2*512*273*(16+64+1)+524288);
      assert.ok(enqueues>=before);
    }),operation);
  });
  assert.equal(total,${size}); assert.equal(queued,0); assert.ok(peak>0);
  assert.ok(peak+maximumCurrent<=2*512*273*(16+64+1)+2*524288);
  // Allow only a constant number of dictionary/current-chunk-sized buffers,
  // never the 48 MiB output history. Check before cancel() or finish().
  outputRetained=await collectReleased(completedOutput,2*524288+maximumCurrent);
  operation.check();
  assert.equal(globalThis.retainedRangeOperation,operation);
  operation.finish();
  // The expansion fixture has very few compressed writes. This bounded input
  // exercises write/yield scheduling; both byte expectations come from the
  // stated xorshift sequence, never from decoder output. It is not a corpus
  // workload. Fixture encoding is outside the measured interval, in this child
  // so no large base64 payload or commercial asset is passed through argv.
  const {compress}=await import('lzma1');
  let state=0x6601;
  const schedulingInput=Uint8Array.from({length:256*1024},()=>{
    state^=state<<13;state^=state>>>17;state^=state<<5;
    return state&255;
  });
  const schedulingBytes=compress(schedulingInput,{dictSize:524288});
  assert.ok(schedulingBytes.length>schedulingInput.length/2,
    'scheduling fixture must exercise compressed input, not just expansion');
  const schedulingOperation=new RangeOperation(undefined,undefined,taskYieldPolicy);
  observeOperation(schedulingOperation);
  let expectedState=0x6601, schedulingTotal=0;
  try {
    await measure('256 KiB xorshift seed 0x6601',schedulingBytes.length-13,schedulingInput.length,'independent byte validation; no deliberate delay',async()=>{
      await streamLzma(schedulingBytes.subarray(0,5),(at,n)=>source(schedulingBytes,at,n),schedulingBytes.length-13,schedulingInput.length,chunk=>consume(async()=>{
        for(const value of chunk) {
          expectedState^=expectedState<<13;expectedState^=expectedState>>>17;expectedState^=expectedState<<5;
          assert.equal(value,expectedState&255);
          schedulingTotal++;
        }
      }),schedulingOperation);
    });
    assert.equal(schedulingTotal,schedulingInput.length);
    assert.equal(queued,0);
    for(const record of timings) {
      assert.equal(record.writeBytes,record.inputBytes);
      assert.equal(record.readBytes,record.expectedOutputBytes);
      assert.equal(record.writeCalls,Math.ceil(record.inputBytes/16));
      assert.equal(record.transformCalls,record.writeCalls);
      assert.ok(record.yieldCalls>0,'turn suppression must not erase actual codec calls');
      assert.equal(record.yieldMessages+record.yieldTimers,
        taskYieldPolicy==='caller-owned'?0:Math.floor(record.yieldCalls/64));
      assert.equal(record.yieldTimers,0,'native channel turns must not schedule nested timers');
      assert.ok(record.peakQueuedBytes<=2*512*273*(16+64+1)+524288);
      for(const [key,value] of Object.entries(record)) {
        if(key.endsWith('Ms')) assert.ok(Number.isFinite(value)&&value>=0,key);
      }
    }
  } finally {schedulingOperation.finish();}
  assert.equal(channels,taskYieldPolicy==='caller-owned'?0:2,
    'only cooperative operations create lazy task channels');
  assert.equal(closedPorts,2*channels,'finish releases both ports exactly once');
  console.log(JSON.stringify({total,peak,maximumCurrent,waitRetained,outputRetained,timings}));
} finally {
  operation.finish();delete globalThis.retainedRangeOperation;
  globalThis.TransformStream=Native;globalThis.MessageChannel=NativeChannel;globalThis.setTimeout=nativeTimeout;
}
`;
  const result = spawnSync(process.execPath, ["--expose-gc", "--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 120000,
  });
  assert.equal(result.status, 0, [result.stderr, result.stdout, String(result.error)].join("\n"));
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.total, size);
  assert.ok(measured.waitRetained <= 2 * 16384);
  assert.ok(measured.outputRetained <= 2 * 524288 + measured.maximumCurrent);
  assert.equal(measured.timings.length, 2);
  // Preserve bounded partial records on a child timeout, and expose completed
  // aggregates through the existing test output without creating a trace file.
  console.log(result.stderr);
});
}
