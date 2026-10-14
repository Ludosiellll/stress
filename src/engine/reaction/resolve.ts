import type { BlockTimeline, Expected, Outcome, Press, TrialResult, TrialSpec } from './types';

/** A response this soon after onset cannot be a reaction to the stimulus (`press` and `timed` trials). */
export const FALSE_START_MS = 100;

interface Trial {
  spec: TrialSpec;
  onset: number;
  falseStart: boolean;
  /** First press in the window, or the late press of a `press` trial. */
  response: Press | null;
  late: boolean;
}

/** By time; equal timestamps by key, so the result never depends on the order presses arrive in. */
function byTsThenKey(a: Press, b: Press): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

function validate(specs: readonly TrialSpec[], tl: BlockTimeline): void {
  const n = String(specs.length);
  if (tl.onsets.length !== specs.length) {
    throw new RangeError(`resolveBlock: ${String(tl.onsets.length)} onsets for ${n} trials`);
  }
  if (tl.droppedOnset.length !== specs.length) {
    throw new RangeError(`resolveBlock: ${String(tl.droppedOnset.length)} droppedOnset flags for ${n} trials`);
  }
  for (let i = 1; i < tl.onsets.length; i++) {
    if (!((tl.onsets[i] as number) >= (tl.onsets[i - 1] as number))) {
      throw new RangeError('resolveBlock: onsets must be non-decreasing');
    }
  }
}

function outcomeOf(t: Trial): Outcome {
  if (t.falseStart) return 'false_start';
  const { expected } = t.spec;
  const r = t.response;
  if (expected.kind === 'withhold') return r === null ? 'correct_reject' : 'commission';
  if (r === null) return 'miss';
  if (t.late) return 'late';
  const rt = r.ts - t.onset;
  if (rt < FALSE_START_MS) return 'false_start';
  if (r.key !== expected.key) return 'wrong';
  if (expected.kind === 'press') return 'hit';
  const err = rt - expected.targetOffsetMs;
  if (err < -expected.toleranceMs) return 'early';
  if (err > expected.toleranceMs) return 'timing_late';
  return 'hit';
}

/** Signed timing error of a `timed` trial answered with the right key; false starts never get one (ruling R10). */
function timingErrorOf(expected: Expected, outcome: Outcome, r: Press | null, rtMs: number | null): number | null {
  if (expected.kind !== 'timed' || outcome === 'false_start' || rtMs === null || r?.key !== expected.key) return null;
  return rtMs - expected.targetOffsetMs;
}

/**
 * Turns what happened in a block (onsets + presses) into one result per trial, in trial order.
 * Rules (task 6 contract):
 * 1. Presses are sorted by ts; a press belongs to the last trial with onset ≤ ts.
 *    A press before the first onset marks trial 0 as a false start.
 * 2. The first press with ts ≤ onset + windowMs is the trial's response; later ones in the window are ignored.
 * 3. After the window, the first press is the `late` response of an unanswered `press` trial;
 *    any other press marks the next trial as a false start (ignored after the last trial).
 * 4. A false-start mark overrides the outcome; rtMs/key still come from the trial's response, if any.
 */
export function resolveBlock(specs: readonly TrialSpec[], tl: BlockTimeline): TrialResult[] {
  validate(specs, tl);
  const trials: Trial[] = specs.map((spec, idx) => ({
    spec,
    onset: tl.onsets[idx] as number,
    falseStart: false,
    response: null,
    late: false,
  }));

  let cur = -1;
  let next = trials[0];
  for (const press of [...tl.presses].sort(byTsThenKey)) {
    while (next !== undefined && next.onset <= press.ts) {
      cur++;
      next = trials[cur + 1];
    }
    const trial = trials[cur];
    if (trial === undefined) {
      if (next) next.falseStart = true;
    } else if (press.ts <= trial.onset + trial.spec.windowMs) {
      trial.response ??= press;
    } else if (trial.spec.expected.kind === 'press' && trial.response === null) {
      trial.response = press;
      trial.late = true;
    } else if (next) {
      next.falseStart = true;
    }
  }

  return trials.map((t, idx) => {
    const { expected } = t.spec;
    const r = t.response;
    const rtMs = r === null ? null : r.ts - t.onset;
    const outcome = outcomeOf(t);
    return {
      idx,
      kind: expected.kind,
      outcome,
      success: outcome === 'hit' || outcome === 'correct_reject',
      rtMs,
      errorMs: timingErrorOf(expected, outcome, r, rtMs),
      key: r?.key ?? null,
      frameDropped: tl.droppedOnset[idx] === true,
      practice: t.spec.practice ?? false,
    };
  });
}
