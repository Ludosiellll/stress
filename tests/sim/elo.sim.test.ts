import { describe, expect, it } from 'vitest';
import { R0, expectedScore, targetDifficulty, updateRating, type Rating } from '../../src/engine/elo';
import { itemEffectiveDifficulty } from '../../src/engine/itemLimit';
import { createRng } from '../../src/engine/rng';
import { mean } from '../../src/engine/stats';
import { generateTrainingItem } from '../../src/modules/numseries/generate';
import { Rand } from './models/learner';

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

/** The learner of spec §4.8 (F12): a geom player of strength 1500 whose solving time falls over 600 items. */
const LEARNER_STRENGTH = 1500;
const LEARNER_ITEMS = 600;
/** Median solving time 12 + 23·e^(−n/200) s, lognormal with σ 0.35. */
const SOLVE_FLOOR_S = 12;
const SOLVE_GAIN_S = 23;
const SOLVE_ITEMS = 200;
const SOLVE_SIGMA = 0.35;
/** Items 301–600. */
const LATE_ITEMS = 300;

interface LearnerItem {
  /** The rating the item was served at. */
  rating: number;
  limitMs: number;
  success: boolean;
}

/**
 * The player solves the item (training items of geom at targetDifficulty(R), generateTrainingItem) with probability
 * expectedScore(1500, D_struct) and needs a lognormal time; a success is solved within the item's limit. The rating
 * moves by updateRating against the item's D_eff (itemEffectiveDifficulty), as the controller moves it.
 */
function learner(seed: number): LearnerItem[] {
  const r = new Rand(seed);
  let rating: Rating = { rating: R0, n: 0 };
  const items: LearnerItem[] = [];
  for (let n = 0; n < LEARNER_ITEMS; n++) {
    const item = generateTrainingItem('geom', targetDifficulty(rating.rating), r.int(0, 0x7fffffff));
    const solved = r.next() < expectedScore(LEARNER_STRENGTH, item.difficulty);
    const timeMs = 1000 * (SOLVE_FLOOR_S + SOLVE_GAIN_S * Math.exp(-n / SOLVE_ITEMS)) * Math.exp(SOLVE_SIGMA * r.normal());
    const success = solved && timeMs <= item.timeLimitMs;
    items.push({ rating: rating.rating, limitMs: item.timeLimitMs, success });
    rating = updateRating(rating, itemEffectiveDifficulty(item), success);
  }
  return items;
}

describe('elo simulation with the item limit (F12)', () => {
  it('a player whose solving time falls over 600 items keeps 0.70–0.80 success; limits are < 20 s from rating 1480', () => {
    // Seeds 1–10: success 0.750–0.770 (mean 0.763); 147 items served at rating ≥ 1480, the longest limit 18.7 s. With the
    // symmetric ±150 of generateItem 130 of 587 such items got 20–26 s (TRAINING_WINDOW).
    const runs = SEEDS.map(learner);
    const late = runs.map((items) => mean(items.slice(LATE_ITEMS).map((it) => (it.success ? 1 : 0))));
    const success = mean(late);
    expect(success).toBeGreaterThanOrEqual(0.7);
    expect(success).toBeLessThanOrEqual(0.8);
    const high = runs.flat().filter((it) => it.rating >= 1480);
    expect(high.length).toBeGreaterThan(0);
    for (const it of high) expect(it.limitMs).toBeLessThan(20_000);
  }, 120_000);
});
