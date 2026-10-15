import type { AudioStressorParams } from '../../engine/audio/stressors';
import type { VisualNoiseParams } from '../../engine/noise';
import { L_NORM } from '../../engine/planner';
import type { Stimulus, TrialSpec } from '../../engine/reaction/types';
import { createRng, deriveSeed } from '../../engine/rng';
import {
  bandFields,
  bandSound,
  blockLength,
  everyTrial,
  farNoise,
  keysFor,
  ladder,
  loadBandOf,
  longBlockTrials,
  ms,
  singleKeyLabel,
  stressorNotes,
  type ReactionModule,
} from './common';

export interface GoNoGoParams {
  /** The load band played (F3) and its label (with the colours of the block: swapColours). */
  band: number;
  bandLabel: string;
  windowMs: number;
  trials: number;
  /** Share of no-go trials; count per block = round(noGoRatio · size) (R2). */
  noGoRatio: number;
  /** How similar the no-go is to the go, in steps: another colour, another shape, the same circle with a dot (F8). */
  noGoStimulus: 'green_circle' | 'red_square' | 'red_marked';
  isiMin: number;
  isiMax: number;
  /** The go is the green circle and the no-go takes the other colour (F8); training and free segments only. */
  swapped: boolean;
  /** Figures around the centre on every trial; null: none. */
  noise: VisualNoiseParams | null;
  /** Sound on every trial; null: none. */
  audio: AudioStressorParams | null;
}

const BLOCK_SIZE = 20;

const SQUARE_BAND = 4;
const NOISY = 'no-go — круг с белой точкой, интервал 0,3–1 с, звук, помехи';

/** The Go/No-Go ladder (spec §3.1.3); bands 0–5 are the F8 table, bands 0–1 the test format. */
const BANDS = ladder([
  ['no-go 20 %, интервал 0,5–2,5 с', 1],
  ['no-go 20 %, интервал 0,5–2,5 с', 1],
  ['no-go 15 %, интервал 0,4–1,8 с', 1],
  ['no-go 15 %, интервал 0,3–1 с', 1],
  ['no-go — красный квадрат, интервал 0,3–1 с', 1.05],
  ['no-go — круг с белой точкой, интервал 0,3–1 с', 1.05],
  ['no-go — круг с белой точкой, интервал 0,3–1 с, звук', 1.05],
  [NOISY, 1.05],
  [`${NOISY}, 30 сигналов`, 1],
  [`${NOISY}, 45 сигналов`, 1],
  [`${NOISY}, 60 сигналов`, 1],
]);

/** The only label that names a colour: the square band's, as a swapped segment plays it. */
const SWAPPED_SQUARE_LABEL = 'no-go — зелёный квадрат, интервал 0,3–1 с';

/** Every stimulus a segment may show, swapped or not: far noise takes none of their colours (Р12). */
const TARGETS = [
  { shape: 'circle', color: 'red' },
  { shape: 'circle', color: 'green' },
  { shape: 'square', color: 'red' },
  { shape: 'square', color: 'green' },
] as const;

/** Share of training and free segments that play Go/No-Go with the colours swapped (F8). */
export const SWAP_SHARE = 0.3;

/** Whether segment `segmentIndex` of the plan with `planSeed` plays Go/No-Go with the colours swapped (F8). */
export function isSwappedSegment(planSeed: number, segmentIndex: number): boolean {
  return createRng(deriveSeed(planSeed, 'swap:' + String(segmentIndex))).next() < SWAP_SHARE;
}

/** The parameters with the colours swapped (F8): the band label names the swapped no-go too (T-R41). */
export function swapColours(p: GoNoGoParams): GoNoGoParams {
  return { ...p, swapped: true, bandLabel: p.band === SQUARE_BAND ? SWAPPED_SQUARE_LABEL : p.bandLabel };
}

type NoGoStimulus = GoNoGoParams['noGoStimulus'];

/** The go and the no-go stimuli, and the names the instruction and the parameter list give the no-go. */
interface Colours {
  go: Stimulus;
  noGo: Readonly<Record<NoGoStimulus, Stimulus>>;
  noGoNames: Readonly<Record<NoGoStimulus, string>>;
}

const PLAIN: Colours = {
  go: { kind: 'shape', shape: 'circle', color: 'red' },
  noGo: {
    green_circle: { kind: 'shape', shape: 'circle', color: 'green' },
    red_square: { kind: 'shape', shape: 'square', color: 'red' },
    red_marked: { kind: 'shape', shape: 'circle', color: 'red', mark: true },
  },
  noGoNames: { green_circle: 'зелёный круг', red_square: 'красный квадрат', red_marked: 'красный круг с белой точкой' },
};

const SWAPPED: Colours = {
  go: { kind: 'shape', shape: 'circle', color: 'green' },
  noGo: {
    green_circle: { kind: 'shape', shape: 'circle', color: 'red' },
    red_square: { kind: 'shape', shape: 'square', color: 'green' },
    red_marked: { kind: 'shape', shape: 'circle', color: 'green', mark: true },
  },
  noGoNames: { green_circle: 'красный круг', red_square: 'зелёный квадрат', red_marked: 'зелёный круг с белой точкой' },
};

const coloursOf = (p: GoNoGoParams): Colours => (p.swapped ? SWAPPED : PLAIN);

/**
 * Go/No-Go: press on the go circle, withhold on the no-go stimulus. The share of no-go stays at 15–20 % while the pace
 * quickens and the no-go grows more like the go (F8, spec §2.5), then sound, noise and longer blocks (F3).
 */
export const gonogo: ReactionModule<GoNoGoParams> = {
  id: 'gonogo',
  title: 'Go/No-Go',
  lNorm: L_NORM.gonogo,
  blockSize: BLOCK_SIZE,
  bands: BANDS,

  params(L, loadBand) {
    const b = loadBandOf(BANDS, L, loadBand);
    const [isiMin, isiMax] = b < 2 ? [500, 2500] : b === 2 ? [400, 1800] : [300, 1000];
    return {
      ...bandFields(BANDS, b, Math.round(150 + 850 * 0.845 ** L)),
      trials: longBlockTrials(b, 8, BLOCK_SIZE),
      noGoRatio: b < 2 ? 0.2 : 0.15,
      noGoStimulus: b < SQUARE_BAND ? 'green_circle' : b === SQUARE_BAND ? 'red_square' : 'red_marked',
      isiMin,
      isiMax,
      swapped: false,
      noise: b >= 7 ? farNoise(TARGETS) : null,
      audio: b >= 6 ? bandSound() : null,
    };
  },

  trials: (p) => p.trials,

  cvMax: 0.205,

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, p.trials);
    const [key] = keysFor(layout, 1) as [string];
    const { go, noGo } = coloursOf(p);
    const noGoCount = Math.round(p.noGoRatio * n);
    const isNoGo = rng.shuffle(Array.from({ length: n }, (_, i) => i < noGoCount));
    return isNoGo.map(
      (withhold): TrialSpec => ({
        isiMs: rng.int(p.isiMin, p.isiMax),
        windowMs: p.windowMs,
        stimulus: { ...(withhold ? noGo[p.noGoStimulus] : go) },
        expected: withhold ? { kind: 'withhold' } : { kind: 'press', key },
      }),
    );
  },

  keyCount: () => 1,

  stressors: everyTrial,

  instruction: (layout, p, overload = false) => {
    const noGo = coloursOf(p).noGoNames[p.noGoStimulus];
    const key = singleKeyLabel(layout);
    const rule = p.swapped
      ? `В этом задании наоборот: на зелёный круг нажимай ${key}, на ${noGo} — ничего.`
      : `На красный круг нажимай ${key}. На ${noGo} не нажимай ничего.`;
    return rule + stressorNotes(p, overload);
  },

  /** The interval, the no-go share and the no-go stimulus are in the band label (Р14). */
  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Нагрузка', value: p.bandLabel },
  ],
};
