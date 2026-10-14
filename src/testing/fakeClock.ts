import type { FrameClock } from '../runtime/frameClock';

/** 60 Hz frame interval, ms. */
export const FRAME = 16.667;

/**
 * Frame clock driven by the test. `step(dt)` moves time by one frame and runs the pending callbacks with the new
 * timestamp. Input scheduled with `input(ts, fn)` is delivered just before the first frame with timestamp ≥ ts,
 * the way the browser dispatches input before rAF callbacks.
 */
export class FakeClock implements FrameClock {
  now = 0;
  /** Simulates a callback that still fires after cancel(). */
  ignoreCancel = false;
  /** Timestamps of the frames that ran at least one callback. */
  readonly frames: number[] = [];
  /** Frame interval of `step()` without an argument, and so of `runOut()`. */
  readonly frameMs: number;
  private nextId = 1;
  private readonly pending = new Map<number, (ts: number) => void>();
  private inputs: { ts: number; fn: () => void }[] = [];

  constructor(frameMs = FRAME) {
    this.frameMs = frameMs;
  }

  request(cb: (ts: number) => void): number {
    const id = this.nextId++;
    this.pending.set(id, cb);
    return id;
  }

  cancel(id: number): void {
    if (!this.ignoreCancel) this.pending.delete(id);
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  input(ts: number, fn: () => void): void {
    this.inputs.push({ ts, fn });
  }

  step(dt = this.frameMs): void {
    this.stepTo(this.now + dt);
  }

  /** One frame at exactly `ts`. */
  stepTo(ts: number): void {
    const due = this.inputs.filter((e) => e.ts <= ts).sort((a, b) => a.ts - b.ts);
    this.inputs = this.inputs.filter((e) => e.ts > ts);
    for (const e of due) e.fn();
    this.now = ts;
    const cbs = [...this.pending.values()];
    this.pending.clear();
    if (cbs.length > 0) this.frames.push(ts);
    for (const cb of cbs) cb(ts);
  }

  /** Steps until no callback is pending (the runner finished). */
  runOut(maxFrames = 100_000): void {
    for (let i = 0; i < maxFrames && this.hasPending; i++) this.step();
    if (this.hasPending) throw new Error('FakeClock.runOut: runner did not finish');
  }

  /** First frame that ran with timestamp ≥ t. */
  firstFrameAtOrAfter(t: number): number {
    const f = this.frames.find((ts) => ts >= t);
    if (f === undefined) throw new Error(`no frame at or after ${String(t)}`);
    return f;
  }
}
