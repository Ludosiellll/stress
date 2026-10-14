import { L_NORM } from '../../engine/planner';
import type { TrialSpec } from '../../engine/reaction/types';
import { ISI_MAX, ISI_MIN, blockLength, keysFor, ms, singleKeyLabel, type ReactionModule } from './common';

export interface PzmrParams {
  windowMs: number;
  isiMin: number;
  isiMax: number;
}

const BLOCK_SIZE = 15;

/** ПЗМР: simple reaction to a red circle with one key. */
export const pzmr: ReactionModule<PzmrParams> = {
  id: 'pzmr',
  title: 'ПЗМР',
  lNorm: L_NORM.pzmr,
  blockSize: BLOCK_SIZE,

  params(L) {
    const wide = L >= 25;
    return {
      windowMs: Math.round(150 + 850 * 0.88 ** L),
      isiMin: wide ? 300 : ISI_MIN,
      isiMax: wide ? 3500 : ISI_MAX,
    };
  },

  cvMax: (L) => Math.max(0.12, 0.25 - 0.006 * L),

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, BLOCK_SIZE);
    const [key] = keysFor(layout, 1) as [string];
    return Array.from(
      { length: n },
      (): TrialSpec => ({
        isiMs: rng.int(p.isiMin, p.isiMax),
        windowMs: p.windowMs,
        stimulus: { kind: 'shape', shape: 'circle', color: 'red' },
        expected: { kind: 'press', key },
      }),
    );
  },

  keyCount: () => 1,

  instruction: (layout) =>
    `Когда появится красный круг, как можно быстрее нажми ${singleKeyLabel(layout)}. ` +
    'Не нажимай заранее: это фальстарт.',

  describeParams: (p) => [{ label: 'Окно ответа', value: ms(p.windowMs) }],
};
