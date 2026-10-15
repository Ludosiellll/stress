import { L_NORM } from '../../engine/planner';
import type { Stimulus, TrialSpec } from '../../engine/reaction/types';
import { createRng, deriveSeed } from '../../engine/rng';
import { blockLength, keysFor, ms, percent, singleKeyLabel, type ReactionModule } from './common';

export interface GoNoGoParams {
  windowMs: number;
  /** Share of no-go trials; count per block = round(noGoRatio · size) (R2). */
  noGoRatio: number;
  /** How similar the no-go is to the go, in steps: another colour, another shape, the same circle with a dot (F8). */
  noGoStimulus: 'green_circle' | 'red_square' | 'red_marked';
  isiMin: number;
  isiMax: number;
  /** The go is the green circle and the no-go takes the other colour (F8); training and free segments only. */
  swapped: boolean;
}

const BLOCK_SIZE = 20;

/** Share of training and free segments that play Go/No-Go with the colours swapped (F8). */
export const SWAP_SHARE = 0.3;

/** Whether segment `segmentIndex` of the plan with `planSeed` plays Go/No-Go with the colours swapped (F8). */
export function isSwappedSegment(planSeed: number, segmentIndex: number): boolean {
  return createRng(deriveSeed(planSeed, 'swap:' + String(segmentIndex))).next() < SWAP_SHARE;
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

/** «0,3–1,0 с»: the ISI range in seconds, one decimal. */
const isiRange = (p: GoNoGoParams): string => {
  const s = (x: number): string => (x / 1000).toFixed(1).replace('.', ',');
  return `${s(p.isiMin)}–${s(p.isiMax)} с`;
};

/**
 * Go/No-Go: press on the go circle, withhold on the no-go stimulus. The share of no-go stays at 15–20 % while the pace
 * quickens and the no-go grows more like the go (F8, spec §2.5).
 */
export const gonogo: ReactionModule<GoNoGoParams> = {
  id: 'gonogo',
  title: 'Go/No-Go',
  lNorm: L_NORM.gonogo,
  blockSize: BLOCK_SIZE,

  params(L) {
    const [isiMin, isiMax] = L < 8 ? [500, 2500] : L < 12 ? [400, 1800] : [300, 1000];
    return {
      windowMs: Math.round(150 + 850 * 0.9 ** L),
      noGoRatio: L < 8 ? 0.2 : 0.15,
      noGoStimulus: L < 16 ? 'green_circle' : L < 20 ? 'red_square' : 'red_marked',
      isiMin,
      isiMax,
      swapped: false,
    };
  },

  cvMax: 0.205,

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, BLOCK_SIZE);
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

  instruction: (layout, p) => {
    const noGo = coloursOf(p).noGoNames[p.noGoStimulus];
    const key = singleKeyLabel(layout);
    return p.swapped
      ? `В этом задании наоборот: на зелёный круг нажимай ${key}, на ${noGo} — ничего.`
      : `На красный круг нажимай ${key}. На ${noGo} не нажимай ничего.`;
  },

  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Интервал между сигналами', value: isiRange(p) },
    { label: 'Доля no-go', value: percent(p.noGoRatio) },
    { label: 'No-go', value: coloursOf(p).noGoNames[p.noGoStimulus] },
  ],
};
