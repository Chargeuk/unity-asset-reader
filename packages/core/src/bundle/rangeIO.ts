import { CorruptError } from "../errors.js";

/** Structural AbortSignal members; no DOM library is required by core. */
export interface RangeAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** A Blob/File with only the bounded acquisition members the UnityFS path uses. */
export interface SliceableBlob {
  readonly size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

// All target runtimes supply timers; only this structural member is used.
declare function setTimeout(callback: () => void, delay: number): unknown;

// Locally typed WHATWG ports keep DOM/Node declarations out of core's API.
interface TaskPort {
  onmessage: (() => void) | null;
  postMessage(value: null): void;
  close(): void;
}
declare const MessageChannel: {
  new (): { port1: TaskPort; port2: TaskPort };
};

/** Internal per-read cancellation and macrotask ownership, also used by codecs. */
export class RangeOperation {
  // Keep only live waiters. Racing every read/write against one never-settled
  // promise retains a reaction (and possibly its output) for the whole operation.
  private readonly pending = new Set<(reason: unknown) => void>();
  private failure: unknown;
  private cancelled = false;
  private ticks = 0;
  private taskChannel: { port1: TaskPort; port2: TaskPort } | undefined;
  private readonly turns: Array<() => void> = [];
  private readonly onAbort = (): void => this.cancel(this.signal?.reason);

  constructor(private readonly signal?: RangeAbortSignal) {
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  check(): void {
    if (this.cancelled) throw this.failure;
  }

  cancel(reason?: unknown): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.failure = reason === undefined
      ? Object.assign(new Error("UnityFS range read cancelled"), { name: "AbortError" })
      : reason;
    for (const reject of this.pending) reject(this.failure);
    this.pending.clear();
    this.closeTaskChannel();
  }

  wait<T>(value: PromiseLike<T> | T): Promise<T> {
    const observed = Promise.resolve(value);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const complete = (): boolean => {
        if (settled) return false;
        settled = true;
        this.pending.delete(cancel);
        return true;
      };
      const cancel = (reason: unknown): void => {
        if (complete()) reject(reason);
      };
      // Observe eager read/write promises even after cancellation. Checking
      // first would orphan their rejection; returning the abort reason does
      // not remove our responsibility for work already started by the caller.
      observed.then((result) => {
        if (!complete()) return;
        if (this.cancelled) reject(this.failure);
        else resolve(result);
      }, (error: unknown) => {
        if (complete()) reject(this.cancelled ? this.failure : error);
      });
      if (this.cancelled) cancel(this.failure);
      else this.pending.add(cancel);
    });
  }

  async yield(): Promise<void> {
    this.check();
    // Keep a real task turn every 64 shared producer/consumer calls: promise-only
    // chains starve abort messages. Nested timers imposed ~4 ms per turn in the
    // retained Epi trace. A port task has no timer-nesting floor and carries no
    // source bytes; cadence, codec writes and awaited backpressure stay unchanged.
    if (++this.ticks % 64 === 0) {
      await this.wait(new Promise<void>((resolve) => {
        if (typeof MessageChannel === "undefined") {
          setTimeout(resolve, 0);
          return;
        }
        if (!this.taskChannel) {
          this.taskChannel = new MessageChannel();
          this.taskChannel.port1.onmessage = () => { this.turns.shift()?.(); };
        }
        // Producer and consumer can both await turns. Each posted task owns its
        // resolver; overwriting a single callback would strand the other waiter.
        this.turns.push(resolve);
        this.taskChannel.port2.postMessage(null);
      }));
    }
  }

  private closeTaskChannel(): void {
    if (!this.taskChannel) return;
    this.taskChannel.port1.onmessage = null;
    this.taskChannel.port1.close();
    this.taskChannel.port2.close();
    this.taskChannel = undefined;
    // Settle underlying void promises too. wait() has already rejected cancelled
    // owners, so releasing queued tasks cannot resume their cancelled consumers.
    for (const resolve of this.turns.splice(0)) resolve();
  }

  finish(): void {
    this.signal?.removeEventListener("abort", this.onAbort);
    this.closeTaskChannel();
  }
}

/** Internal bounded source read, never a decoded-bundle abstraction. */
export async function readSource(
  source: Uint8Array | SliceableBlob,
  offset: number,
  size: number,
  operation: RangeOperation,
): Promise<Uint8Array> {
  operation.check();
  const length = source instanceof Uint8Array ? source.length : source.size;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 ||
      size < 0 || offset > length - size) {
    throw new CorruptError(`UnityFS source range ${offset} + ${size} exceeds ${length}`);
  }
  await operation.yield();
  operation.check();
  if (source instanceof Uint8Array) return source.subarray(offset, offset + size);
  const bytes = new Uint8Array(await operation.wait(source.slice(offset, offset + size).arrayBuffer()));
  if (bytes.length !== size) {
    throw new CorruptError(`UnityFS source at ${offset} returned ${bytes.length}, expected ${size}`);
  }
  return bytes;
}

/** Internal codec input and awaited output contracts. */
export type CompressedRead = (offset: number, size: number) => Promise<Uint8Array>;
export type DecodedConsumer = (bytes: Uint8Array) => Promise<void>;
