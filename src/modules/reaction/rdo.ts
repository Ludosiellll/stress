import { L_NORM } from '../../engine/planner';
import type { TrialSpec } from '../../engine/reaction/types';
import { blockLength, keysFor, ms, singleKeyLabel, type ReactionModule } from './common';

export interface RdoParams {
  /** Time for the marker to go once around the circle. */
  periodMs: number;
  /** Allowed |press − target| for a hit. */
  toleranceMs: number;
  isiMin: number;
  isiMax: number;
}

const BLOCK_SIZE = 10;

/** РДО: press exactly when the moving marker reaches the target mark. */
export const rdo: ReactionModule<RdoParams> = {
  id: 'rdo',
  title: 'Реакция на движущийся объект',
  lNorm: L_NORM.rdo,
  blockSize: BLOCK_SIZE,

  params: (L) => ({
    periodMs: Math.round(Math.max(600, 3000 * 0.93 ** L)),
    toleranceMs: Math.round(Math.max(10, 60 * 0.94 ** L)),
    isiMin: 800,
    isiMax: 1500,
  }),

  cvMax: () => null,

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, BLOCK_SIZE);
    const [key] = keysFor(layout, 1) as [string];
    return Array.from({ length: n }, (): TrialSpec => {
      const isiMs = rng.int(p.isiMin, p.isiMax);
      const startDeg = rng.int(0, 359);
      const sweepDeg = rng.int(90, 330);
      const targetOffsetMs = Math.round((sweepDeg / 360) * p.periodMs);
      return {
        isiMs,
        windowMs: targetOffsetMs + Math.round(0.25 * p.periodMs),
        stimulus: { kind: 'rdo', startDeg, targetDeg: (startDeg + sweepDeg) % 360, periodMs: p.periodMs },
        expected: { kind: 'timed', key, targetOffsetMs, toleranceMs: p.toleranceMs },
      };
    });
  },

  instruction: (layout) =>
    `Метка бежит по кругу. Нажми ${singleKeyLabel(layout)} точно в момент, когда она дойдёт до отметки. ` +
    'Важна точность, а не скорость.',

  describeParams: (p) => [
    { label: 'Период обхода', value: ms(p.periodMs) },
    { label: 'Допуск', value: ms(p.toleranceMs) },
  ],
};
