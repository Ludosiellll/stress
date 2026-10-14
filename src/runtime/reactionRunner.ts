import type { BlockTimeline, Press, Stimulus, TrialSpec } from '../engine/reaction/types';
import { medianOfSorted } from '../engine/stats';
import { isDroppedFrame } from '../engine/timing';
import type { FrameClock } from './frameClock';

/** Draws stimuli. `show` and `tick` are called from inside a frame callback, so the drawing lands in that frame. */
export interface StimulusRenderer {
  show(s: Stimulus): void;
  hide(): void;
  /**
   * Draws the trial's cue alone (task switching: the rule word), `TrialSpec.cueLeadMs` before the onset. The cue
   * stays on screen with the stimulus; `hide` clears both. Renderers without cues leave it out.
   */
  cue?(s: Stimulus): void;
  /**
   * RDO only: called on every frame while the stimulus is shown, with the time since onset at which this frame will
   * be seen (frame ts − onset + presentation lead; the lead alone on the onset frame).
   */
  tick(elapsedMs: number): void;
}

export type AbortReason = 'focus_lost' | 'user';

export type RunnerEnd = { kind: 'done'; timeline: BlockTimeline } | { kind: 'aborted'; reason: AbortReason };

/** After the last trial ends, presses are still collected for this long (late answers), then the block is done. */
export const LATE_GRACE_MS = 300;

/** Frame deltas needed before the block's own frame interval replaces `nominalFrameMs` (R37). */
export const MIN_FRAME_SAMPLES = 10;

export interface RunnerOptions {
  specs: readonly TrialSpec[];
  clock: FrameClock;
  renderer: StimulusRenderer;
  /**
   * Display frame interval measured before the session. A fallback (R37): the block's frame interval is the median
   * of its own frame deltas, and this value stands in only while fewer than MIN_FRAME_SAMPLES deltas are known.
   * It also sets how long the block stays open after the grace period for input in flight.
   */
  nominalFrameMs: number;
  /**
   * Display latency the RDO drawing compensates for: a frame drawn in the rAF callback at ts is seen about one frame
   * later, so the dot is drawn where it will be then. Without it a perfectly timed press scores late by the latency
   * (ruling R17). Default: the block's frame interval measured up to the trial's onset frame (that frame's delta
   * included), fixed for the trial. Onsets and press timing are not affected.
   */
  presentationLeadMs?: number;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  /** cueAt: when the cue of trial i is due; null when it has none or was already drawn. */
  | { kind: 'waiting'; i: number; onsetAt: number; cueAt: number | null }
  /** leadMs: the RDO presentation lead, fixed at the onset. */
  | { kind: 'shown'; i: number; onset: number; deadline: number; answeredAt: number | null; leadMs: number }
  /** Presses stamped ≤ until are recorded; the block closes at closeAt (one frame later, for input in flight). */
  | { kind: 'grace'; until: number; closeAt: number }
  | { kind: 'finished' };

/** Inserts x into the ascending array `sorted` (binary search, then one splice). */
function insertSorted(sorted: number[], x: number): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) <= x) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, x);
}

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
    if (s.cueLeadMs !== undefined && !(Number.isFinite(s.cueLeadMs) && s.cueLeadMs >= 0)) {
      throw new RangeError(`ReactionBlockRunner: trial ${String(i)} cueLeadMs must be ≥ 0, got ${String(s.cueLeadMs)}`);
    }
  });
  const lead = o.presentationLeadMs;
  if (lead !== undefined && !(Number.isFinite(lead) && lead >= 0)) {
    throw new RangeError(`ReactionBlockRunner: presentationLeadMs must be ≥ 0, got ${String(lead)}`);
  }
}

/**
 * Plays a reaction block frame by frame and records what happened; outcomes come later from `resolveBlock`.
 *
 * - t0 is the timestamp of the first frame after `start()`. Trial i is due at (i = 0 ? t0 : end of trial i−1) + isi_i
 *   and appears in the first frame at or after that time; its onset is that frame's timestamp.
 * - A trial with `cueLeadMs` > 0 gets its cue once, in the first frame at or after its due time − cueLeadMs (the
 *   first waiting frame when the lead is longer than the ISI). The cue changes nothing else: the onset is still the
 *   stimulus frame, and a press during the cue is a press before the onset.
 * - An in-window press ends the trial at the press time, and the stimulus is hidden in the next frame.
 *   Otherwise the trial ends at onset + windowMs and is hidden in the first frame at or after that time.
 * - Every press while the block runs is recorded, whatever the phase. After the last trial, presses stamped up to
 *   end + LATE_GRACE_MS are still recorded; the block is done in the first frame at or after that time plus
 *   `nominalFrameMs`, so a press already in flight at the grace end is not lost.
 *   Presses before `start()` or after the block ended are ignored.
 * - Frame interval (R37): the delta of every frame after t0 is kept, up to the frame that ends the block. The block's
 *   `frameMs` is their median (`nominalFrameMs` with fewer than MIN_FRAME_SAMPLES). When the block is done, each
 *   onset frame is judged against it: dropped if its own delta is longer than 1.5 × frameMs. An onset in the first
 *   frame has no delta and is never dropped.
 * - RDO frames are drawn ahead by the presentation lead (see RunnerOptions); nothing else uses the lead.
 * - `abort()` stops the loop and hides the stimulus; if the renderer throws, `start()` rejects with that error.
 * - No I/O: the timeline lives in memory until `start()` resolves.
 */
export class ReactionBlockRunner {
  private readonly specs: readonly TrialSpec[];
  private readonly clock: FrameClock;
  private readonly renderer: StimulusRenderer;
  private readonly nominalFrameMs: number;
  /** Set explicitly in the options; null = the block's frame interval at each onset. */
  private readonly presentationLeadMs: number | null;

  private phase: Phase = { kind: 'idle' };
  private started = false;
  private frameId: number | null = null;
  private prevFrameTs: number | null = null;
  /** Delta of the frame being processed; null on the first frame. */
  private frameDelta: number | null = null;
  /**
   * Every frame delta so far, kept in ascending order (≈ 1 µs per frame) so that the median is read in O(1).
   * Sorting a whole block's deltas takes milliseconds at 240 Hz, too long for the onset frame where the RDO lead is set.
   */
  private readonly sortedDeltas: number[] = [];
  private readonly onsets: number[] = [];
  /** Per trial: the delta of its onset frame, judged when the block is done. */
  private readonly onsetDeltas: (number | null)[] = [];
  private readonly presses: Press[] = [];
  private result: RunnerEnd | null = null;
  private settle: { resolve: (end: RunnerEnd) => void; reject: (err: Error) => void } | null = null;

  constructor(o: RunnerOptions) {
    validate(o);
    this.specs = o.specs;
    this.clock = o.clock;
    this.renderer = o.renderer;
    this.nominalFrameMs = o.nominalFrameMs;
    this.presentationLeadMs = o.presentationLeadMs ?? null;
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
    this.presses.push({ key: p.key, ts: p.ts });
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
    if (this.phase.kind !== 'finished') this.measureFrame(ts);
    try {
      this.advance(ts);
    } catch (err) {
      this.phase = { kind: 'finished' };
      this.settle?.reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (this.phase.kind !== 'finished') this.frameId = this.clock.request(this.onFrame);
  };

  /** Records the delta of the frame at `ts` (the first frame has none). */
  private measureFrame(ts: number): void {
    this.frameDelta = this.prevFrameTs === null ? null : ts - this.prevFrameTs;
    if (this.frameDelta !== null) insertSorted(this.sortedDeltas, this.frameDelta);
    this.prevFrameTs = ts;
  }

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
          if (ph.cueAt !== null && ts >= ph.cueAt) {
            ph.cueAt = null;
            this.renderer.cue?.((this.specs[ph.i] as TrialSpec).stimulus);
            // A cue callback that aborted the block leaves nothing to show.
            if (this.phase !== ph) return;
          }
          if (ts >= ph.onsetAt) this.show(ph.i, ts);
          return;
        case 'shown': {
          const end = ph.answeredAt ?? (ts >= ph.deadline ? ph.deadline : null);
          if (end === null) {
            if ((this.specs[ph.i] as TrialSpec).stimulus.kind === 'rdo') this.renderer.tick(ts - ph.onset + ph.leadMs);
            return;
          }
          this.phase = ph.i + 1 < this.specs.length ? this.waitFor(ph.i + 1, end) : this.graceAfter(end);
          this.renderer.hide();
          break;
        }
        case 'grace':
          if (ts >= ph.closeAt) this.finish({ kind: 'done', timeline: this.closeTimeline() });
          return;
        default:
          return;
      }
    }
  }

  private waitFor(i: number, from: number): Phase {
    const spec = this.specs[i] as TrialSpec;
    const onsetAt = from + spec.isiMs;
    const lead = spec.cueLeadMs ?? 0;
    return { kind: 'waiting', i, onsetAt, cueAt: lead > 0 ? onsetAt - lead : null };
  }

  private graceAfter(end: number): Phase {
    const until = end + LATE_GRACE_MS;
    return { kind: 'grace', until, closeAt: until + this.nominalFrameMs };
  }

  /** The block's frame interval from the deltas measured so far (R37). */
  private frameInterval(): number {
    return this.sortedDeltas.length >= MIN_FRAME_SAMPLES ? medianOfSorted(this.sortedDeltas) : this.nominalFrameMs;
  }

  private show(i: number, ts: number): void {
    const spec = this.specs[i] as TrialSpec;
    this.onsets.push(ts);
    this.onsetDeltas.push(this.frameDelta);
    const leadMs = this.presentationLeadMs ?? this.frameInterval();
    // Phase first: a renderer callback that presses or aborts sees the trial as shown.
    this.phase = { kind: 'shown', i, onset: ts, deadline: ts + spec.windowMs, answeredAt: null, leadMs };
    this.renderer.show(spec.stimulus);
    if (spec.stimulus.kind === 'rdo') this.renderer.tick(leadMs);
  }

  /** Timeline of the finished block: its frame interval over all frames, and the onset frames judged against it. */
  private closeTimeline(): BlockTimeline {
    const frameMs = this.frameInterval();
    return {
      onsets: this.onsets,
      droppedOnset: this.onsetDeltas.map((d) => d !== null && isDroppedFrame(d, frameMs)),
      presses: this.presses,
      frameMs,
    };
  }

  private finish(end: RunnerEnd): void {
    this.phase = { kind: 'finished' };
    this.result = end;
    this.settle?.resolve(end);
  }
}
