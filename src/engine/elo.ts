import type { Rng } from './rng';

export const R0 = 1000;

export interface Rating {
  rating: number;
  /** Number of updates so far. */
  n: number;
}

const K_EARLY = 48;
const K_LATE = 32;
const EARLY_ATTEMPTS = 20;
/** Rating gap that gives P = 0.75 (odds 3:1). */
const TARGET_GAP = 400 * Math.log10(3);

/** Probability that a player of rating R solves an item of difficulty D. */
export function expectedScore(R: number, D: number): number {
  return 1 / (1 + 10 ** ((D - R) / 400));
}

export function updateRating(r: Rating, D: number, success: boolean): Rating {
  const k = r.n < EARLY_ATTEMPTS ? K_EARLY : K_LATE;
  const actual = success ? 1 : 0;
  return { rating: r.rating + k * (actual - expectedScore(r.rating, D)), n: r.n + 1 };
}

/** Difficulty at which the expected success rate is about 0.75. */
export function targetDifficulty(R: number): number {
  return R - TARGET_GAP;
}

/** Weaker families get more weight: 1 + (maxR − R_i)/200. */
export function familyWeights(ratings: readonly number[]): number[] {
  const maxR = Math.max(...ratings);
  return ratings.map((r) => 1 + (maxR - r) / 200);
}

/** Weighted pick by cumulative sum; consumes one rng.next(). */
export function pickWeighted<T>(items: readonly T[], weights: readonly number[], rng: Rng): T {
  if (items.length === 0) throw new RangeError('pickWeighted: empty items');
  if (items.length !== weights.length) {
    throw new RangeError('pickWeighted: items and weights differ in length');
  }
  let total = 0;
  let lastPositive = -1;
  for (const [i, w] of weights.entries()) {
    if (!Number.isFinite(w) || w < 0) throw new RangeError(`pickWeighted: bad weight ${String(w)}`);
    if (w > 0) lastPositive = i;
    total += w;
  }
  if (lastPositive < 0) throw new RangeError('pickWeighted: all weights are zero');

  const target = rng.next() * total;
  let acc = 0;
  for (const [i, w] of weights.entries()) {
    acc += w;
    if (target < acc) return items[i] as T;
  }
  // Float rounding can leave target at the total; the last item with weight takes it.
  return items[lastPositive] as T;
}
