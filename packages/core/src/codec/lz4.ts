// Ported from AssetStudio/LZ4/LZ4.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError } from "../errors.js";

/**
 * Shortest match the format can encode; the stored match length is biased by it
 * so that a 4-byte match fits in the token's low nibble as 0.
 */
const MIN_MATCH = 4;

/** A nibble of 15 means "keep adding bytes until one of them is below 255". */
const NIBBLE_MAX = 0xf;

/**
 * Decompress one LZ4 block into a buffer of exactly `uncompressedSize` bytes.
 *
 * This is the raw block format, not the LZ4 frame format: there is no magic
 * number and no stored output size, which is why Unity keeps the size in the
 * bundle header and passes it in here. LZ4HC only changes how the *compressor*
 * searches for matches, so HC blocks decode through this same function - there
 * is no separate HC path (plan §1).
 *
 * @param src compressed block, read but never retained
 * @param uncompressedSize size the block is expected to expand to, from the caller's header
 * @returns a new `Uint8Array` of exactly `uncompressedSize` bytes
 * @throws {CorruptError} when the block is truncated, references data before
 * the start of the output, or does not expand to `uncompressedSize`
 */
export function decompressLz4(src: Uint8Array, uncompressedSize: number): Uint8Array {
  // A size out of this range comes from a corrupt header, so it has to leave as
  // a CorruptError rather than as the RangeError the allocation would throw:
  // R9 is what lets a caller tell a broken file from a broken caller. The
  // bundle-header guard for sizes above 2^53 still belongs to the header reader
  // (D9/R6); this only keeps the codec from leaking a different error type.
  if (!Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0) {
    throw new CorruptError(`LZ4 uncompressed size ${uncompressedSize} is not a byte count`);
  }

  const dst = new Uint8Array(uncompressedSize);
  let srcPos = 0;
  let dstPos = 0;

  /** Next input byte, or a throw: past the end means the block was cut short. */
  const nextByte = (): number => {
    const byte = src[srcPos++];
    if (byte === undefined) {
      throw new CorruptError(`LZ4 block ends after ${src.length} bytes, mid-sequence`);
    }
    return byte;
  };

  /** An output overrun means the caller's `uncompressedSize` and the block disagree. */
  const overflow = (what: string, count: number): CorruptError =>
    new CorruptError(
      `LZ4 ${what} of ${count} bytes at ${dstPos} overflows the ${uncompressedSize}-byte output`,
    );

  /** Grow a 4-bit length by its 255-terminated continuation bytes. */
  const extendLength = (length: number): number => {
    if (length === NIBBLE_MAX) {
      let part: number;
      do {
        part = nextByte();
        length += part;
      } while (part === 0xff);
    }
    return length;
  };

  while (srcPos < src.length) {
    const token = nextByte();

    const litCount = extendLength(token >> 4);
    if (srcPos + litCount > src.length) {
      throw new CorruptError(
        `LZ4 literal run of ${litCount} bytes at ${srcPos} exceeds the ${src.length}-byte block`,
      );
    }
    if (dstPos + litCount > dst.length) throw overflow("literal run", litCount);
    dst.set(src.subarray(srcPos, srcPos + litCount), dstPos);
    srcPos += litCount;
    dstPos += litCount;

    // The last sequence of a block is literals only: no offset, no match.
    if (srcPos >= src.length) break;

    const low = nextByte();
    const high = nextByte();
    const offset = low | (high << 8);
    const matchCount = extendLength(token & NIBBLE_MAX) + MIN_MATCH;

    if (offset === 0 || offset > dstPos) {
      throw new CorruptError(
        `LZ4 match offset ${offset} reaches outside the ${dstPos} bytes decoded so far`,
      );
    }
    if (dstPos + matchCount > dst.length) throw overflow("match", matchCount);

    let matchPos = dstPos - offset;
    if (matchCount <= offset) {
      dst.set(dst.subarray(matchPos, matchPos + matchCount), dstPos);
      dstPos += matchCount;
    } else {
      // Overlapping match (offset < length): the copy reads bytes it is writing
      // as it goes, which is how LZ4 encodes runs. A block move would repeat the
      // pre-existing bytes instead of the growing pattern, so copy byte by byte.
      for (let i = 0; i < matchCount; i++) {
        dst[dstPos++] = dst[matchPos++] as number;
      }
    }
  }

  if (dstPos !== uncompressedSize) {
    // Wording kept from AssetStudio's BundleFile.cs so the two can be diffed.
    throw new CorruptError(
      `LZ4 decompression error, write ${dstPos} bytes but expected ${uncompressedSize} bytes`,
    );
  }
  return dst;
}

/**
 * Internal selected-range decoder: a 64 KiB history ring and 64 KiB output,
 * independent of the declared block size. LZ4HC has the same token grammar.
 * Await every flush so long overlapping matches remain cancellable and bounded.
 */
export async function streamLz4(
  read: import("../bundle/rangeIO.js").CompressedRead,
  compressedSize: number,
  uncompressedSize: number,
  consume: import("../bundle/rangeIO.js").DecodedConsumer,
  operation: import("../bundle/rangeIO.js").RangeOperation,
): Promise<void> {
  operation.check();
  if (!Number.isSafeInteger(compressedSize) || compressedSize < 0 ||
      !Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0) {
    throw new CorruptError("LZ4 range sizes must be safe nonnegative byte counts");
  }
  const history = new Uint8Array(65536);
  let output = new Uint8Array(65536);
  let used = 0;
  let written = 0;
  let position = 0;
  let input: Uint8Array = new Uint8Array(0);
  let inputPos = 0;
  const byte = async (): Promise<number> => {
    if (position >= compressedSize) throw new CorruptError("LZ4 block ends mid-sequence");
    if (inputPos === input.length) {
      const size = Math.min(65536, compressedSize - position);
      input = await operation.wait(read(position, size));
      if (input.length !== size) throw new CorruptError("LZ4 input acquisition returned a short block");
      inputPos = 0;
    }
    position++;
    return input[inputPos++]!;
  };
  const length = async (n: number): Promise<number> => {
    if (n === NIBBLE_MAX) {
      let part: number;
      do {
        part = await byte();
        n += part;
        // A malformed length must fail before an enormous loop or allocation.
        if (n > uncompressedSize) throw new CorruptError("LZ4 length exceeds declared output");
      } while (part === 255);
    }
    return n;
  };
  const flush = async (): Promise<void> => {
    if (used === 0) return;
    await operation.wait(consume(output.subarray(0, used)));
    output = new Uint8Array(65536);
    used = 0;
    await operation.yield();
  };
  const put = (value: number): void => {
    history[written & 65535] = value;
    output[used++] = value;
    written++;
  };
  while (position < compressedSize) {
    const token = await byte();
    const literals = await length(token >>> 4);
    if (position + literals > compressedSize || written + literals > uncompressedSize) {
      throw new CorruptError("LZ4 literal run exceeds declared input/output");
    }
    for (let i = 0; i < literals; i++) {
      put(await byte());
      if (used === output.length) await flush();
    }
    if (position === compressedSize) break;
    const low = await byte();
    const distance = low | ((await byte()) << 8);
    const matches = (await length(token & 15)) + MIN_MATCH;
    if (distance === 0 || distance > written || written + matches > uncompressedSize) {
      throw new CorruptError(`LZ4 invalid match offset ${distance} or length ${matches} at ${written}`);
    }
    // Read/write the ring sequentially: offset-one runs and wraparound overlap
    // must see bytes just written, rather than a copied pre-match snapshot.
    for (let i = 0; i < matches; i++) {
      put(history[(written - distance) & 65535]!);
      if (used === output.length) await flush();
    }
  }
  if (written !== uncompressedSize) {
    throw new CorruptError(`LZ4 wrote ${written} bytes but expected ${uncompressedSize}`);
  }
  await flush();
}
