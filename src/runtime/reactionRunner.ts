import type { BlockTimeline, Press, Stimulus, TrialSpec } from '../engine/reaction/types';
import { isDroppedFrame } from '../engine/timing';
import type { FrameClock } from './frameClock';

/** Draws stimuli. `show` and `tick` are called from inside a frame callback, so the drawing lands in that frame. */
export interface StimulusRenderer {
  show(s: Stimulus): void;
  hide(): void;
  /** RDO only: time since onset, called on every frame while the stimulus is shown (0 on the onset frame). */
  tick(elapsedMs: number): void;
}

export type AbortReason = 'focus_lost' | 'user';

export type RunnerEnd = { kind: 'done'; timeline: BlockTimeline } | { kind: 'aborted'; reason: AbortReason };

/** After the last trial ends, presses are still collected for this long (late answers), then the block is done. */
export const LATE_GRACE_MS = 300;

export interface RunnerOptions {
  specs: readonly TrialSpec[];
  clock: FrameClock;
  renderer: StimulusRenderer;
  /** Measured display frame interval; a frame longer than 1.5× this is a dropped frame. */
  nominalFrameMs: number;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; i: number; onsetAt: number }
  | { kind: 'shown'; i: number; onset: number; deadline: number; answeredAt: number | null }
  | { kind: 'grace'; until: number }
  | { kind: 'finished' };

function validate(o: RunnerOptions): void {
  if (o.specs.length === 0) throw new RangeError('ReactionBlockRunner: block has no trials');
  if (!(Number.isFinite(o.nominalFrameMs) && o.nominalFrameMs > 0)) {
    throw new RangeError(`ReactionBlockRunner: nominalFrameMs must be a positive number, got ${String(o.nominalFrameMs)}`);
  }
  o.specs.forEach((s, i) => {
    if (!(Number.isFinite(s.isiMs) && s.isiMs >= 0)) {
      throw new RangeError(`ReactionBlockRunner: trial ${String(i)} isiMs must be ≥ 0, got ${String(s.isiMs)}`);
    }
    if (!(Number.isFinite(s.windowMs) && s.windowMs > 0)) {
      throw new RangeError(`ReactionBlockRunner: trial ${String(i)} windowMs must be > 0, got ${String(s.windowMs)}`);
    }
  });
}

/**
 * Plays a reaction block frame by frame and records what happened; outcomes come later from `resolveBlock`.
 *
 * - t0 is the timestamp of the first frame after `start()`. Trial i is due at (i = 0 ? t0 : end of trial i−1) + isi_i
 *   and appears in the first frame at or after that time; its onset is that frame's timestamp.
 * - An in-window press ends the trial at the press time, and the stimulus is hidden in the next frame.
 *   Otherwise the trial ends at onset + windowMs and is hidden in the first frame at or after that time.
 * - Every press while the block runs is recorded, whatever the phase. After the last trial, presses stamped up to
 *   end + LATE_GRACE_MS are still recorded; the block is done in the first frame at or after that time.
 *   Presses before `start()` or after the block ended are ignored.
 * - `abort()` stops the loop and hides the stimulus; if the renderer throws, `start()` rejects with that error.
 * - No I/O: the timeline lives in memory until `start()` resolves.
 */
export class ReactionBlockRunner {
  private readonly specs: readonly TrialSpec[];
  private readonly clock: FrameClock;
  private readonly renderer: StimulusRenderer;
  private readonly nominalFrameMs: number;

  private phase: Phase = { kind: 'idle' };
  private started = false;
  private frameId: number | null = null;
  private prevFrameTs: number | null = null;
  private readonly timeline: BlockTimeline = { onsets: [], droppedOnset: [], presses: [] };
  private result: RunnerEnd | null = null;
  private settle: { resolve: (end: RunnerEnd) => void; reject: (err: Error) => void } | null = null;

  constructor(o: RunnerOptions) {
    validate(o);
    this.specs = o.specs;
    this.clock = o.clock;
    this.renderer = o.renderer;
    this.nominalFrameMs = o.nominalFrameMs;
  }

  start(): Promise<RunnerEnd> {
    if (this.started) throw new Error('ReactionBlockRunner: start() called twice');
    this.started = true;
    if (this.result !== null) return Promise.resolve(this.result);
    this.phase = { kind: 'starting' };
    return new Promise<RunnerEnd>((resolve, reject) => {
      this.settle = { resolve, reject };
      this.frameId = this.clock.request(this.onFrame);
    });
  }

  press(p: Press): void {
    const ph = this.phase;
    if (ph.kind === 'idle' || ph.kind === 'finished') return;
    if (ph.kind === 'grace' && p.ts > ph.until) return;
    this.timeline.presses.push({ key: p.key, ts: p.ts });
    if (ph.kind === 'shown' && ph.answeredAt === null && p.ts >= ph.onset && p.ts <= ph.deadline) {
      ph.answeredAt = p.ts;
    }
  }

  abort(reason: AbortReason): void {
    if (this.phase.kind === 'finished') return;
    if (this.frameId !== null) this.clock.cancel(this.frameId);
    this.frameId = null;
    this.finish({ kind: 'aborted', reason });
    this.renderer.hide();
  }

  private readonly onFrame = (ts: number): void => {
    this.frameId = null;
    try {
      this.advance(ts);
    } catch (err) {
      this.phase = { kind: 'finished' };
      this.settle?.reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.prevFrameTs = ts;
    if (this.phase.kind !== 'finished') this.frameId = this.clock.request(this.onFrame);
  };

  /**
   * Runs every transition due at frame `ts` (more than one when an ISI of 0 follows an answered trial).
   * A frame that arrives after the runner finished does nothing.
   */
  private advance(ts: number): void {
    if (this.phase.kind === 'starting') this.phase = this.waitFor(0, ts);
    for (;;) {
      const ph = this.phase;
      switch (ph.kind) {
        case 'waiting':
          if (ts >= ph.onsetAt) this.show(ph.i, ts);
          return;
        case 'shown': {
          const end = ph.answeredAt ?? (ts >= ph.deadline ? ph.deadline : null);
          if (end === null) {
            if ((this.specs[ph.i] as TrialSpec).stimulus.kind === 'rdo') this.renderer.tick(ts - ph.onset);
            return;
          }
          this.phase = ph.i + 1 < this.specs.length ? this.waitFor(ph.i + 1, end) : { kind: 'grace', until: end + LATE_GRACE_MS };
          this.renderer.hide();
          break;
        }
        case 'grace':
          if (ts >= ph.until) this.finish({ kind: 'done', timeline: this.timeline });
          return;
        default:
          return;
      }
    }
  }

  private waitFor(i: number, from: number): Phase {
    return { kind: 'waiting', i, onsetAt: from + (this.specs[i] as TrialSpec).isiMs };
  }

  private show(i: number, ts: number): void {
    const spec = this.specs[i] as TrialSpec;
    this.timeline.onsets.push(ts);
    this.timeline.droppedOnset.push(this.prevFrameTs !== null && isDroppedFrame(ts - this.prevFrameTs, this.nominalFrameMs));
    // Phase first: a renderer callback that presses or aborts sees the trial as shown.
    this.phase = { kind: 'shown', i, onset: ts, deadline: ts + spec.windowMs, answeredAt: null };
    this.renderer.show(spec.stimulus);
    if (spec.stimulus.kind === 'rdo') this.renderer.tick(0);
  }

  private finish(end: RunnerEnd): void {
    this.phase = { kind: 'finished' };
    this.result = end;
    this.settle?.resolve(end);
  }
}
