import { describe, expect, it } from 'vitest';
import { RDO_PERIODS, rdoPeriod } from '../../src/modules/reaction/rdo';
import { Rand } from './models/learner';

/**
 * The РДО bias by speed (spec §4.4, Справочник F14). The player's signed error depends on the speed: at the start
 * +25 / +15 / −15 / −25 ms at 1500 / 2000 / 3000 / 4000 ms. A trial is the bias plus N(0, 30). After a block at speed v
 * the bias at v moves towards 0 by 0.15 of the mean error the block showed. A session is one segment of 4 blocks
 * whose periods are rdoPeriod(seed·1000 + session, 0, i). Seeds 1…12.
 */
const START_BIAS: Readonly<Record<number, number>> = { 1500: 25, 2000: 15, 3000: -15, 4000: -25 };
const TRIAL_SD = 30;
const TRIALS = 20;
const LEARN = 0.15;
const BLOCKS = 4;
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

/** The bias at each speed after `sessions` sessions of `seed`. */
function biasAfter(seed: number, sessions: number): Map<number, number> {
  const bias = new Map<number, number>(RDO_PERIODS.map((v) => [v, START_BIAS[v] as number]));
  const rand = new Rand(seed);
  for (let session = 0; session < sessions; session++) {
    for (let i = 0; i < BLOCKS; i++) {
      const v = rdoPeriod(seed * 1000 + session, 0, i);
      const b = bias.get(v) as number;
      let sum = 0;
      for (let t = 0; t < TRIALS; t++) sum += b + TRIAL_SD * rand.normal();
      bias.set(v, b - LEARN * (sum / TRIALS));
    }
  }
  return bias;
}

describe('РДО: four speeds in turn train the bias at the test speed (F14)', () => {
  it('after 30 sessions |bias at 3000 ms| ≤ 10 ms for every seed', () => {
    for (const seed of SEEDS) {
      const bias = biasAfter(seed, 30).get(3000) as number;
      expect(Math.abs(bias), `seed ${String(seed)}`).toBeLessThanOrEqual(10);
    }
  });
});
