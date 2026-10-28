import { streamLz4 } from "../codec/lz4.js";
import { streamLzma } from "../codec/lzma.js";
import { CorruptError, UnsupportedError } from "../errors.js";
import { BinaryReader } from "../io/BinaryReader.js";
import {
  readSerializedFile,
  readSerializedFileHeader,
  type SerializedFile,
} from "../serialized/SerializedFile.js";
import {
  parseUnityFSInfo,
  readUnityFSHeader,
  unityFSInfoLocation,
  type BundleHeader,
} from "./BundleFile.js";
import {
  RangeOperation,
  readSource,
  type RangeAbortSignal,
  type SliceableBlob,
} from "./rangeIO.js";

/** An immutable directory entry. Identity belongs to the reader that returned it. */
export interface BundleEntry {
  readonly path: string;
  readonly flags: number;
  /** Absolute position in the decoded block stream, used to order batches. */
  readonly offset: number;
  readonly size: number;
}

/** A selected span within one directory entry, in file-relative bytes. */
export interface BundleRange {
  readonly entry: BundleEntry;
  readonly offset: number;
  readonly length: number;
}

/**
 * Awaited selected-byte consumer. Chunks are owned, at most 64 KiB, and offset
 * is relative to the requested range. Retention after the callback belongs to
 * the caller; the reader retains no selected output after consumption.
 */
export type BundleRangeConsumer = (
  range: BundleRange, bytes: Uint8Array, offset: number,
) => void | Promise<void>;

/** Selected UnityFS acquisition. Parsing of the resulting bytes stays synchronous. */
export interface BundleRangeReader {
  readonly header: Readonly<BundleHeader>;
  readonly entries: readonly BundleEntry[];
  /**
   * Consume nonoverlapping spans in uncompressed bundle order. Each intersecting
   * block is decoded once per batch, including gaps between selected spans.
   * Nothing is published from a different or forged entry. A failed batch may
   * already have delivered earlier chunks; callers own that provisional state.
   */
  readRanges(ranges: readonly BundleRange[], consume: BundleRangeConsumer,
    signal?: RangeAbortSignal): Promise<void>;
  /** Read one owned span, up to 64 MiB. Larger spans use readRanges's bounded chunks. */
  readRange(range: BundleRange, signal?: RangeAbortSignal): Promise<Uint8Array>;
  /**
   * Two batched acquisition phases (fixed headers, then metadata prefixes), not
   * a block rescan per file. Validates full directory/file/object extents before
   * exposing metadata. Format <9 has trailing metadata and is not supported here.
   */
  readMetadata(entries: readonly BundleEntry[],
    consume: (entry: BundleEntry, file: SerializedFile) => void | Promise<void>,
    signal?: RangeAbortSignal): Promise<void>;
  /** Cancel the active read and release the compressed source reference. Idempotent. */
  close(): void;
}

const MAX_OWNED_BYTES = 64 * 1024 * 1024;

function bounded(size: number, what: string): void {
  if (size > MAX_OWNED_BYTES) {
    throw new UnsupportedError(what, size, "owned allocation limit 64 MiB; consume selected chunks");
  }
}

/**
 * Open a UnityFS directory without inflating its payload. Reads only a bounded
 * header and blocks-info; subsequent batches decode intersecting payload blocks
 * through windowed LZ4 or the public raw LZMA1 stream. Does not alter load()/Env.
 * The compressed source must remain unchanged until close(); its lifetime is
 * caller-owned. Blocks-info and metadata allocations are separately bounded
 * at 64 MiB, independent of the total decoded payload size.
 *
 * @throws CorruptError for unsafe sizes, directory/block bounds, truncated data
 * @throws UnsupportedError for legacy containers, encryption or unsupported codecs
 */
export async function openBundleRange(
  input: Uint8Array | SliceableBlob,
  signal?: RangeAbortSignal,
): Promise<BundleRangeReader> {
  let source: Uint8Array | SliceableBlob | undefined = input;
  // Do not keep an additional parameter reference after close().
  input = new Uint8Array(0);
  const operation = new RangeOperation(signal);
  let active: RangeOperation | undefined;
  try {
    const size = source instanceof Uint8Array ? source.length : source.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new CorruptError("Invalid UnityFS source size");
    // BinaryReader caps both revision strings at 32767 and the signature at 20.
    // This therefore contains every header that the contiguous parser accepts.
    const prefix = await readSource(source, 0, Math.min(size, 2 * 32767 + 64), operation);
    const reader = new BinaryReader(prefix, "big");
    const header = Object.freeze(readUnityFSHeader(reader));
    if (header.size !== size) {
      throw new CorruptError(`UnityFS declares ${header.size} bytes, source has ${size}`);
    }
    bounded(header.compressedBlocksInfoSize, "compressed blocks info size");
    bounded(header.uncompressedBlocksInfoSize, "blocks info size");
    const location = unityFSInfoLocation(header, reader.position, size);
    const info = await readSource(source, location.infoStart,
      header.compressedBlocksInfoSize, operation);
    let layout: ReturnType<typeof parseUnityFSInfo>;
    try {
      layout = parseUnityFSInfo(header, info);
    } catch (cause) {
      if (location.ambiguousPadding && cause instanceof CorruptError) {
        throw Object.assign(new UnsupportedError("archive flag", "0x200",
          `revision names no editor; padded blocks info failed: ${cause.message}`), { cause });
      }
      throw cause;
    }
    let compressed = location.dataStart;
    let decoded = 0;
    const blocks = layout.blocks.map((block, index) => {
      const nextCompressed = compressed + block.compressedSize;
      const nextDecoded = decoded + block.uncompressedSize;
      if (!Number.isSafeInteger(nextCompressed) || !Number.isSafeInteger(nextDecoded) ||
          nextCompressed > location.dataEnd) {
        throw new CorruptError(`UnityFS block ${index} exceeds source or safe decoded extent`);
      }
      const result = { ...block, compressed, decoded, index };
      compressed = nextCompressed;
      decoded = nextDecoded;
      return result;
    });
    // Reuse the contiguous parser's stripped-revision 0x200 ambiguity rule:
    // accepting padding must account for every payload byte, not an old key block.
    if (location.ambiguousPadding && compressed !== location.dataEnd) {
      throw new UnsupportedError("archive flag", "0x200",
        "revision names no editor and blocks do not exactly fit the padded layout");
    }
    const starts = new Map<BundleEntry, number>();
    const entries = Object.freeze(layout.nodes.map((node) => {
      if (!Number.isSafeInteger(node.offset + node.size) || node.offset + node.size > decoded) {
        throw new CorruptError(`UnityFS node ${node.path} exceeds ${decoded} decoded bytes`);
      }
      const entry = Object.freeze({ path: node.path, flags: node.flags, offset: node.offset, size: node.size });
      starts.set(entry, node.offset);
      return entry;
    }));

    const selected = (range: BundleRange): { start: number; end: number } => {
      const base = starts.get(range.entry);
      if (base === undefined) throw new CorruptError("UnityFS range entry belongs to another reader");
      if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) ||
          range.offset < 0 || range.length < 0 || range.offset > range.entry.size - range.length) {
        throw new CorruptError(`UnityFS ${range.entry.path}: invalid range ${range.offset}+${range.length}`);
      }
      return { start: base + range.offset, end: base + range.offset + range.length };
    };

    const api: BundleRangeReader = {
      header,
      entries,
      async readRanges(ranges, consume, abortSignal) {
        if (!source) throw new Error("UnityFS range reader is closed");
        if (active) throw new Error("UnityFS range reader already has an active batch");
        // Snapshot caller-owned descriptors before the first await. The callback
        // receives that stable selection, even if the caller mutates its array.
        const spans = ranges.map((range) => {
          const stable = Object.freeze({ ...range });
          return { range: stable, ...selected(stable) };
        });
        let previous = -1;
        for (const span of spans) {
          if (span.start < previous) {
            throw new CorruptError("UnityFS batch ranges must be ordered and nonoverlapping");
          }
          previous = span.end;
        }
        const op = new RangeOperation(abortSignal);
        active = op;
        try {
          op.check();
          for (const block of blocks) {
            const intersections = spans.filter((span) =>
              span.start < block.decoded + block.uncompressedSize && span.end > block.decoded);
            if (intersections.length === 0) continue;
            let position = block.decoded;
            const output = async (bytes: Uint8Array): Promise<void> => {
              for (const span of intersections) {
                const from = Math.max(position, span.start);
                const end = Math.min(position + bytes.length, span.end);
                for (let offset = from; offset < end; offset += 65536) {
                  const stop = Math.min(offset + 65536, end);
                  // Never leak a view that pins a decoder dictionary or burst.
                  op.check();
                  const owned = new Uint8Array(stop - offset);
                  owned.set(bytes.subarray(offset - position, stop - position));
                  await op.wait(consume(span.range, owned, offset - span.start));
                  await op.yield();
                }
              }
              position += bytes.length;
            };
            const read = (offset: number, length: number): Promise<Uint8Array> => {
              if (offset < 0 || length < 0 || offset > block.compressedSize - length) {
                throw new CorruptError(`UnityFS block ${block.index}: compressed range exceeds block`);
              }
              if (!source) throw new Error("UnityFS range reader is closed");
              return readSource(source, block.compressed + offset, length, op);
            };
            const type = block.flags & 63;
            try {
              if (type === 0) {
                if (block.compressedSize !== block.uncompressedSize) {
                  throw new CorruptError("stored block compressed/uncompressed sizes differ");
                }
                // Stored payloads need no history: acquire just the selected
                // spans rather than scanning a potentially very large block.
                for (const span of intersections) {
                  const end = Math.min(span.end, block.decoded + block.uncompressedSize);
                  for (let offset = Math.max(span.start, block.decoded); offset < end; offset += 65536) {
                    const bytes = await read(offset - block.decoded, Math.min(65536, end - offset));
                    // Typed-array subclasses can make slice() return a view.
                    const owned = new Uint8Array(bytes.length);
                    owned.set(bytes);
                    await op.wait(consume(span.range, owned, offset - span.start));
                    await op.yield();
                  }
                }
              } else if (type === 2 || type === 3) {
                await streamLz4(read, block.compressedSize, block.uncompressedSize, output, op);
              } else if (type === 1) {
                if (block.compressedSize < 5) throw new CorruptError("LZMA block has no properties");
                const props = await read(0, 5);
                await streamLzma(props, (offset, length) => read(offset + 5, length),
                  block.compressedSize - 5, block.uncompressedSize, output, op);
              } else {
                throw new UnsupportedError("compression type", type);
              }
            } catch (cause) {
              // Abort reasons belong to the caller and may even be frozen.
              // Other failures gain context through a cause chain, never by
              // mutating somebody else's error or losing its classification.
              if (abortSignal?.aborted || !source) throw cause;
              const context = `UnityFS block ${block.index} at ${block.compressed}`;
              const reason = cause instanceof Error ? cause.message : String(cause);
              if (cause instanceof CorruptError) {
                throw Object.assign(new CorruptError(`${context}: ${reason}`), { cause });
              }
              if (cause instanceof UnsupportedError) {
                throw Object.assign(new UnsupportedError(cause.kind, cause.found,
                  `${context}: ${reason}`), { cause });
              }
              throw Object.assign(new Error(`${context}: ${reason}`), { cause });
            }
          }
          op.check();
        } finally {
          op.finish();
          active = undefined;
        }
      },
      async readRange(range, abortSignal) {
        if (!source) throw new Error("UnityFS range reader is closed");
        if (active) throw new Error("UnityFS range reader already has an active batch");
        const check = new RangeOperation(abortSignal);
        try { check.check(); } finally { check.finish(); }
        selected(range);
        bounded(range.length, "selected range size");
        const bytes = new Uint8Array(range.length);
        await api.readRanges([range], (_span, chunk, offset) => { bytes.set(chunk, offset); }, abortSignal);
        return bytes;
      },
      async readMetadata(files, consume, abortSignal) {
        const unique = new Set(files);
        if (unique.size !== files.length) throw new CorruptError("duplicate metadata entry in batch");
        const ordered = [...files].sort((a, b) => selected({ entry: a, offset: 0, length: 0 }).start -
          selected({ entry: b, offset: 0, length: 0 }).start);
        const headers = new Map<BundleEntry, Uint8Array>();
        await api.readRanges(ordered.map((entry) => ({ entry, offset: 0, length: Math.min(48, entry.size) })),
          (range, chunk, offset) => {
            if (offset === 0) headers.set(range.entry, new Uint8Array(range.length));
            headers.get(range.entry)!.set(chunk, offset);
          }, abortSignal);
        const prefixes = ordered.map((entry) => {
          const fileHeader = readSerializedFileHeader(headers.get(entry) ?? new Uint8Array(0));
          if (fileHeader.version < 9) {
            throw new UnsupportedError("range SerializedFile format", fileHeader.version,
              "prefix acquisition requires format >=9");
          }
          const length = (fileHeader.version >= 22 ? 48 : 20) + fileHeader.metadataSize;
          if (fileHeader.fileSize !== entry.size || length > fileHeader.dataOffset ||
              fileHeader.dataOffset > entry.size) {
            throw new CorruptError(`UnityFS ${entry.path}: metadata/file extent disagrees with directory`);
          }
          bounded(length, "SerializedFile metadata size");
          return { entry, offset: 0, length };
        });
        headers.clear();
        // Only one metadata prefix is assembled at once. A batch never retains
        // all selected files, and no object-body bytes are retained with metadata.
        let bytes: Uint8Array | undefined;
        await api.readRanges(prefixes, async (range, chunk, offset) => {
          if (offset === 0) bytes = new Uint8Array(range.length);
          bytes!.set(chunk, offset);
          if (offset + chunk.length === range.length) {
            const file = readSerializedFile(bytes!, range.entry.size);
            bytes = undefined;
            await consume(range.entry, file);
          }
        }, abortSignal);
      },
      close() {
        active?.cancel();
        source = undefined;
      },
    };
    return api;
  } finally {
    operation.finish();
  }
}
