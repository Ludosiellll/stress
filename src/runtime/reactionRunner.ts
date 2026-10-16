import { FALSE_START_MS } from '../engine/reaction/resolve';
import type { BlockTimeline, Press, Stimulus, TrialSpec } from '../engine/reaction/types';
import { medianOfSorted } from '../engine/stats';
import { isDroppedFrame } from '../engine/timing';
import type { FrameClock } from './frameClock';

/**
 * Draws stimuli. `show` and `tick` are called from inside a frame callback, so the drawing lands in that frame.
 * `jitter` (F9): the trial's place and size, given to its cue and its stimulus alike; absent, centred as is.
 */
export interface StimulusRenderer {
  show(s: Stimulus, jitter?: TrialSpec['jitter']): void;
  hide(): void;
  /**
   * Draws the trial's cue alone (task switching: the rule word), `TrialSpec.cueLeadMs` before the onset, where the
   * stimulus will come. The cue stays on screen with the stimulus; `hide` clears both. Renderers without cues leave it out.
   */
  cue?(s: Stimulus, jitter?: TrialSpec['jitter']): void;
  /**
   * RDO only: called on every frame while the stimulus is shown, with the time since onset at which this frame will
   * be seen (frame ts − onset + presentation lead; the lead alone on the onset frame).
   */
  tick(elapsedMs: number): void;
  /**
   * Called once per frame of the block, before that frame's transitions, with its timestamp: the background
   * (visual noise) moves to this frame's time, so a stimulus shown in it is drawn once, over the right background.
   * Draws nothing.
   */
  beginFrame?(ts: number): void;
  /** Called once per frame of the block, after that frame's transitions (background animation: visual noise). */
  frame?(ts: number): void;
  /**
   * Draws the mark after a trial (F15) over whatever is on screen, until `clearMark`; a new mark replaces it. Hiding a
   * stimulus keeps it; `show` takes it away in the same draw, as a mark never shares a frame with a stimulus (T-R59).
   * Renderers without marks leave both out.
   */
  mark?(text: FeedbackMark): void;
  /** Takes the mark away; the rest of the screen stays. */
  clearMark?(): void;
}

/** The mark after a trial (F15): a false start, or a wrong key or a press on a no-go trial. */
export type FeedbackMark = 'рано' | 'ошибка';

/** A mark stays from the frame after the press to the first frame at or after its own frame + FEEDBACK_MS (F15). */
export const FEEDBACK_MS = 150;

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
  /**
   * Called when the wait for trial i begins: in the first frame (t0) for i = 0, otherwise in the frame that ends
   * trial i − 1, before its stimulus is hidden. Background layers switch here, so they cover the ISI too.
   */
  onTrial?: (i: number) => void;
}

/**
 * What resolveBlock makes of a press, by its rules 1–3b: the response of a trial (in its window or late), a false start
 * of a trial not shown yet, or nothing (a second press in a window, a press after the last trial).
 */
type Attribution = { kind: 'response'; trial: number; late: boolean } | { kind: 'false_start'; trial: number } | { kind: 'none' };

const NONE: Attribution = { kind: 'none' };

/** leadMs: the RDO presentation lead, fixed at the onset. */
type Shown = { kind: 'shown'; i: number; onset: number; deadline: number; answeredAt: number | null; leadMs: number };

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  /** cueAt: when the cue of trial i is due; null when it has none or was already drawn. */
  | { kind: 'waiting'; i: number; onsetAt: number; cueAt: number | null }
  | Shown
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
 *   A press that `resolveBlock` gives to the previous trial as its late answer (rule 3b, T-R32: under FALSE_START_MS
 *   after the onset, the previous trial a `press` trial past its window without a response) does not end the trial.
 *   `press()` keeps, per trial, whether the resolver gives it a response, by the resolver's own rules, so a press
 *   that already answered an earlier trial never counts for a later one (T-R40); the frame loop is unchanged.
 * - Every press while the block runs is recorded, whatever the phase. After the last trial, presses stamped up to
 *   end + LATE_GRACE_MS are still recorded; the block is done in the first frame at or after that time plus
 *   `nominalFrameMs`, so a press already in flight at the grace end is not lost.
 *   Presses before `start()` or after the block ended are ignored.
 * - Frame interval (R37): the delta of every frame after t0 is kept, up to the frame that ends the block. The block's
 *   `frameMs` is their median (`nominalFrameMs` with fewer than MIN_FRAME_SAMPLES). When the block is done, each
 *   onset frame is judged against it: dropped if its own delta is longer than 1.5 × frameMs. An onset in the first
 *   frame has no delta and is never dropped.
 * - RDO frames are drawn ahead by the presentation lead (see RunnerOptions); nothing else uses the lead.
 * - Marks (F15): a press of a trial with `feedback` that resolveBlock scores false_start («рано»: a press before the
 *   onset that answers no earlier trial, or under FALSE_START_MS after it) or wrong / commission («ошибка»: a wrong key
 *   in the window, a press on a `withhold` trial) leaves a mark, one per trial, by its first event; late answers and
 *   misses have none. `press()` only notes it; the next frame draws it after its transitions, and the first frame at
 *   or after that frame + FEEDBACK_MS clears it, or the next onset takes it away with the stimulus (`show`). A frame
 *   that shows a stimulus draws no mark: one due there is dropped, so an onset frame draws once (T-R59). When two
 *   trials earn a mark between the same two frames, the earlier trial's is drawn. Onsets, deadlines and frame
 *   requests never depend on a mark.
 * - Jitter (F9): a trial's cue and stimulus are drawn with its `jitter`; nothing in the timing depends on it.
 * - Background layers (visual noise): `onTrial(i)` when the wait for trial i begins, `renderer.beginFrame(ts)` in
 *   every frame before its transitions and `renderer.frame(ts)` after them. None changes an onset or a press time.
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
  private readonly onTrial: ((i: number) => void) | null;

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
  /** Per shown trial: whether resolveBlock gives it a response (in its window or late) from the presses so far. */
  private readonly answered: boolean[] = [];
  /** The trials that got their mark (F15). */
  private readonly marked = new Set<number>();
  /** A mark decided since the last frame, drawn in the next one; the first one noted wins (the earlier trial's). */
  private pendingMark: FeedbackMark | null = null;
  /** The frame timestamp the mark on screen was drawn in; null: none on screen. */
  private markAt: number | null = null;
  private result: RunnerEnd | null = null;
  private settle: { resolve: (end: RunnerEnd) => void; reject: (err: Error) => void } | null = null;

  constructor(o: RunnerOptions) {
    validate(o);
    this.specs = o.specs;
    this.clock = o.clock;
    this.renderer = o.renderer;
    this.nominalFrameMs = o.nominalFrameMs;
    this.presentationLeadMs = o.presentationLeadMs ?? null;
    this.onTrial = o.onTrial ?? null;
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

  /** Stimuli shown so far, practice trials included (the share of the block done, F11). */
  onsetCount(): number {
    return this.onsets.length;
  }

  press(p: Press): void {
    const ph = this.phase;
    if (ph.kind === 'idle' || ph.kind === 'finished') return;
    if (ph.kind === 'grace' && p.ts > ph.until) return;
    const a = this.claim(p.ts);
    if (ph.kind === 'shown' && ph.answeredAt === null && a.kind === 'response' && a.trial === ph.i && p.ts <= ph.deadline) {
      ph.answeredAt = p.ts;
    }
    this.noteMark(a, p);
    this.presses.push({ key: p.key, ts: p.ts });
  }

  /**
   * What resolveBlock makes of a press stamped `ts`; a response marks its trial answered. Input arrives in time order,
   * so the presses are seen in the resolver's order: the press belongs to the last trial shown at or before `ts`
   * (rule 1), answers the previous trial late under rule 3b, is the response in the window (rule 2) or the late
   * response of an unanswered `press` trial (rule 3); otherwise it is a false start of the next trial (of trial 0 before
   * the first onset), or nothing after the last trial or as a second press in a window.
   */
  private claim(ts: number): Attribution {
    let k = this.onsets.length - 1;
    while (k >= 0 && (this.onsets[k] as number) > ts) k--;
    if (k < 0) return { kind: 'false_start', trial: 0 };
    const spec = this.specs[k] as TrialSpec;
    const onset = this.onsets[k] as number;
    if (k > 0 && ts < onset + FALSE_START_MS && this.unansweredPressPast(k - 1, ts)) return this.respond(k - 1, true);
    if (ts <= onset + spec.windowMs) return this.answered[k] === true ? NONE : this.respond(k, false);
    if (this.unansweredPressPast(k, ts)) return this.respond(k, true);
    return k + 1 < this.specs.length ? { kind: 'false_start', trial: k + 1 } : NONE;
  }

  private respond(trial: number, late: boolean): Attribution {
    this.answered[trial] = true;
    return { kind: 'response', trial, late };
  }

  /** The mark a press earns its trial (F15), as resolveBlock scores it, noted for the next frame; one per trial. */
  private noteMark(a: Attribution, p: Press): void {
    const mark = this.markOf(a, p);
    if (mark === null || a.kind === 'none' || this.marked.has(a.trial)) return;
    if ((this.specs[a.trial] as TrialSpec).feedback !== true) return;
    this.marked.add(a.trial);
    this.pendingMark ??= mark;
  }

  /** «рано» for a false start (before the onset, or a response under FALSE_START_MS); «ошибка» for wrong and commission. */
  private markOf(a: Attribution, p: Press): FeedbackMark | null {
    if (a.kind === 'false_start') return 'рано';
    if (a.kind === 'none' || a.late) return null;
    const { expected } = this.specs[a.trial] as TrialSpec;
    if (expected.kind === 'withhold') return 'ошибка';
    if (p.ts - (this.onsets[a.trial] as number) < FALSE_START_MS) return 'рано';
    return p.key === expected.key ? null : 'ошибка';
  }

  /** Trial k is a `press` trial without a response and `ts` is past its window: the press can be its late answer. */
  private unansweredPressPast(k: number, ts: number): boolean {
    const spec = this.specs[k] as TrialSpec;
    return spec.expected.kind === 'press' && this.answered[k] !== true && ts > (this.onsets[k] as number) + spec.windowMs;
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
    // A frame that still arrives after the block ended does nothing. (A local copy: the check must not narrow
    // this.phase, which advance() changes.)
    const before = this.phase;
    if (before.kind === 'finished') return;
    this.measureFrame(ts);
    try {
      this.renderer.beginFrame?.(ts);
      // The mark noted before this frame; one noted by a renderer callback during it waits for the next frame.
      const mark = this.pendingMark;
      this.pendingMark = null;
      const shown = this.onsets.length;
      this.advance(ts);
      if (this.onsets.length === shown && this.phase.kind !== 'finished') this.updateMark(ts, mark);
      this.renderer.frame?.(ts);
    } catch (err) {
      this.phase = { kind: 'finished' };
      this.settle?.reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (this.phase.kind !== 'finished') this.frameId = this.clock.request(this.onFrame);
  };

  /**
   * F15, after the transitions of a frame without an onset: the mark noted since the last frame appears in this one;
   * the one on screen goes FEEDBACK_MS after its frame.
   */
  private updateMark(ts: number, mark: FeedbackMark | null): void {
    if (mark !== null) {
      this.markAt = ts;
      this.renderer.mark?.(mark);
    } else if (this.markAt !== null && ts >= this.markAt + FEEDBACK_MS) {
      this.clearMark();
    }
  }

  private clearMark(): void {
    this.markAt = null;
    this.renderer.clearMark?.();
  }

  /** Records the delta of the frame at `ts` (the first frame has none). */
  private measureFrame(ts: number): void {
    this.frameDelta = this.prevFrameTs === null ? null : ts - this.prevFrameTs;
    if (this.frameDelta !== null) insertSorted(this.sortedDeltas, this.frameDelta);
    this.prevFrameTs = ts;
  }

  /** Runs every transition due at frame `ts` (more than one when an ISI of 0 follows an answered trial). */
  private advance(ts: number): void {
    if (this.phase.kind === 'starting') this.beginWait(0, ts);
    for (;;) {
      const ph = this.phase;
      switch (ph.kind) {
        case 'waiting':
          if (ph.cueAt !== null && ts >= ph.cueAt) {
            ph.cueAt = null;
            const { stimulus, jitter } = this.specs[ph.i] as TrialSpec;
            this.renderer.cue?.(stimulus, jitter);
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
          if (ph.i + 1 < this.specs.length) this.beginWait(ph.i + 1, end);
          else this.phase = this.graceAfter(end);
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

  /** Trial i is due isi_i after `from`; onTrial(i) sees the phase already waiting (an abort there sticks). */
  private beginWait(i: number, from: number): void {
    const spec = this.specs[i] as TrialSpec;
    const onsetAt = from + spec.isiMs;
    const lead = spec.cueLeadMs ?? 0;
    this.phase = { kind: 'waiting', i, onsetAt, cueAt: lead > 0 ? onsetAt - lead : null };
    this.onTrial?.(i);
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
    // A mark never shares a frame with a stimulus (F15): renderer.show takes it away in the same draw (T-R59).
    this.markAt = null;
    this.onsets.push(ts);
    this.onsetDeltas.push(this.frameDelta);
    this.answered.push(false);
    const leadMs = this.presentationLeadMs ?? this.frameInterval();
    // Phase first: a renderer callback that presses or aborts sees the trial as shown.
    this.phase = { kind: 'shown', i, onset: ts, deadline: ts + spec.windowMs, answeredAt: null, leadMs };
    this.renderer.show(spec.stimulus, spec.jitter);
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
    this.pendingMark = null;
    if (this.markAt !== null) this.clearMark();
    this.settle?.resolve(end);
  }
}
