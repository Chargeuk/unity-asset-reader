// Ported from AssetStudio/SevenZipHelper.cs (MIT, © Perfare / RazTools / Razviar)

/**
 * LZMA (LZMA1, the `.lzma`/"alone" container) as Unity writes it.
 *
 * Unity stores LZMA in two shapes and this module decodes both through one
 * entry point, because the only difference is where the uncompressed size comes
 * from - the bit stream after it is identical:
 *
 * - **UnityFS block / blocks-info:** 5 property bytes + the raw bit stream. The
 *   size lives in the archive header, so the caller passes it in.
 * - **Legacy UnityWeb / UnityRaw:** 5 property bytes + a little-endian u64 size
 *   + the bit stream. The caller splits that 13-byte prefix itself and passes
 *   the three parts, exactly as `SevenZipHelper.StreamDecompress` does.
 *
 * Why `lzma1` and not an emscripten `LzmaDec.c`: the #13 spike measured
 * ~10 MB/s against a 20 MB/s bar, and the bar was retired rather than met - a
 * WASM decoder would put WASM in `packages/core`, which plan §2 forbids, and
 * would force an `await initialize()` before `load()`. Revisit through #69 if
 * real bundles make this hurt, not before.
 */

import { decompressRawLzma1, DecompressRawLzma1, MemoryLimitError } from "lzma1";

import { CorruptError, UnsupportedError } from "../errors.js";

/** Property bytes: the packed `lc`/`lp`/`pb` byte, then a u32 dictionary size. */
const PROPS_SIZE = 5;

/**
 * Largest valid packed properties byte: `(pb 4 * 5 + lp 4) * 9 + lc 8`. Above
 * this the byte does not decode to a legal `lc`/`lp`/`pb` triple at all.
 */
const MAX_PROPS_BYTE = 224;

/**
 * Decompress one LZMA1 bit stream into exactly `uncompressedSize` bytes.
 *
 * @param props5 the 5 LZMA property bytes, as they sit in the bundle
 * @param data the bit stream that follows them, without any size prefix
 * @param uncompressedSize size the stream must expand to, from the caller's header
 * @returns a new `Uint8Array` of exactly `uncompressedSize` bytes
 * @throws {CorruptError} when the properties are not a legal LZMA triple, the
 *   stream is malformed or truncated, or it does not expand to exactly
 *   `uncompressedSize` bytes
 */
export function lzmaDecompress(
  props5: Uint8Array,
  data: Uint8Array,
  uncompressedSize: number,
): Uint8Array {
  // Same reasoning as the LZ4 decoder: a size out of range comes from a corrupt
  // header and has to leave as a CorruptError, not as an allocator RangeError,
  // so callers can still tell a broken file from a broken caller (R9).
  if (!Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0) {
    throw new CorruptError(`LZMA uncompressed size ${uncompressedSize} is not a byte count`);
  }
  if (props5.length !== PROPS_SIZE) {
    throw new CorruptError(
      `LZMA properties are ${props5.length} bytes, expected ${PROPS_SIZE}`,
    );
  }

  const packed = props5[0] as number;
  if (packed > MAX_PROPS_BYTE) {
    throw new CorruptError(
      `LZMA properties byte ${hex8(packed)} is above the largest legal value ` +
        `${hex8(MAX_PROPS_BYTE)} (lc 8, lp 4, pb 4)`,
    );
  }

  // The public raw API avoids a second compressed-stream copy. A resource
  // limit also applies to malicious dictionary/probability declarations before
  // the one-shot decoder allocates them; legacy output allocation stays sync.
  const rest = Math.floor(packed / 9);
  const options = {
    lc: packed % 9, lp: rest % 5, pb: Math.floor(rest / 5),
    dictSize: new DataView(props5.buffer, props5.byteOffset, 5).getUint32(1, true),
    uncompressedSize, memoryLimitKb: 64 * 1024,
  };

  let out: Uint8Array;
  try {
    out = decompressRawLzma1(data, options);
  } catch (cause) {
    if (cause instanceof MemoryLimitError) {
      throw Object.assign(new UnsupportedError("LZMA decoder memory", options.dictSize,
        "dictionary/probabilities exceed the 64 MiB decoder limit"), { cause });
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw Object.assign(new CorruptError(
      `LZMA stream of ${data.length} bytes failed to decode (expected ${uncompressedSize} bytes): ${reason}`,
    ), { cause });
  }

  // Keep an exact-size check at the public synchronous boundary as well.
  if (out.length !== uncompressedSize) {
    throw new CorruptError(
      `LZMA decompression error, write ${out.length} bytes but expected ${uncompressedSize} bytes`,
    );
  }
  return out;
}

function hex8(value: number): string {
  return `0x${value.toString(16).padStart(2, "0")}`;
}

// Locally typed stream members keep DOM types out of the public declarations.
interface RawStream {
  readable: { getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  } };
  writable: { getWriter(): {
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
    releaseLock(): void;
  } };
}

/**
 * Internal UnityFS raw LZMA1 stream, using only lzma1's public root API.
 *
 * Queue bound, from lzma1 0.6.1 range-decoder/range-coder/lzma-coder:
 * probabilities remain in [31,2017]/2048 and normalisation uses 8 bits.
 * A bit decision shrinks the range by at least 1/67, so 512 decisions
 * consume at least one byte ((66/67)^512 < 1/256). A symbol emits at most
 * 273 bytes. With 16-byte writes and AloneDecoder's 64 pending input bytes,
 * a synchronous write can emit at most 512*273*(16+64+1) = 11,321,856 bytes.
 * end() has at most 64 pending bytes: its bound is smaller. This includes
 * output emitted without an in-write desiredSize check. Only one write is
 * pending; subsequent writes wait for readable demand. close() may flush its
 * 64-byte pending tail while the last write's output is still queued, so the
 * budget includes TWO bursts, as well as the current consumer's copied chunk.
 * Dictionary growth temporarily owns old+new rings (<2*dict); budget another
 * 2*dict for flush/current views and copies. Probabilities cost
 * 1536*2^(lc+lp)+10KiB. Input staging and selected output each cost 64 KiB;
 * pending+concatenated compressed data cost at most 2*(64+16) bytes.
 * Refuse properties whose conservative transient bound exceeds 64 MiB;
 * this is a decoder-resource bound, never a decoded-file-size cutoff.
 */
export async function streamLzma(
  props: Uint8Array,
  read: import("../bundle/rangeIO.js").CompressedRead,
  compressedSize: number,
  uncompressedSize: number,
  consume: import("../bundle/rangeIO.js").DecodedConsumer,
  operation: import("../bundle/rangeIO.js").RangeOperation,
): Promise<void> {
  operation.check();
  if (!Number.isSafeInteger(compressedSize) || compressedSize < 0 ||
      !Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0) {
    throw new CorruptError("LZMA range sizes must be safe nonnegative byte counts");
  }
  if (props.length !== 5 || props[0]! > MAX_PROPS_BYTE) {
    throw new CorruptError("LZMA range block has invalid five-byte properties");
  }
  const lc = props[0]! % 9;
  const rest = Math.floor(props[0]! / 9);
  const lp = rest % 5;
  const pb = Math.floor(rest / 5);
  const dictSize = new DataView(props.buffer, props.byteOffset, 5).getUint32(1, true);
  const dictionary = Math.max(4096, dictSize);
  const probabilities = 10240 + 1536 * 2 ** (lc + lp);
  const burst = 512 * 273 * (16 + 64 + 1);
  const transient = 4 * dictionary + probabilities + 2 * burst + 2 * 65536 + 2 * 80 + 5;
  if (transient > 64 * 1024 * 1024) {
    throw new UnsupportedError("LZMA decoder memory", transient,
      `properties lc${lc}/lp${lp}/pb${pb}, dictionary ${dictSize}; transient limit 64 MiB`);
  }
  // The dependency's declaration inherits platform TransformStream types.
  // Narrow the constructor locally instead of exporting those types from core.
  const Raw = DecompressRawLzma1 as unknown as new (options: {
    lc: number; lp: number; pb: number; dictSize: number;
    uncompressedSize: number; memoryLimitKb: number;
  }) => RawStream;
  const stream = new Raw({ lc, lp, pb, dictSize, uncompressedSize,
    memoryLimitKb: Math.ceil((dictionary + probabilities) / 1024) + 16 });
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  let written = 0;
  // Attach a rejection handler immediately. A read or consumer failure can
  // otherwise leave an orphaned writer while the readable side is backpressured.
  const failed = (cause: unknown): never => {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw Object.assign(new CorruptError(`LZMA range stream failed: ${reason}`), { cause });
  };
  const producer = (async (): Promise<void> => {
    for (let start = 0; start < compressedSize; start += 65536) {
      const size = Math.min(65536, compressedSize - start);
      const input = await operation.wait(read(start, size));
      if (input.length !== size) throw new CorruptError("LZMA input acquisition returned a short block");
      for (let offset = 0; offset < input.length; offset += 16) {
        await operation.wait(writer.write(input.subarray(offset, offset + 16)).catch(failed));
        await operation.yield();
      }
    }
    await operation.wait(writer.close().catch(failed));
  })();
  void producer.catch((cause: unknown) => { operation.cancel(cause); });
  let failure: unknown;
  try {
    while (true) {
      const result = await operation.wait(reader.read().catch(failed));
      if (result.done) break;
      const bytes = result.value!;
      written += bytes.length;
      if (written > uncompressedSize) throw new CorruptError("LZMA range output exceeds declared size");
      await operation.wait(consume(bytes));
      await operation.yield();
    }
    await operation.wait(producer);
    if (written !== uncompressedSize) {
      throw new CorruptError(`LZMA wrote ${written} bytes but expected ${uncompressedSize}`);
    }
  } catch (cause) {
    failure = cause;
    operation.cancel(cause);
    throw cause;
  } finally {
    // cancel/abort together: waiting for abort alone can wait on readable demand.
    await Promise.allSettled([reader.cancel(failure), writer.abort(failure), producer]);
    reader.releaseLock();
    writer.releaseLock();
  }
}
