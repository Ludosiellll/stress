import { describe, expect, it } from 'vitest';
import { R0, expectedScore, targetDifficulty, updateRating, type Rating } from '../../src/engine/elo';
import { createRng } from '../../src/engine/rng';
import { mean } from '../../src/engine/stats';

const TRUE_STRENGTH = 1400;
const ITEMS = 300;
const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);

/** Player of fixed strength solves items served at targetDifficulty(R). Returns R after each item. */
function simulate(seed: number): number[] {
  const rng = createRng(seed);
  let r: Rating = { rating: R0, n: 0 };
  const history: number[] = [];
  for (let i = 0; i < ITEMS; i++) {
    const D = targetDifficulty(r.rating);
    const success = rng.next() < expectedScore(TRUE_STRENGTH, D);
    r = updateRating(r, D, success);
    history.push(r.rating);
  }
  return history;
}

describe('elo simulation', () => {
  // The rating keeps fluctuating around the true strength (stationary SD ≈ 50 at K = 32),
  // so a window mean is asserted instead of the final value.
  it.each(SEEDS)('seed %i: rating over items 201–300 averages near the true strength', (seed) => {
    const history = simulate(seed);
    expect(Math.abs(mean(history.slice(200, 300)) - TRUE_STRENGTH)).toBeLessThan(120);
  });

  it.each(SEEDS)('seed %i: rating moved well away from the start', (seed) => {
    const history = simulate(seed);
    expect(mean(history.slice(-100))).toBeGreaterThan(1250);
  });
});
