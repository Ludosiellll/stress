import type { AudioStressorParams } from '../../engine/audio/stressors';
import { keyLabel, layoutKeys } from '../../engine/layouts';
import type { VisualNoiseParams } from '../../engine/noise';
import { COLOR_IDS, SHAPE_IDS, type ColorId, type ShapeId, type TrialSpec } from '../../engine/reaction/types';
import type { Rng } from '../../engine/rng';
import type { InputKey, LayoutId, ReactionModuleId } from '../../engine/types';

export interface ReactionModule<P> {
  id: ReactionModuleId;
  title: string;
  /**
   * `overload`: an overload block, whose prefix announces the sound on every trial, so the module leaves out its own
   * sound line (M2). Method syntax (bivariant in P) so a ReactionModule<XParams> fits the registry's ReactionModule<unknown>.
   */
  instruction(layout: LayoutId, p: P, overload?: boolean): string;
  lNorm: number;
  blockSize: number;
  params(L: number): P;
  /**
   * The CV_all limit of the stability rule (F2): above it ΔL is capped at +0.5. The same at every level (spec §2.2);
   * null: no rule (РДО).
   */
  cvMax: number | null;
  generateBlock(p: P, rng: Rng, layout: LayoutId, size?: number): TrialSpec[];
  /** Keys a block at these parameters needs (layoutKeys(layout, keyCount(p))). */
  keyCount(p: P): number;
  /** Key hint shown under the stimulus during the block, e.g. «красный — F · зелёный — J»; null or absent: none. */
  legend?(layout: LayoutId, p: P): string | null;
  /** Russian labels for the "what changed" view. */
  describeParams(p: P): Array<{ label: string; value: string }>;
  /** Visual noise and sound of a block at these parameters; absent: none (read it with stressorsOf). */
  stressors?(p: P): BlockStressors;
  /**
   * Modules with trial conditions (COND_PAIRS): the fewest trials one condition can get in a block of `size` at
   * these parameters, whatever the seed. The e2e scale sizes such blocks by it (W2-R30).
   */
  minCondTrials?(p: P, size: number): number;
}

/** What plays around the stimuli of a reaction block. */
export interface BlockStressors {
  /** Distractors (and flicker) around the centre, on `noisy` trials only, whatever the gate (W2-R10). */
  noise: VisualNoiseParams | null;
  /** Sound loop in the headphones. */
  audio: AudioStressorParams | null;
  /** Trials the sound plays on: every trial, or the `noisy` ones. */
  gate: 'all' | 'noisy';
}

export const NO_STRESSORS: BlockStressors = Object.freeze({ noise: null, audio: null, gate: 'all' });

/** The module's stressors at these parameters; NO_STRESSORS for a module without any. */
export function stressorsOf<P>(m: ReactionModule<P>, p: P): BlockStressors {
  return m.stressors?.(p) ?? NO_STRESSORS;
}

/** Stimulus colors in the order the color → key mapping uses. */
export const COLORS: readonly ColorId[] = COLOR_IDS;
export const SHAPES: readonly ShapeId[] = SHAPE_IDS;

export const COLOR_NAMES: Readonly<Record<ColorId, string>> = {
  red: 'красный',
  green: 'зелёный',
  yellow: 'жёлтый',
  blue: 'синий',
  white: 'белый',
  purple: 'фиолетовый',
};

/** ISI range shared by ПЗМР (L < 25), СЗМР and Помехоустойчивость; Go/No-Go starts from it and speeds up (F8). */
export const ISI_MIN = 500;
export const ISI_MAX = 2500;

export function blockLength(size: number | undefined, blockSize: number): number {
  const n = size ?? blockSize;
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`block size must be a positive integer, got ${String(n)}`);
  }
  return n;
}

export function keysFor(layout: LayoutId, n: number): InputKey[] {
  return layoutKeys(layout, n).keys;
}

/** The single-key label, e.g. «Пробел». */
export function singleKeyLabel(layout: LayoutId): string {
  return keyLabel(keysFor(layout, 1)[0] as InputKey);
}

/** « Для этого уровня нужны клавиши: …» when the layout cannot serve n keys, otherwise ''. */
export function fallbackNote(layout: LayoutId, n: number): string {
  const { keys, effectiveLayout } = layoutKeys(layout, n);
  if (effectiveLayout === layout) return '';
  return ` Для этого уровня нужны клавиши: ${keys.map(keyLabel).join(', ')}.`;
}

export const ms = (v: number): string => `${String(v)} мс`;
export const percent = (ratio: number): string => `${String(Math.round(ratio * 100))} %`;
export const yesNo = (b: boolean): string => (b ? 'да' : 'нет');
