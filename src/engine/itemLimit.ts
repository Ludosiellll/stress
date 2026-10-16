/**
 * Per-item time limit of number series (R36, F12): from 30 s, shortened from targetD 1000 on, so the effective
 * difficulty reaches the target with items near structTarget.
 */

/** The reference of D_eff: an item answered within 40 s has D_eff = D_struct (rows stored before 0.2.0 had 40 s). */
export const BASE_ITEM_LIMIT_MS = 40000;
/** A training item's limit up to targetD 1000 and its ceiling above (F12). */
export const ITEM_LIMIT_START_MS = 30000;
export const MIN_ITEM_LIMIT_MS = 8000;

/** Each halving of the limit adds this much difficulty. */
const D_PER_HALVING = 200;
const LIMIT_STEP_MS = 100;
/** From this targetD on the limit shrinks below 30 s (spec §4.8). */
const SHRINK_FROM_D = 1000;
/** What the 30 s base itself adds to D_eff: 200·log2(40/30) ≈ 83 (spec §4.8). */
const BASE_LIMIT_GAIN = 83;
/**
 * From targetD 1000 the structural target rises by half of targetD: 0,5·targetD + 417 = targetD − 83 − 0,5·(targetD −
 * 1000) (spec §4.8); below 1000 it is targetD − 83 (T-R74), the same at 1000.
 */
const STRUCT_SLOPE = 0.5;
const STRUCT_OFFSET = 417;

function checkFinite(name: string, ...xs: number[]): void {
  if (!xs.every(Number.isFinite)) throw new RangeError(`${name}: inputs must be finite, got ${xs.map(String).join(', ')}`);
}

/** dStruct + 200·log2(40000/limitMs); RangeError unless limitMs is finite and > 0. */
export function effectiveDifficulty(dStruct: number, limitMs: number): number {
  if (!Number.isFinite(limitMs) || limitMs <= 0) {
    throw new RangeError(`limitMs must be finite and positive, got ${String(limitMs)}`);
  }
  return dStruct + D_PER_HALVING * Math.log2(BASE_ITEM_LIMIT_MS / limitMs);
}

/** The limit a stored item was answered under: its own, or 40 s for rows stored before 0.2.0 (R36). */
export function itemLimitMs(item: { readonly timeLimitMs: number | null }): number {
  return item.timeLimitMs ?? BASE_ITEM_LIMIT_MS;
}

/** D_eff of an item at its stored limit (R36): the one rule for live rating updates and for rebuilds. */
export function itemEffectiveDifficulty(item: { readonly difficulty: number; readonly timeLimitMs: number | null }): number {
  return effectiveDifficulty(item.difficulty, itemLimitMs(item));
}

/**
 * The D_struct a training item is generated near: min(familyMaxD, 0,5·targetD + 417) from targetD 1000 (F12); below it
 * min(familyMaxD, targetD − 83), so that with its 30 s D_eff is the targetD (T-R74).
 */
export function structTarget(targetD: number, familyMaxD: number): number {
  checkFinite('structTarget', targetD, familyMaxD);
  const target = targetD < SHRINK_FROM_D ? targetD - BASE_LIMIT_GAIN : STRUCT_SLOPE * targetD + STRUCT_OFFSET;
  return Math.min(familyMaxD, target);
}

/**
 * 30 000 below targetD 1000; from it on clamp(round100(40 000·2^(−(targetD − dStruct)/200)), 8000, 30 000), so that the
 * effective difficulty of an item of D_struct `dStruct` reaches targetD (Справочник F12).
 */
export function itemTimeLimit(targetD: number, dStruct: number): number {
  checkFinite('itemTimeLimit', targetD, dStruct);
  if (targetD < SHRINK_FROM_D) return ITEM_LIMIT_START_MS;
  const exact = BASE_ITEM_LIMIT_MS * 2 ** (-(targetD - dStruct) / D_PER_HALVING);
  const rounded = Math.round(exact / LIMIT_STEP_MS) * LIMIT_STEP_MS;
  return Math.min(ITEM_LIMIT_START_MS, Math.max(MIN_ITEM_LIMIT_MS, rounded));
}
