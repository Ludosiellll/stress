import { median } from '../stats';
import type { ReactionModuleId } from '../types';
import type { TrialCond, TrialResult, TrialSpec } from './types';

/** Fewer RTs than this give no median for a condition. */
export const MIN_COND_RTS = 3;

/** Two conditions a module compares: condCost(stats, slow, fast). */
export interface CondPair {
  slow: TrialCond;
  fast: TrialCond;
}

/** The pairs of the modules with trial conditions: noise cost, interference, switch cost. */
export const COND_PAIRS = Object.freeze({
  pomeh: { slow: 'noisy', fast: 'quiet' },
  stroop: { slow: 'incongruent', fast: 'congruent' },
  taskswitch: { slow: 'switch', fast: 'repeat' },
} as const satisfies Partial<Record<ReactionModuleId, CondPair>>);

/** The pair a module compares; null for a module without trial conditions. */
export function condPairOf(module: ReactionModuleId): CondPair | null {
  const pairs: Partial<Record<ReactionModuleId, CondPair>> = COND_PAIRS;
  return pairs[module] ?? null;
}

export interface CondStats {
  /** Non-practice trials with this condition. */
  n: number;
  /** n − successes. */
  errors: number;
  /** Median RT of `press` hits whose onset frame was not dropped; null below MIN_COND_RTS of them. */
  medianRt: number | null;
}

export type ConditionStats = Partial<Record<TrialCond, CondStats>>;

/** Per-condition counts and median RT of a block; trials without a condition and practice trials are left out. */
export function conditionStats(specs: readonly TrialSpec[], results: readonly TrialResult[]): ConditionStats {
  if (specs.length !== results.length) {
    throw new RangeError(`conditionStats: ${String(results.length)} results for ${String(specs.length)} trials`);
  }
  const acc = new Map<TrialCond, { n: number; successes: number; rts: number[] }>();
  results.forEach((r, i) => {
    const cond = specs[i]?.cond;
    if (cond === undefined || r.practice) return;
    let a = acc.get(cond);
    if (a === undefined) {
      a = { n: 0, successes: 0, rts: [] };
      acc.set(cond, a);
    }
    a.n++;
    if (r.success) a.successes++;
    if (r.kind === 'press' && r.outcome === 'hit' && r.rtMs !== null && !r.frameDropped) a.rts.push(r.rtMs);
  });
  const stats: ConditionStats = {};
  for (const [cond, a] of acc) {
    stats[cond] = { n: a.n, errors: a.n - a.successes, medianRt: a.rts.length >= MIN_COND_RTS ? median(a.rts) : null };
  }
  return stats;
}

/** medianRt(slow) − medianRt(fast): interference, noise cost, switch cost. Null if either median is null. */
export function condCost(stats: ConditionStats, slow: TrialCond, fast: TrialCond): number | null {
  const s = stats[slow]?.medianRt ?? null;
  const f = stats[fast]?.medianRt ?? null;
  return s === null || f === null ? null : s - f;
}
