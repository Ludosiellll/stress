import { keyLabel } from '../../engine/layouts';
import { L_NORM } from '../../engine/planner';
import type { StroopColor, TrialSpec } from '../../engine/reaction/types';
import type { InputKey, LayoutId } from '../../engine/types';
import { COLOR_NAMES, blockLength, fallbackNote, keysFor, ms, percent, yesNo, type ReactionModule } from './common';

/** Colours in key order: colour i → key i. */
export const STROOP_COLORS: readonly ['red', 'green', 'blue', 'yellow'] = ['red', 'green', 'blue', 'yellow'];

export const COLOR_WORDS: Readonly<Record<StroopColor, string>> = {
  red: 'КРАСНЫЙ',
  green: 'ЗЕЛЁНЫЙ',
  blue: 'СИНИЙ',
  yellow: 'ЖЁЛТЫЙ',
};

export interface StroopParams {
  windowMs: number;
  nColors: number;
  /** Share of incongruent trials; count per block = round(ratio · size). */
  incongruentRatio: number;
  /** The colour → key hint stays on screen during the block. */
  legend: boolean;
  isiMin: number;
  isiMax: number;
}

/** W2-R5: 20 trials (spec §6.2: 10–20). */
const BLOCK_SIZE = 20;

function colorCount(L: number): number {
  if (L >= 16) return 4;
  if (L >= 8) return 3;
  return 2;
}

/** The active colours with their keys, in key order. */
function colorKeys(layout: LayoutId, nColors: number): { color: StroopColor; key: InputKey }[] {
  const keys = keysFor(layout, nColors);
  return STROOP_COLORS.slice(0, nColors).map((color, i) => ({ color, key: keys[i] as InputKey }));
}

/** «красный — F», «зелёный — J», … */
const pairs = (layout: LayoutId, nColors: number): string[] =>
  colorKeys(layout, nColors).map(({ color, key }) => `${COLOR_NAMES[color]} — ${keyLabel(key)}`);

/** Струп: a colour word printed in a colour; answer by the ink, not by the word. */
export const stroop: ReactionModule<StroopParams> = {
  id: 'stroop',
  title: 'Струп',
  lNorm: L_NORM.stroop,
  blockSize: BLOCK_SIZE,

  params: (L) => ({
    windowMs: Math.round(150 + 1850 * 0.92 ** L),
    nColors: colorCount(L),
    incongruentRatio: Math.min(0.75, 0.5 + 0.02 * L),
    legend: L < 12,
    isiMin: 500,
    isiMax: 2000,
  }),

  cvMax: () => null,

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, BLOCK_SIZE);
    const active = colorKeys(layout, p.nColors);
    const incongruentCount = Math.round(p.incongruentRatio * n);
    const incongruent = rng.shuffle(Array.from({ length: n }, (_, i) => i < incongruentCount));
    return incongruent.map((isIncongruent): TrialSpec => {
      const isiMs = rng.int(p.isiMin, p.isiMax);
      const { color: ink, key } = rng.pick(active);
      const word = isIncongruent ? rng.pick(active.filter((c) => c.color !== ink)).color : ink;
      return {
        isiMs,
        windowMs: p.windowMs,
        stimulus: { kind: 'word', word, ink },
        expected: { kind: 'press', key },
        cond: isIncongruent ? 'incongruent' : 'congruent',
      };
    });
  },

  keyCount: (p) => p.nColors,

  legend: (layout, p) => (p.legend ? pairs(layout, p.nColors).join(' · ') : null),

  instruction: (layout, p) =>
    `Отвечай по цвету букв, а не по слову: ${pairs(layout, p.nColors).join(', ')}.` +
    (p.legend ? ' Подсказка клавиш — внизу экрана.' : '') +
    fallbackNote(layout, p.nColors),

  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Цветов', value: String(p.nColors) },
    { label: 'Доля несовпадений', value: percent(p.incongruentRatio) },
    { label: 'Подсказка клавиш', value: yesNo(p.legend) },
  ],
};
