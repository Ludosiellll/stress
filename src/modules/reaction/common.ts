import { keyLabel, layoutKeys } from '../../engine/layouts';
import type { ColorId, ShapeId, TrialSpec } from '../../engine/reaction/types';
import type { Rng } from '../../engine/rng';
import type { InputKey, LayoutId, ReactionModuleId } from '../../engine/types';

export interface ReactionModule<P> {
  id: ReactionModuleId;
  title: string;
  // Method syntax (bivariant in P) so a ReactionModule<XParams> fits the registry's ReactionModule<unknown>.
  instruction(layout: LayoutId, p: P): string;
  lNorm: number;
  blockSize: number;
  params(L: number): P;
  cvMax(L: number): number | null;
  generateBlock(p: P, rng: Rng, layout: LayoutId, size?: number): TrialSpec[];
  /** Keys a block at these parameters needs (layoutKeys(layout, keyCount(p))). */
  keyCount(p: P): number;
  /** Key hint shown under the stimulus during the block, e.g. «красный — F · зелёный — J»; null or absent: none. */
  legend?(layout: LayoutId, p: P): string | null;
  /** Russian labels for the "what changed" view. */
  describeParams(p: P): Array<{ label: string; value: string }>;
}

/** Stimulus colors in the order the color → key mapping uses. */
export const COLORS: readonly ColorId[] = ['red', 'green', 'yellow', 'blue', 'white', 'purple'];
export const SHAPES: readonly ShapeId[] = ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'star'];

export const COLOR_NAMES: Readonly<Record<ColorId, string>> = {
  red: 'красный',
  green: 'зелёный',
  yellow: 'жёлтый',
  blue: 'синий',
  white: 'белый',
  purple: 'фиолетовый',
};

/** ISI range shared by ПЗМР (L < 25), СЗМР and Go/No-Go. */
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
