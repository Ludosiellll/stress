import { describe, expect, it } from 'vitest';
import { nextLevel, savedLevel } from '../../src/engine/adaptive';
import { createRng } from '../../src/engine/rng';
import { mean } from '../../src/engine/stats';

const TRIALS_PER_BLOCK = 20;
const CALIBRATION_BLOCKS = 3;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

/** Synthetic player: chance of a successful trial at level L. */
const successChance = (L: number, ability: number): number => 1 / (1 + Math.exp(L - ability));

interface Run {
  /** L after each block. */
  levels: number[];
  scores: number[];
}

/** One long session of one module, starting at L = 0. */
function simulate(seed: number, blocks: number, abilityAt: (block: number) => number): Run {
  const rng = createRng(seed);
  const levels: number[] = [];
  const scores: number[] = [];
  let L = 0;
  let prev: number | null = null;
  for (let b = 0; b < blocks; b++) {
    const p = successChance(L, abilityAt(b));
    let hits = 0;
    for (let t = 0; t < TRIALS_PER_BLOCK; t++) if (rng.next() < p) hits++;
    const score = hits / TRIALS_PER_BLOCK;
    L = nextLevel(L, {
      score,
      calibration: b < CALIBRATION_BLOCKS,
      prevScoreSameSession: prev,
      cvRt: null,
      cvMax: null,
      timingUnreliable: false,
    });
    prev = score;
    levels.push(L);
    scores.push(score);
  }
  return { levels, scores };
}

const lastLevel = (run: Run): number => run.levels[run.levels.length - 1] ?? Number.NaN;

describe('adaptive staircase simulation', () => {
  it('converges to ~80% success', () => {
    const offTarget = SEEDS.map((seed) => {
      const { scores } = simulate(seed, 300, () => 20);
      return { seed, meanScore: mean(scores.slice(100, 300)) };
    }).filter(({ meanScore }) => !(meanScore >= 0.75 && meanScore <= 0.85));
    expect(offTarget).toEqual([]);
  });

  it('no ceiling for super-strong player', () => {
    const run = simulate(1, 400, () => 1000);
    expect(lastLevel(run)).toBeGreaterThanOrEqual(800);
  });

  it('tracks improving player', () => {
    const lagging = SEEDS.map((seed) => {
      const run = simulate(seed, 400, (b) => 10 + 0.05 * b);
      return { seed, level: lastLevel(run) };
    }).filter(({ level }) => !(level >= 25));
    expect(lagging).toEqual([]);
  });

  it('one bad session does not drop savedLevel', () => {
    expect(savedLevel([20, 20, 5])).toBe(20);
  });
});
