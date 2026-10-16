import { diagnosticSeriesSchedule, diagnosticSeriesSeed } from '../../engine/diagnostic';
import { R0, familyWeights, pickWeighted, targetDifficulty } from '../../engine/elo';
import { itemTimeLimit, structTarget } from '../../engine/itemLimit';
import { createRng, deriveSeed, type Rng } from '../../engine/rng';
import { fitPredictions, isUnique } from './check';
import { HELD_OUT_FAMILIES, TRAINING_FAMILIES, fitFamily, generateTerms, structDifficulty, type FamilyId } from './families';

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

/**
 * The lowest D a held-out item reaches after T-R70: digitsum its base; twostep 1400 + 100 (t₀·5! passes 100); powstep
 * only cubes, 1300 + 100 + 300 ((m + 5s)³ passes 1000).
 */
export const HELD_OUT_MIN_D: Readonly<Record<'powstep' | 'twostep' | 'digitsum', number>> = {
  powstep: 1700,
  twostep: 1500,
  digitsum: 1350,
};
/** A held-out diagnostic item is aimed this far above its family's lowest D: with ±150 it takes the whole lower band. */
const HELD_OUT_AIM_ABOVE_MIN = 75;
/** How many next seeds an item of a form may take before a repeat is given up as impossible. */
const MAX_FORM_RETRIES = 100;

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
 * the shown terms with the answer (a letter series: within positions 1…32), one of the 13 numeric
 * predictors justifies another answer, or the item of a held-out family reduces to a training family
 * (reducesToTraining, T-R70). Exported for tests.
 */
export function candidateItem(family: FamilyId, seed: number, terms: readonly number[]): SeriesItem | null {
  if (terms.some((x) => Math.abs(x) > MAX_ABS_TERM)) return null;
  if (new Set(terms).size < MIN_DISTINCT_VALUES) return null;
  const shown = terms.slice(0, -1);
  const answer = terms[terms.length - 1] as number;
  if (!fitFamily(family, shown).has(answer) || !isUnique(shown, answer)) return null;
  if (reducesToTraining(family, shown)) return null;
  return {
    id: `${family}:${String(seed)}`,
    family,
    seed,
    shown,
    answer,
    difficulty: difficultyOf(family, shown, answer),
  };
}

/**
 * A held-out item tests transfer (spec §4.8): it must not be solvable by a rule the user trains. So an item of a held-out
 * family is rejected when any training family's rule, with its wide predictor ranges, fits all its shown terms, even
 * with the same answer (T-R70): a digit-sum series over multiples of 9 is a +9 progression, squares of a progression are
 * a second-order series.
 */
function reducesToTraining(family: FamilyId, shown: readonly number[]): boolean {
  return HELD_OUT_FAMILIES.includes(family) && fitPredictions(shown, TRAINING_FAMILIES).size > 0;
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
 * The D a diagnostic item of `family` is aimed at (T-R72): its scheduled targetD; a held-out family at least 75 above its
 * lowest D. The scheduled targets of the held-out families lie mostly below what they reach, and aimed there every item
 * would be one of the few series of the lowest D (12 pure cubes, 6 twostep series of k = 1, c = 0).
 */
export function diagnosticAim(family: FamilyId, targetD: number): number {
  const lowest = family === 'powstep' || family === 'twostep' || family === 'digitsum' ? HELD_OUT_MIN_D[family] : null;
  return lowest === null ? targetD : Math.max(targetD, lowest + HELD_OUT_AIM_ABOVE_MIN);
}

/**
 * The first `count` items of the number-series form of the diagnostic with seed index `seedIndex` (F12): the schedule of
 * spec §4.8, item № from diagnosticSeriesSeed(seedIndex, №), aimed at diagnosticAim. An item whose shown terms repeat
 * those of an earlier item of the form takes the item's next seed (sub-index 1, 2, …; T-R72). Deterministic.
 */
export function diagnosticSeriesItems(seedIndex: number, count: number = diagnosticSeriesSchedule().length): SeriesItem[] {
  const schedule = diagnosticSeriesSchedule().slice(0, count);
  return withoutRepeats(schedule.length, (i, retry) => {
    const e = schedule[i] as (typeof schedule)[number];
    return generateItem(e.family, diagnosticAim(e.family, e.targetD), diagnosticSeriesSeed(seedIndex, i + 1, retry));
  });
}

/**
 * `count` items in order, item i the first of item(i, 0), item(i, 1), … whose shown terms no earlier item has (T-R72);
 * an Error after MAX_FORM_RETRIES next seeds. Exported for tests.
 */
export function withoutRepeats<T extends { shown: readonly number[] }>(count: number, item: (i: number, retry: number) => T): T[] {
  const items: T[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    let retry = 0;
    let next = item(i, retry);
    while (seen.has(next.shown.join(','))) {
      retry++;
      if (retry > MAX_FORM_RETRIES) throw new Error(`item ${String(i + 1)} repeats an earlier one after ${String(MAX_FORM_RETRIES)} next seeds`);
      next = item(i, retry);
    }
    seen.add(next.shown.join(','));
    items.push(next);
  }
  return items;
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
