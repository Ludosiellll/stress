import { describe, expect, it } from 'vitest';
import { RDO_PERIODS, rdoCyclePeriod } from '../../src/modules/reaction/rdo';
import { Rand } from './models/learner';

/**
 * The РДО bias by speed (spec §4.4, Справочник F14, T-R61). The player's signed error depends on the speed: at the start
 * +25 / +15 / −15 / −25 ms at 1500 / 2000 / 3000 / 4000 ms. A trial is the bias plus N(0, 30). After a block at speed v
 * the bias at v moves towards 0 by 0.15 of the mean error the block showed. A session's segment ends on its time
 * budget, so it plays 3–5 blocks; the speeds go on from the session before (rdoCyclePeriod of the blocks counted so
 * far). Seeds 1…12.
 */
const START_BIAS: Readonly<Record<number, number>> = { 1500: 25, 2000: 15, 3000: -15, 4000: -25 };
const TRIAL_SD = 30;
const TRIALS = 20;
const LEARN = 0.15;
const SESSIONS = 30;
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

/** The bias at each speed after `sessions` sessions of `seed`, and how many blocks each speed got. */
function course(seed: number, sessions: number): { bias: Map<number, number>; blocks: Map<number, number> } {
  const bias = new Map<number, number>(RDO_PERIODS.map((v) => [v, START_BIAS[v] as number]));
  const blocks = new Map<number, number>(RDO_PERIODS.map((v) => [v, 0]));
  const rand = new Rand(seed);
  let count = 0;
  for (let session = 0; session < sessions; session++) {
    const n = rand.int(3, 5);
    for (let i = 0; i < n; i++) {
      const v = rdoCyclePeriod(count++);
      const b = bias.get(v) as number;
      let sum = 0;
      for (let t = 0; t < TRIALS; t++) sum += b + TRIAL_SD * rand.normal();
      bias.set(v, b - LEARN * (sum / TRIALS));
      blocks.set(v, (blocks.get(v) as number) + 1);
    }
  }
  return { bias, blocks };
}

describe('РДО: four speeds in turn train the bias at the test speed (F14, T-R61)', () => {
  it('after 30 sessions |bias at 3000 ms| ≤ 10 ms for every seed', () => {
    for (const seed of SEEDS) {
      const bias = course(seed, SESSIONS).bias.get(3000) as number;
      expect(Math.abs(bias), `seed ${String(seed)}`).toBeLessThanOrEqual(10);
    }
  });

  it('every speed takes 25 % ± 1 % of the course for every seed, however the sessions end', () => {
    for (const seed of SEEDS) {
      const { blocks } = course(seed, SESSIONS);
      const total = [...blocks.values()].reduce((a, b) => a + b, 0);
      for (const v of RDO_PERIODS) {
        const share = (blocks.get(v) as number) / total;
        expect(Math.abs(share - 0.25), `seed ${String(seed)}, ${String(v)} ms: ${String(blocks.get(v))} of ${String(total)}`).toBeLessThanOrEqual(0.01);
      }
    }
  });
});
