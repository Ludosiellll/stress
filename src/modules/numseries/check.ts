import { FAMILIES, fitFamily, type FamilyId } from './families';

/**
 * Next-term predictions of every family that fits `terms` exactly, with any integer parameters.
 * Families without a prediction are left out.
 */
export function fitPredictions(terms: readonly number[]): Map<FamilyId, Set<number>> {
  if (!terms.every((x) => Number.isSafeInteger(x))) {
    throw new RangeError(`series terms must be safe integers, got [${terms.join(', ')}]`);
  }
  const out = new Map<FamilyId, Set<number>>();
  for (const family of FAMILIES) {
    const predictions = fitFamily(family, terms);
    if (predictions.size > 0) out.set(family, predictions);
  }
  return out;
}

/** True when every rule that fits `shown` continues it with `answer` and nothing else. */
export function isUnique(shown: readonly number[], answer: number): boolean {
  const all = new Set<number>();
  for (const predictions of fitPredictions(shown).values()) for (const x of predictions) all.add(x);
  return all.size === 1 && all.has(answer);
}
