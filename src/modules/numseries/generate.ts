import { R0, familyWeights, pickWeighted, targetDifficulty } from '../../engine/elo';
import { itemTimeLimit, structTarget } from '../../engine/itemLimit';
import { createRng, deriveSeed, type Rng } from '../../engine/rng';
import { isUnique } from './check';
import { TRAINING_FAMILIES, fitFamily, generateTerms, structDifficulty, type FamilyId } from './families';

/**
 * Highest difficulty a candidate of each family reaches under its generation ranges (R36), the new families too: the
 * «Потолок D» column of spec §4.8 did not match the table's own ranges and D_struct terms, so it gives way to them
 * (T-R68). Above it, only a shorter time limit makes items harder.
 */
export const STRUCT_D_MAX: Readonly<Record<FamilyId, number>> = {
  arith: 950,
  geom: 1300,
  second: 1300,
  alt: 1200,
  fib: 1350,
  linrec: 1650,
  powers: 1500,
  opcycle: 1700,
  letters: 1350,
  addsub: 1350,
  primes: 1400,
  powstep: 1800,
  twostep: 1900,
  digitsum: 1650,
};

const MAX_ABS_TERM = 100000;
/** Constant and 2-cycle series are unique but trivial (R13). */
const MIN_DISTINCT_VALUES = 3;
/** A candidate this close to the target difficulty is taken at once. */
const D_TOLERANCE = 150;

/** Which candidates selectCandidate takes at once: D from targetD − below to targetD + above. */
export interface DWindow {
  below: number;
  above: number;
}

const ANY_NEAR: DWindow = { below: D_TOLERANCE, above: D_TOLERANCE };
/**
 * A training item is taken at most 25 above its structural target (F12): its limit follows its own D_struct, and each 25
 * above the target lengthen it by 9 % (2^(25/200)); 150 above would give 1.7 times the limit of the target (a geom item
 * of 1100 at rating 1480: 20.8 s instead of 18.2 s). Below the target the limit only gets shorter.
 */
export const TRAINING_WINDOW: DWindow = { below: D_TOLERANCE, above: 25 };
const PREFERRED_ATTEMPTS = 200;
const MAX_ATTEMPTS = 2000;

export interface SeriesItem {
  /** `${family}:${seed}` */
  id: string;
  family: FamilyId;
  seed: number;
  shown: number[];
  answer: number;
  difficulty: number;
}

/** An item with its own time limit; null for diagnostic items, where the block's total limit applies (R19). */
export interface TimedSeriesItem extends SeriesItem {
  timeLimitMs: number | null;
}

/** A training item: it always has its own limit (R36). */
export interface TrainingSeriesItem extends TimedSeriesItem {
  timeLimitMs: number;
}

/**
 * D = D_struct (the base, plus the rule terms of a new family, spec §4.8) + 100·[max|t| > 100] + 200·[max|t| > 1000] +
 * 50·[any t < 0] over the shown terms and the answer. Letter positions (1…32) add no size terms.
 */
export function difficultyOf(family: FamilyId, shown: readonly number[], answer: number): number {
  const terms = [...shown, answer];
  const maxAbs = Math.max(...terms.map((x) => Math.abs(x)));
  return (
    structDifficulty(family, terms) +
    (maxAbs > 100 ? 100 : 0) +
    (maxAbs > 1000 ? 200 : 0) +
    (terms.some((x) => x < 0) ? 50 : 0)
  );
}

/**
 * The item for `terms` (the shown terms, then the answer), or null when it is rejected:
 * a term beyond ±100000, fewer than 3 distinct values (R13), its own family does not continue
 * the shown terms with the answer (a letter series: within positions 1…32), or one of the 13 numeric
 * predictors justifies another answer. Exported for tests.
 */
export function candidateItem(family: FamilyId, seed: number, terms: readonly number[]): SeriesItem | null {
  if (terms.some((x) => Math.abs(x) > MAX_ABS_TERM)) return null;
  if (new Set(terms).size < MIN_DISTINCT_VALUES) return null;
  const shown = terms.slice(0, -1);
  const answer = terms[terms.length - 1] as number;
  if (!fitFamily(family, shown).has(answer) || !isUnique(shown, answer)) return null;
  return {
    id: `${family}:${String(seed)}`,
    family,
    seed,
    shown,
    answer,
    difficulty: difficultyOf(family, shown, answer),
  };
}

/** Attempt `attempt` of generateItem: a fresh candidate from its own rng, or null. Exported for tests. */
export function attemptItem(family: FamilyId, seed: number, attempt: number): SeriesItem | null {
  const terms = generateTerms(family, createRng(deriveSeed(seed, 'attempt:' + String(attempt))));
  return candidateItem(family, seed, terms);
}

/**
 * The first accepted candidate within `window` of `targetD` (default D_TOLERANCE either side); failing that, the
 * closest one accepted in the first 200 attempts (the earliest on ties). If none of those was accepted, the next
 * accepted candidate up to attempt 2000. Exported for tests.
 */
export function selectCandidate<T extends { difficulty: number }>(
  attempt: (i: number) => T | null,
  targetD: number,
  window: DWindow = ANY_NEAR,
): T {
  let best: T | null = null;
  let bestGap = Infinity;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const candidate = attempt(i);
    if (candidate !== null) {
      const offset = candidate.difficulty - targetD;
      if (offset >= -window.below && offset <= window.above) return candidate;
      const gap = Math.abs(offset);
      if (gap < bestGap) {
        best = candidate;
        bestGap = gap;
      }
    }
    // From attempt 200 on, the best so far wins. If the first 200 accepted nothing, this is
    // the first accepted candidate of attempts 200..1999, however far its D is from targetD.
    if (best !== null && i + 1 >= PREFERRED_ATTEMPTS) return best;
  }
  throw new Error(`no acceptable series in ${String(MAX_ATTEMPTS)} attempts`);
}

/** A series of `family` with a single justified continuation, aimed at difficulty `targetD`. Deterministic. */
export function generateItem(family: FamilyId, targetD: number, seed: number): SeriesItem {
  if (!Number.isFinite(targetD)) throw new RangeError(`targetD must be finite, got ${String(targetD)}`);
  return selectCandidate((i) => attemptItem(family, seed, i), targetD);
}

/**
 * A training item for `targetD` (F12): a series aimed at structTarget(targetD, STRUCT_D_MAX of the family), taken within
 * TRAINING_WINDOW of it, with the time limit of its own difficulty — 30 s below targetD 1000, shorter from it on, so that
 * the effective difficulty reaches `targetD` (R36). Deterministic.
 */
export function generateTrainingItem(family: FamilyId, targetD: number, seed: number): TrainingSeriesItem {
  const item = selectCandidate((i) => attemptItem(family, seed, i), structTarget(targetD, STRUCT_D_MAX[family]), TRAINING_WINDOW);
  return { ...item, timeLimitMs: itemTimeLimit(targetD, item.difficulty) };
}

/**
 * `count` training items of the 11 training families (the held-out ones never, spec §4.8); weaker families come up
 * more often, each aimed at P ≈ 0.75 for its rating.
 */
export function generateBlockItems(ratings: ReadonlyMap<FamilyId, number>, count: number, rng: Rng): TrainingSeriesItem[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${String(count)}`);
  }
  const weights = familyWeights(TRAINING_FAMILIES.map((f) => ratings.get(f) ?? R0));
  const items: TrainingSeriesItem[] = [];
  for (let i = 0; i < count; i++) {
    const family = pickWeighted(TRAINING_FAMILIES, weights, rng);
    const targetD = targetDifficulty(ratings.get(family) ?? R0);
    const seed = rng.int(0, 0x7fffffff);
    items.push(generateTrainingItem(family, targetD, seed));
  }
  return items;
}
