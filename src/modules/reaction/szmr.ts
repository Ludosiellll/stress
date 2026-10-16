import type { AudioStressorParams } from '../../engine/audio/stressors';
import { keyLabel } from '../../engine/layouts';
import type { VisualNoiseParams } from '../../engine/noise';
import { L_NORM } from '../../engine/planner';
import type { ColorId, ShapeId, TrialSpec } from '../../engine/reaction/types';
import { createRng } from '../../engine/rng';
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
  keyNumbers,
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
  /**
   * The key of each active colour, in colour order (Р26); null: canonical, c mod nKeys (red and yellow share key 0 in
   * the 3-on-2 band). A training or free segment draws its own (withMapping, F9).
   */
  mapping: number[] | null;
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
 * Key index for color index c without inversion: the segment's mapping, or the canonical c mod nKeys (equal counts map
 * one-to-one; the 3 colors / 2 keys band maps red and yellow → 0, green → 1).
 */
function normalKeyIndex(p: Pick<SzmrParams, 'mapping' | 'nKeys'>, c: number): number {
  return p.mapping?.[c] ?? c % p.nKeys;
}

/**
 * Color → key part of the instruction, key by key in the layout's order. Colors sharing a key are grouped («красный и
 * жёлтый — F») and introduced differently, so the text never claims one key per color when that is false.
 */
function colorKeyRule(keys: readonly InputKey[], p: SzmrParams): string {
  const groups = keys.map((key, k) => ({
    key,
    names: COLORS.slice(0, p.nColors)
      .filter((_, c) => normalKeyIndex(p, c) === k)
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
      mapping: null,
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
      const normal = normalKeyIndex(p, c);
      const key = keys[inv ? p.nKeys - 1 - normal : normal] as InputKey;
      return {
        isiMs,
        windowMs: p.windowMs,
        stimulus: inv ? { kind: 'shape', shape, color, frame: 'white' } : { kind: 'shape', shape, color },
        expected: { kind: 'press', key },
      };
    });
  },

  /**
   * n colours on n keys: rng.shuffle of the key numbers. 3 colours on 2 keys: rng.int(0, 2) picks the colour alone on
   * its key, rng.int(0, 1) the key the other two share (6 groupings). The inversion flips this mapping (generateBlock).
   */
  withMapping(p, seed) {
    const rng = createRng(seed);
    if (p.nColors === p.nKeys) return { ...p, mapping: rng.shuffle(keyNumbers(p.nKeys)) };
    const alone = rng.int(0, p.nColors - 1);
    const shared = rng.int(0, 1);
    return { ...p, mapping: keyNumbers(p.nColors).map((c) => (c === alone ? 1 - shared : shared)) };
  },

  keyCount: (p) => p.nKeys,

  stressors: everyTrial,

  instruction(layout, p, overload = false) {
    return (
      colorKeyRule(keysFor(layout, p.nKeys), p) +
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
