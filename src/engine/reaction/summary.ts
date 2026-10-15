import { cv, mean, median, sd } from '../stats';
import type { Outcome, ReactionSummary, TrialResult } from './types';

/** A block is flagged `timingUnreliable` when at least this many onset frames were dropped… */
const MIN_DROPPED = 2;
/** …and their share of the block's trials exceeds this. */
const MAX_DROPPED_RATIO = 0.05;

/**
 * An RT that block and condition statistics use: a hit of a `press` trial outside practice whose onset frame was
 * not dropped (its onset time is certain). One rule for summarize, conditionStats and the fatigue RTs.
 */
export function isCleanHitRt(r: TrialResult): r is TrialResult & { rtMs: number } {
  return !r.practice && !r.frameDropped && r.kind === 'press' && r.outcome === 'hit' && r.rtMs !== null;
}

/**
 * Cost of an error above a non-success (spec §2.1, F1). Against a perfect trial, a late answer or a miss costs 1, a
 * wrong key 2, a false start or a press on no-go 3; `early` and `timing_late` cost 1 like a late answer.
 */
export const PENALTY = Object.freeze({ wrong: 1, false_start: 2, commission: 2 } as const);

/** The penalty of a block: wrong + 2·(false starts + no-go presses). */
export function penaltyPoints(counts: Readonly<Record<Outcome, number>>): number {
  return PENALTY.wrong * counts.wrong + PENALTY.false_start * counts.false_start + PENALTY.commission * counts.commission;
}

/** s = max(0, successes − penalty) / n, the score the staircase runs on (F1); 0 for n = 0. */
export function penalizedScore(counts: Readonly<Record<Outcome, number>>, n: number): number {
  if (n === 0) return 0;
  return Math.max(0, counts.hit + counts.correct_reject - penaltyPoints(counts)) / n;
}

/**
 * Block summary over non-practice trials. RT statistics use hits of `press` trials only, and leave out
 * trials whose onset frame was dropped (their onset time is uncertain); those still count for score and counts.
 * Error statistics use every result with an errorMs (timed trials answered with the right key, no false starts).
 */
export function summarize(results: readonly TrialResult[]): ReactionSummary {
  const counts: Record<Outcome, number> = {
    hit: 0,
    wrong: 0,
    miss: 0,
    late: 0,
    false_start: 0,
    commission: 0,
    correct_reject: 0,
    early: 0,
    timing_late: 0,
  };
  let n = 0;
  let successes = 0;
  let dropped = 0;
  const rts: number[] = [];
  const errors: number[] = [];
  for (const r of results) {
    if (r.practice) continue;
    n++;
    counts[r.outcome]++;
    if (r.success) successes++;
    if (r.frameDropped) dropped++;
    if (isCleanHitRt(r)) rts.push(r.rtMs);
    if (r.errorMs !== null) errors.push(r.errorMs);
  }
  const hasRt = rts.length > 0;
  const hasErr = errors.length > 0;
  return {
    n,
    score: n === 0 ? 0 : successes / n,
    penalizedScore: penalizedScore(counts, n),
    meanRt: hasRt ? mean(rts) : null,
    medianRt: hasRt ? median(rts) : null,
    sdRt: hasRt ? sd(rts) : null,
    cvRt: hasRt ? cv(rts) : null,
    counts,
    meanAbsErrorMs: hasErr ? mean(errors.map((e) => Math.abs(e))) : null,
    meanSignedErrorMs: hasErr ? mean(errors) : null,
    timingUnreliable: dropped >= MIN_DROPPED && dropped / n > MAX_DROPPED_RATIO,
  };
}
