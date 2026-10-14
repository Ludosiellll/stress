/** Per-item time limit of number series: the lever above a family's difficulty ceiling (R36). */

export const BASE_ITEM_LIMIT_MS = 40000;
export const MIN_ITEM_LIMIT_MS = 8000;

/** Each halving of the limit adds this much difficulty. */
const D_PER_HALVING = 200;
const LIMIT_STEP_MS = 100;

/** dStruct + 200·log2(40000/limitMs); RangeError unless limitMs is finite and > 0. */
export function effectiveDifficulty(dStruct: number, limitMs: number): number {
  if (!Number.isFinite(limitMs) || limitMs <= 0) {
    throw new RangeError(`limitMs must be finite and positive, got ${String(limitMs)}`);
  }
  return dStruct + D_PER_HALVING * Math.log2(BASE_ITEM_LIMIT_MS / limitMs);
}

/** 40000 while targetD ≤ familyMaxD; otherwise clamp(round100(40000·2^(−(targetD − dStruct)/200)), 8000, 40000). */
export function itemTimeLimit(targetD: number, dStruct: number, familyMaxD: number): number {
  if (![targetD, dStruct, familyMaxD].every(Number.isFinite)) {
    throw new RangeError(
      `itemTimeLimit: inputs must be finite, got ${String(targetD)}, ${String(dStruct)}, ${String(familyMaxD)}`,
    );
  }
  if (targetD <= familyMaxD) return BASE_ITEM_LIMIT_MS;
  const exact = BASE_ITEM_LIMIT_MS * 2 ** (-(targetD - dStruct) / D_PER_HALVING);
  const rounded = Math.round(exact / LIMIT_STEP_MS) * LIMIT_STEP_MS;
  return Math.min(BASE_ITEM_LIMIT_MS, Math.max(MIN_ITEM_LIMIT_MS, rounded));
}
