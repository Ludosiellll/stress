import { cv, mean, median, sd } from '../stats';
import type { Outcome, ReactionSummary, TrialResult } from './types';

/** A block whose share of dropped onset frames exceeds this is flagged `timingUnreliable`. */
const MAX_DROPPED_RATIO = 0.05;

/**
 * Block summary over non-practice trials. RT statistics use hits of `press` trials only;
 * error statistics use every result with an errorMs (timed trials answered with the right key).
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
    if (r.kind === 'press' && r.outcome === 'hit' && r.rtMs !== null) rts.push(r.rtMs);
    if (r.errorMs !== null) errors.push(r.errorMs);
  }
  const hasRt = rts.length > 0;
  const hasErr = errors.length > 0;
  return {
    n,
    score: n === 0 ? 0 : successes / n,
    meanRt: hasRt ? mean(rts) : null,
    medianRt: hasRt ? median(rts) : null,
    sdRt: hasRt ? sd(rts) : null,
    cvRt: hasRt ? cv(rts) : null,
    counts,
    meanAbsErrorMs: hasErr ? mean(errors.map((e) => Math.abs(e))) : null,
    meanSignedErrorMs: hasErr ? mean(errors) : null,
    timingUnreliable: n > 0 && dropped / n > MAX_DROPPED_RATIO,
  };
}
