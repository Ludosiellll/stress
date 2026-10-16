import { L_NORM } from '../../engine/planner';
import type { TrialSpec } from '../../engine/reaction/types';
import { createRng, deriveSeed, hashString } from '../../engine/rng';
import { blockLength, keysFor, ms, singleKeyLabel, type ReactionModule } from './common';

export interface RdoParams {
  /**
   * Time for the marker to go once around the circle. params(L) gives the test speed; a training or free block plays
   * the next speed of the cycle (rdoCyclePeriod, T-R61; rdoPeriod without the history).
   */
  periodMs: number;
  /** Allowed |press − target| for a hit: the level's one lever (F14). */
  toleranceMs: number;
  isiMin: number;
  isiMax: number;
  trials: number;
}

/** The speeds training and free blocks take in turn (F14, T-R61); the test plays TEST_PERIOD_MS. */
export const RDO_PERIODS = [1500, 2000, 3000, 4000] as const;
const TEST_PERIOD_MS = 3000;
const BLOCK_SIZE = 20;

/**
 * The period of block `blockIndex` of segment `segmentIndex` (F14): element blockIndex mod 4 of the segment's shuffle
 * of RDO_PERIODS from deriveSeed(planSeed, 'rdo:' + segmentIndex). Any four blocks in a row of the segment play each
 * speed once. The rule of a session whose history could not be read (Р18); otherwise rdoCyclePeriod.
 */
export function rdoPeriod(planSeed: number, segmentIndex: number, blockIndex: number): number {
  const order = createRng(deriveSeed(planSeed, 'rdo:' + String(segmentIndex))).shuffle(RDO_PERIODS);
  return order[blockIndex % order.length] as number;
}

/**
 * The order of the speed cycle (T-R61): one shuffle of RDO_PERIODS from the fixed seed hashString('rdo:cycle'), so it
 * is the same in every session, on every device and after a restore. Every cycle of four counted blocks plays this
 * order: a new shuffle per cycle could put a speed twice into four blocks in a row across the cycle's edge, since only
 * a sequence that repeats every four blocks has each speed in every window of four.
 */
export const RDO_CYCLE: readonly number[] = Object.freeze(createRng(hashString('rdo:cycle')).shuffle(RDO_PERIODS));

/**
 * The period of the РДО block that follows `count` counted training and free РДО blocks (T-R61): RDO_CYCLE[count mod 4].
 * The count runs over the whole history, so a segment that ends after 3–5 blocks leaves the next one, in this session
 * or a later one, the speeds it did not reach. RangeError for a count that is not a whole number from 0.
 */
export function rdoCyclePeriod(count: number): number {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`rdoCyclePeriod: count must be a whole number ≥ 0, got ${String(count)}`);
  }
  return RDO_CYCLE[count % RDO_CYCLE.length] as number;
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
