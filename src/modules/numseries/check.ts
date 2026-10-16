import { PREDICTOR_FAMILIES, fitFamily, type FamilyId } from './families';

/**
 * Next-term predictions of every family of `families` (the 13 numeric predictors by default) that fits `terms`
 * exactly, with any integer parameters. Families without a prediction are left out.
 */
export function fitPredictions(
  terms: readonly number[],
  families: readonly FamilyId[] = PREDICTOR_FAMILIES,
): Map<FamilyId, Set<number>> {
  if (!terms.every((x) => Number.isSafeInteger(x))) {
    throw new RangeError(`series terms must be safe integers, got [${terms.join(', ')}]`);
  }
  const out = new Map<FamilyId, Set<number>>();
  for (const family of families) {
    const predictions = fitFamily(family, terms);
    if (predictions.size > 0) out.set(family, predictions);
  }
  return out;
}

/**
 * True when every rule of `families` that fits `shown` continues it with `answer` and nothing else. A letter series is
 * checked by its positions against the numeric predictors (spec §4.8).
 */
export function isUnique(shown: readonly number[], answer: number, families: readonly FamilyId[] = PREDICTOR_FAMILIES): boolean {
  const all = new Set<number>();
  for (const predictions of fitPredictions(shown, families).values()) for (const x of predictions) all.add(x);
  return all.size === 1 && all.has(answer);
}
