import type { AudioStressorParams } from '../../engine/audio/stressors';
import { keyLabel } from '../../engine/layouts';
import type { VisualNoiseParams } from '../../engine/noise';
import { L_NORM } from '../../engine/planner';
import type { ColorId, ShapeId, TrialSpec } from '../../engine/reaction/types';
import type { InputKey } from '../../engine/types';
import {
  COLORS,
  COLOR_NAMES,
  ISI_MAX,
  ISI_MIN,
  SHAPES,
  bandFields,
  bandSound,
  blockLength,
  everyTrial,
  fallbackNote,
  farNoise,
  framedRuns,
  keysFor,
  ladder,
  loadBandOf,
  longBlockTrials,
  ms,
  stressorNotes,
  type ReactionModule,
} from './common';

export interface SzmrParams {
  /** The load band played (F3) and its label. */
  band: number;
  bandLabel: string;
  windowMs: number;
  trials: number;
  nColors: number;
  nKeys: number;
  /** Random shape that has to be ignored. */
  shapeDistractor: boolean;
  /** Color → key mapping flips on alternating segments (marked with a white frame). */
  inversion: boolean;
  /** Figures around the centre on every trial; null: none. */
  noise: VisualNoiseParams | null;
  /** Sound on every trial; null: none. */
  audio: AudioStressorParams | null;
}

const BLOCK_SIZE = 20;

const NOISY = '6 цветов на 6 клавиш, форма, инверсия, звук, помехи';

/** The СЗМР ladder (spec §3.1.3): bands 0–1 are the test format, 2 colours on 2 keys (isTwoChoice). */
const BANDS = ladder([
  ['2 цвета на 2 клавиши', 1],
  ['2 цвета на 2 клавиши', 1],
  ['3 цвета на 2 клавиши', 1.1],
  ['4 цвета на 4 клавиши', 1.1],
  ['4 цвета на 4 клавиши, отвлекающая форма', 1.05],
  ['5 цветов на 5 клавиш, отвлекающая форма', 1.1],
  ['6 цветов на 6 клавиш, отвлекающая форма', 1.1],
  ['6 цветов на 6 клавиш, форма, инверсия', 1.1],
  ['6 цветов на 6 клавиш, форма, инверсия, звук', 1.05],
  [NOISY, 1.05],
  [`${NOISY}, 30 сигналов`, 1],
  [`${NOISY}, 45 сигналов`, 1],
  [`${NOISY}, 60 сигналов`, 1],
]);

/** [nColors, nKeys] of a band. */
function colorsAndKeys(b: number): [number, number] {
  if (b >= 6) return [6, 6];
  if (b === 5) return [5, 5];
  if (b >= 3) return [4, 4];
  if (b === 2) return [3, 2];
  return [2, 2];
}

/** Far noise from band 9: no figure takes an active colour, so with six colours they are grey (Р13). */
function noiseAt(b: number, nColors: number): VisualNoiseParams | null {
  if (b < 9) return null;
  return farNoise(COLORS.slice(0, nColors).flatMap((color) => SHAPES.map((shape) => ({ shape, color }))));
}

/**
 * Key index for color index c without inversion. Equal counts map one-to-one;
 * the 3 colors / 2 keys band maps red and yellow → 0, green → 1, which is c mod nKeys.
 */
function normalKeyIndex(c: number, nKeys: number): number {
  return c % nKeys;
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
  bands: BANDS,

  params(L, loadBand) {
    const b = loadBandOf(BANDS, L, loadBand);
    const [nColors, nKeys] = colorsAndKeys(b);
    return {
      ...bandFields(BANDS, b, Math.round(150 + 1350 * 0.84 ** L)),
      trials: longBlockTrials(b, 10, BLOCK_SIZE),
      nColors,
      nKeys,
      shapeDistractor: b >= 4,
      inversion: b >= 7,
      noise: noiseAt(b, nColors),
      audio: b >= 8 ? bandSound() : null,
    };
  },

  trials: (p) => p.trials,

  cvMax: 0.22,

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, p.trials);
    const keys = keysFor(layout, p.nKeys);
    const colors = COLORS.slice(0, p.nColors);
    const inverted = p.inversion ? framedRuns(n, rng) : Array<boolean>(n).fill(false);
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

  stressors: everyTrial,

  instruction(layout, p, overload = false) {
    return (
      colorKeyRule(keysFor(layout, p.nKeys), p.nColors) +
      (p.shapeDistractor ? ' Форму фигуры не учитывай.' : '') +
      (p.inversion ? ' Белая рамка — правило перевёрнуто.' : '') +
      stressorNotes(p, overload) +
      fallbackNote(layout, p.nKeys)
    );
  },

  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Нагрузка', value: p.bandLabel },
  ],
};
