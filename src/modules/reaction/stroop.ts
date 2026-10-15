import type { AudioStressorParams } from '../../engine/audio/stressors';
import { keyLabel } from '../../engine/layouts';
import type { VisualNoiseParams } from '../../engine/noise';
import { L_NORM } from '../../engine/planner';
import type { StroopColor, TrialSpec } from '../../engine/reaction/types';
import type { InputKey, LayoutId } from '../../engine/types';
import {
  COLOR_NAMES,
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
  maxFramed,
  ms,
  percent,
  stressorNotes,
  type ReactionModule,
} from './common';

/** Colours in key order: colour i → key i. */
export const STROOP_COLORS: readonly ['red', 'green', 'blue', 'yellow'] = ['red', 'green', 'blue', 'yellow'];

export interface StroopParams {
  /** The load band played (F3) and its label. */
  band: number;
  bandLabel: string;
  windowMs: number;
  trials: number;
  nColors: number;
  /** Share of trials whose word is not its ink; count per block = round(ratio · size). */
  incongruentRatio: number;
  /** The colour → key hint stays on screen during the block. */
  legend: boolean;
  isiMin: number;
  isiMax: number;
  /** The reverse rule (F3): runs of words in a white ring, answered by the word. */
  reverse: boolean;
  /** Figures around the word on every trial; null: none. */
  noise: VisualNoiseParams | null;
  /** Sound on every trial; null: none. */
  audio: AudioStressorParams | null;
}

/** W2-R5: 20 trials (spec §6.2: 10–20). */
const BLOCK_SIZE = 20;

const REVERSE = '4 цвета, интервал 0,3–1,2 с, обратное правило в рамке';

/** The Струп ladder (spec §3.1.3): band 2 is the test format. The incongruent share stays smooth with L. */
const BANDS = ladder([
  ['2 цвета, подсказка клавиш', 1],
  ['3 цвета, подсказка клавиш', 1.1],
  ['4 цвета без подсказки', 1.1],
  ['4 цвета, интервал 0,3–1,2 с', 1],
  [REVERSE, 1.1],
  [`${REVERSE}, звук`, 1.05],
  [`${REVERSE}, звук, помехи`, 1.05],
  [`${REVERSE}, звук, помехи, 30 сигналов`, 1],
  [`${REVERSE}, звук, помехи, 45 сигналов`, 1],
  [`${REVERSE}, звук, помехи, 60 сигналов`, 1],
]);

/** Far noise takes no ink colour and no circle (Р12): the words keep their colours to themselves. */
const INKS = STROOP_COLORS.map((color) => ({ shape: 'circle', color }) as const);

/** The active colours with their keys, in key order. */
function colorKeys(layout: LayoutId, nColors: number): { color: StroopColor; key: InputKey }[] {
  const keys = keysFor(layout, nColors);
  return STROOP_COLORS.slice(0, nColors).map((color, i) => ({ color, key: keys[i] as InputKey }));
}

/** Trials of a block of n whose word is not its ink: round(ratio · n), the rest congruent. */
const incongruentCount = (p: StroopParams, n: number): number => Math.round(p.incongruentRatio * n);

/** «красный — F», «зелёный — J», … */
const pairs = (layout: LayoutId, nColors: number): string[] =>
  colorKeys(layout, nColors).map(({ color, key }) => `${COLOR_NAMES[color]} — ${keyLabel(key)}`);

/**
 * Струп: a colour word printed in a colour; answer by the ink, not by the word. With the reverse rule (F3) words in a
 * white ring come in runs and are answered by the word; they carry no condition, so the interference is measured on
 * the other trials as before.
 */
export const stroop: ReactionModule<StroopParams> = {
  id: 'stroop',
  title: 'Струп',
  lNorm: L_NORM.stroop,
  blockSize: BLOCK_SIZE,
  bands: BANDS,

  params(L, loadBand) {
    const b = loadBandOf(BANDS, L, loadBand);
    const fast = b >= 3;
    return {
      ...bandFields(BANDS, b, Math.round(150 + 1850 * 0.92 ** L)),
      trials: longBlockTrials(b, 7, BLOCK_SIZE),
      nColors: b === 0 ? 2 : b === 1 ? 3 : 4,
      incongruentRatio: Math.min(0.75, 0.5 + 0.02 * L),
      legend: b < 2,
      isiMin: fast ? 300 : 500,
      isiMax: fast ? 1200 : 2000,
      reverse: b >= 4,
      noise: b >= 6 ? farNoise(INKS) : null,
      audio: b >= 5 ? bandSound() : null,
    };
  },

  trials: (p) => p.trials,

  cvMax: 0.235,

  /**
   * The block keeps round(ratio · n) mismatched words. With the reverse rule the framed runs take them first (a
   * matching word in a ring tests nothing) and the rest go to the plain trials; without it the draws are those of 0.2.0.
   */
  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, p.trials);
    const active = colorKeys(layout, p.nColors);
    const framed = p.reverse ? framedRuns(n, rng) : Array<boolean>(n).fill(false);
    const nFramed = framed.filter(Boolean).length;
    const count = incongruentCount(p, n);
    const framedCount = Math.min(count, nFramed);
    const plain = rng.shuffle(Array.from({ length: n - nFramed }, (_, i) => i < count - framedCount));
    const inRing = p.reverse ? rng.shuffle(Array.from({ length: nFramed }, (_, i) => i < framedCount)) : [];
    return framed.map((isFramed): TrialSpec => {
      const isIncongruent = (isFramed ? inRing.shift() : plain.shift()) === true;
      const isiMs = rng.int(p.isiMin, p.isiMax);
      const { color: ink, key } = rng.pick(active);
      const word = isIncongruent ? rng.pick(active.filter((c) => c.color !== ink)).color : ink;
      if (isFramed) {
        const byWord = (active.find((c) => c.color === word) as { key: InputKey }).key;
        return { isiMs, windowMs: p.windowMs, stimulus: { kind: 'word', word, ink, frame: 'white' }, expected: { kind: 'press', key: byWord } };
      }
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

  stressors: everyTrial,

  /** Worst case: the most framed trials a block can get (maxFramed), filled with mismatched words first. */
  minCondTrials(p, size) {
    const incongruent = incongruentCount(p, size);
    const framed = p.reverse ? maxFramed(size) : 0;
    const framedIncongruent = Math.min(incongruent, framed);
    return Math.min(incongruent - framedIncongruent, size - incongruent - (framed - framedIncongruent));
  },

  legend: (layout, p) => (p.legend ? pairs(layout, p.nColors).join(' · ') : null),

  instruction: (layout, p, overload = false) =>
    `Отвечай по цвету букв, а не по слову: ${pairs(layout, p.nColors).join(', ')}.` +
    (p.reverse ? ' Слово в белой рамке — наоборот: отвечай по слову.' : '') +
    (p.legend ? ' Подсказка клавиш — внизу экрана.' : '') +
    stressorNotes(p, overload) +
    fallbackNote(layout, p.nColors),

  /** The colours, the key hint, the interval and the reverse rule are in the band label (Р14). */
  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Нагрузка', value: p.bandLabel },
    { label: 'Доля несовпадений', value: percent(p.incongruentRatio) },
  ],
};
