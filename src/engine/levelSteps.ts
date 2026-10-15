/** Trainer steps by level or rating (assessment spec §2.1). */

/** Rating at which diagnostic-format number series (mean D 1185) are solved with p ≈ 0.75. */
export const R_FORMAT = 1376;

const R_STEP_2 = 1100;
const R_STEP_WIDTH = 200;
const L_STEP_WIDTH = 5;

const STEP_NAMES = Object.freeze([
  'начальная',
  'на подходе к формату теста',
  'формат теста',
  'сверх нормы',
  'далеко сверх нормы',
] as const);

/** Names of steps 1–4; step 5 and above are «далеко сверх нормы». */
export function stepName(step: number): string {
  if (!Number.isInteger(step) || step < 1) throw new RangeError(`stepName: step ${String(step)} is not a whole number from 1`);
  return STEP_NAMES[(Math.min(step, STEP_NAMES.length) - 1) as 0 | 1 | 2 | 3 | 4];
}

export interface LevelStep {
  step: number;
  name: string;
  /** Lower bound of the next step. */
  nextStepL: number;
}

/** Step 1 below Lnorm/2, step 2 below Lnorm, then a step every 5 levels with no ceiling. */
export function levelStep(L: number, Lnorm: number): LevelStep {
  if (!Number.isFinite(Lnorm) || Lnorm <= 0) throw new RangeError(`levelStep: Lnorm ${String(Lnorm)} must be positive`);
  if (!Number.isFinite(L) || L < 0) throw new RangeError(`levelStep: L ${String(L)} must be a finite number ≥ 0`);
  if (L < Lnorm / 2) return { step: 1, name: stepName(1), nextStepL: Lnorm / 2 };
  if (L < Lnorm) return { step: 2, name: stepName(2), nextStepL: Lnorm };
  const step = 3 + Math.floor((L - Lnorm) / L_STEP_WIDTH);
  return { step, name: stepName(step), nextStepL: Lnorm + L_STEP_WIDTH * (step - 2) };
}

export interface RatingStep {
  step: number;
  name: string;
  /** Lower bound of the next step. */
  nextStepR: number;
}

/** Number series: step 1 below 1100, step 2 below R_FORMAT, then a step every 200 rating points. */
export function ratingStep(R: number): RatingStep {
  if (!Number.isFinite(R)) throw new RangeError(`ratingStep: R ${String(R)} is not a finite number`);
  if (R < R_STEP_2) return { step: 1, name: stepName(1), nextStepR: R_STEP_2 };
  const step = R < R_FORMAT ? 2 : 3 + Math.floor((R - R_FORMAT) / R_STEP_WIDTH);
  return { step, name: stepName(step), nextStepR: R_FORMAT + R_STEP_WIDTH * (step - 2) };
}
