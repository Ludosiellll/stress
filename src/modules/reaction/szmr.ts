import { keyLabel } from '../../engine/layouts';
import { L_NORM } from '../../engine/planner';
import type { Rng } from '../../engine/rng';
import type { ColorId, ShapeId, TrialSpec } from '../../engine/reaction/types';
import type { InputKey } from '../../engine/types';
import {
  COLORS,
  COLOR_NAMES,
  ISI_MAX,
  ISI_MIN,
  SHAPES,
  blockLength,
  fallbackNote,
  keysFor,
  ms,
  yesNo,
  type ReactionModule,
} from './common';

export interface SzmrParams {
  windowMs: number;
  nColors: number;
  nKeys: number;
  /** Random shape that has to be ignored. */
  shapeDistractor: boolean;
  /** Color → key mapping flips on alternating segments (marked with a white frame). */
  inversion: boolean;
}

const BLOCK_SIZE = 20;

/** [nColors, nKeys] for a level. */
function band(L: number): [number, number] {
  if (L >= 32) return [6, 6];
  if (L >= 24) return [5, 5];
  if (L >= 16) return [4, 4];
  if (L >= 8) return [3, 2];
  return [2, 2];
}

/**
 * Key index for color index c without inversion. Equal counts map one-to-one;
 * the 3 colors / 2 keys band maps red and yellow → 0, green → 1, which is c mod nKeys.
 */
function normalKeyIndex(c: number, nKeys: number): number {
  return c % nKeys;
}

/** Per-trial inversion flags: segments of rng.int(8, 15) trials, alternating, starting normal. */
function inversionFlags(n: number, rng: Rng): boolean[] {
  const flags: boolean[] = [];
  let inverted = false;
  while (flags.length < n) {
    const len = rng.int(8, 15);
    for (let i = 0; i < len && flags.length < n; i++) flags.push(inverted);
    inverted = !inverted;
  }
  return flags;
}

/**
 * Color → key part of the instruction. Colors sharing a key are grouped («красный и жёлтый — F»)
 * and introduced differently, so the text never claims one key per color when that is false.
 */
function colorKeyRule(keys: readonly InputKey[], nColors: number): string {
  const groups = keys.map((key, k) => ({
    key,
    names: COLORS.slice(0, nColors)
      .filter((_, c) => normalKeyIndex(c, keys.length) === k)
      .map((color) => COLOR_NAMES[color]),
  }));
  const list = groups.map((g) => `${g.names.join(' и ')} — ${keyLabel(g.key)}`).join(', ');
  return groups.some((g) => g.names.length > 1)
    ? `Нажимай клавишу по цвету: ${list}. Отвечай как можно быстрее.`
    : `Каждому цвету соответствует своя клавиша: ${list}. Нажимай нужную как можно быстрее.`;
}

/** СЗМР: choice reaction, each color has its key. */
export const szmr: ReactionModule<SzmrParams> = {
  id: 'szmr',
  title: 'Сложная реакция (СЗМР)',
  lNorm: L_NORM.szmr,
  blockSize: BLOCK_SIZE,

  params(L) {
    const [nColors, nKeys] = band(L);
    return {
      windowMs: Math.round(150 + 1350 * 0.92 ** L),
      nColors,
      nKeys,
      shapeDistractor: L >= 20,
      inversion: L >= 32,
    };
  },

  cvMax: 0.22,

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, BLOCK_SIZE);
    const keys = keysFor(layout, p.nKeys);
    const colors = COLORS.slice(0, p.nColors);
    const inverted = p.inversion ? inversionFlags(n, rng) : Array<boolean>(n).fill(false);
    return inverted.map((inv): TrialSpec => {
      const isiMs = rng.int(ISI_MIN, ISI_MAX);
      const c = rng.int(0, colors.length - 1);
      const color = colors[c] as ColorId;
      const shape: ShapeId = p.shapeDistractor ? rng.pick(SHAPES) : 'circle';
      const normal = normalKeyIndex(c, p.nKeys);
      const key = keys[inv ? p.nKeys - 1 - normal : normal] as InputKey;
      return {
        isiMs,
        windowMs: p.windowMs,
        stimulus: inv ? { kind: 'shape', shape, color, frame: 'white' } : { kind: 'shape', shape, color },
        expected: { kind: 'press', key },
      };
    });
  },

  keyCount: (p) => p.nKeys,

  instruction(layout, p) {
    return (
      colorKeyRule(keysFor(layout, p.nKeys), p.nColors) +
      (p.shapeDistractor ? ' Форму фигуры не учитывай.' : '') +
      (p.inversion ? ' Белая рамка — правило перевёрнуто.' : '') +
      fallbackNote(layout, p.nKeys)
    );
  },

  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Цветов', value: String(p.nColors) },
    { label: 'Клавиш', value: String(p.nKeys) },
    { label: 'Отвлекающая форма', value: yesNo(p.shapeDistractor) },
    { label: 'Инверсия правил', value: yesNo(p.inversion) },
  ],
};
