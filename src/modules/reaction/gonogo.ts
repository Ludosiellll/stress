import { L_NORM } from '../../engine/planner';
import type { Stimulus, TrialSpec } from '../../engine/reaction/types';
import { ISI_MAX, ISI_MIN, blockLength, keysFor, ms, percent, singleKeyLabel, type ReactionModule } from './common';

export interface GoNoGoParams {
  windowMs: number;
  /** Share of no-go trials; count per block = round(noGoRatio · size) (R2). */
  noGoRatio: number;
  noGoStimulus: 'green_circle' | 'red_square';
}

const BLOCK_SIZE = 20;

const GO: Stimulus = { kind: 'shape', shape: 'circle', color: 'red' };
const NO_GO: Record<GoNoGoParams['noGoStimulus'], Stimulus> = {
  green_circle: { kind: 'shape', shape: 'circle', color: 'green' },
  red_square: { kind: 'shape', shape: 'square', color: 'red' },
};
const NO_GO_NAMES: Record<GoNoGoParams['noGoStimulus'], string> = {
  green_circle: 'зелёный круг',
  red_square: 'красный квадрат',
};

/** Go/No-Go: press on the red circle, withhold on the no-go stimulus. */
export const gonogo: ReactionModule<GoNoGoParams> = {
  id: 'gonogo',
  title: 'Go/No-Go',
  lNorm: L_NORM.gonogo,
  blockSize: BLOCK_SIZE,

  params: (L) => ({
    windowMs: Math.round(150 + 850 * 0.9 ** L),
    noGoRatio: Math.min(0.35, 0.1 + 0.01 * L),
    noGoStimulus: L >= 20 ? 'red_square' : 'green_circle',
  }),

  cvMax: (L) => Math.max(0.15, 0.3 - 0.005 * L),

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, BLOCK_SIZE);
    const [key] = keysFor(layout, 1) as [string];
    const noGoCount = Math.round(p.noGoRatio * n);
    const isNoGo = rng.shuffle(Array.from({ length: n }, (_, i) => i < noGoCount));
    return isNoGo.map(
      (noGo): TrialSpec => ({
        isiMs: rng.int(ISI_MIN, ISI_MAX),
        windowMs: p.windowMs,
        stimulus: { ...(noGo ? NO_GO[p.noGoStimulus] : GO) },
        expected: noGo ? { kind: 'withhold' } : { kind: 'press', key },
      }),
    );
  },

  keyCount: () => 1,

  instruction: (layout, p) =>
    `На красный круг нажимай ${singleKeyLabel(layout)}. На ${NO_GO_NAMES[p.noGoStimulus]} не нажимай ничего.`,

  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Доля no-go', value: percent(p.noGoRatio) },
  ],
};
