import { R0, familyWeights, pickWeighted, targetDifficulty } from '../../engine/elo';
import { createRng, deriveSeed, type Rng } from '../../engine/rng';
import { isUnique } from './check';
import { BASE_DIFFICULTY, FAMILIES, fitFamily, generateTerms, type FamilyId } from './families';

export const ITEM_TIME_LIMIT_MS = 40000;

const MAX_ABS_TERM = 100000;
/** Constant and 2-cycle series are unique but trivial (R13). */
const MIN_DISTINCT_VALUES = 3;
/** A candidate this close to the target difficulty is taken at once. */
const D_TOLERANCE = 150;
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

/** D = base + 100·[max|t| > 100] + 200·[max|t| > 1000] + 50·[any t < 0] over the shown terms and the answer. */
export function difficultyOf(family: FamilyId, shown: readonly number[], answer: number): number {
  const terms = [...shown, answer];
  const maxAbs = Math.max(...terms.map((x) => Math.abs(x)));
  return (
    BASE_DIFFICULTY[family] +
    (maxAbs > 100 ? 100 : 0) +
    (maxAbs > 1000 ? 200 : 0) +
    (terms.some((x) => x < 0) ? 50 : 0)
  );
}

/**
 * The item for `terms` (the shown terms, then the answer), or null when it is rejected:
 * a term beyond ±100000, fewer than 3 distinct values (R13), its own family does not continue
 * the shown terms with the answer, or some family justifies another answer. Exported for tests.
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
 * The first accepted candidate within D_TOLERANCE of `targetD`; failing that, the closest one
 * accepted in the first 200 attempts (the earliest on ties). If none of those was accepted,
 * the next accepted candidate up to attempt 2000. Exported for tests.
 */
export function selectCandidate<T extends { difficulty: number }>(
  attempt: (i: number) => T | null,
  targetD: number,
): T {
  let best: T | null = null;
  let bestGap = Infinity;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const candidate = attempt(i);
    if (candidate !== null) {
      const gap = Math.abs(candidate.difficulty - targetD);
      if (gap <= D_TOLERANCE) return candidate;
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

/** `count` items; weaker families come up more often, each aimed at P ≈ 0.75 for its rating. */
export function generateBlockItems(ratings: ReadonlyMap<FamilyId, number>, count: number, rng: Rng): SeriesItem[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${String(count)}`);
  }
  const weights = familyWeights(FAMILIES.map((f) => ratings.get(f) ?? R0));
  const items: SeriesItem[] = [];
  for (let i = 0; i < count; i++) {
    const family = pickWeighted(FAMILIES, weights, rng);
    const targetD = targetDifficulty(ratings.get(family) ?? R0);
    const seed = rng.int(0, 0x7fffffff);
    items.push(generateItem(family, targetD, seed));
  }
  return items;
}
