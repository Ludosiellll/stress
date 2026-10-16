import { L_NORM } from '../../engine/planner';
import type { TrialSpec } from '../../engine/reaction/types';
import { createRng, deriveSeed } from '../../engine/rng';
import { blockLength, keysFor, ms, singleKeyLabel, type ReactionModule } from './common';

export interface RdoParams {
  /**
   * Time for the marker to go once around the circle. params(L) gives the test speed; a training or free block plays
   * the speed of its slot (rdoPeriod, F14).
   */
  periodMs: number;
  /** Allowed |press − target| for a hit: the level's one lever (F14). */
  toleranceMs: number;
  isiMin: number;
  isiMax: number;
  trials: number;
}

/** The speeds a segment's blocks take in turn (F14); the test plays TEST_PERIOD_MS. */
export const RDO_PERIODS = [1500, 2000, 3000, 4000] as const;
const TEST_PERIOD_MS = 3000;
const BLOCK_SIZE = 20;

/**
 * The period of block `blockIndex` of segment `segmentIndex` (F14): element blockIndex mod 4 of the segment's shuffle
 * of RDO_PERIODS from deriveSeed(planSeed, 'rdo:' + segmentIndex). Any four blocks in a row play each speed once.
 */
export function rdoPeriod(planSeed: number, segmentIndex: number, blockIndex: number): number {
  const order = createRng(deriveSeed(planSeed, 'rdo:' + String(segmentIndex))).shuffle(RDO_PERIODS);
  return order[blockIndex % order.length] as number;
}

/** РДО: press exactly when the moving marker reaches the target mark. */
export const rdo: ReactionModule<RdoParams> = {
  id: 'rdo',
  title: 'Реакция на движущийся объект',
  lNorm: L_NORM.rdo,
  blockSize: BLOCK_SIZE,

  params: (L) => ({
    periodMs: TEST_PERIOD_MS,
    toleranceMs: Math.round(Math.max(10, 60 * 0.94 ** L)),
    isiMin: 800,
    isiMax: 1500,
    trials: BLOCK_SIZE,
  }),

  trials: (p) => p.trials,

  cvMax: null,

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

  keyCount: () => 1,

  instruction: (layout) =>
    `Метка бежит по кругу. Нажми ${singleKeyLabel(layout)} точно в момент, когда она дойдёт до отметки. ` +
    'Важна точность, а не скорость.',

  // The period turns with the block, not with the level (F14): the level changes only the tolerance.
  describeParams: (p) => [{ label: 'Допуск', value: ms(p.toleranceMs) }],
};
