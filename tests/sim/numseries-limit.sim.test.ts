import { describe, expect, it } from 'vitest';
import { R0, expectedScore, targetDifficulty, updateRating, type Rating } from '../../src/engine/elo';
import { BASE_ITEM_LIMIT_MS, MIN_ITEM_LIMIT_MS, effectiveDifficulty } from '../../src/engine/itemLimit';
import { createRng } from '../../src/engine/rng';
import { mean } from '../../src/engine/stats';
import { STRUCT_D_MAX, generateItem, generateTrainingItem } from '../../src/modules/numseries/generate';

const TRUE_STRENGTH = 1600;
const ITEMS = 300;
const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
/** Items 201–300. */
const WINDOW_START = 200;

interface Played {
  /** Rating after the item. */
  rating: number;
  effectiveD: number;
  success: boolean;
  /** null without the lever. */
  limitMs: number | null;
}

/** A player of fixed strength solves only arith items served at targetDifficulty(R); items 201–300. */
function play(seed: number, lever: boolean): Played[] {
  const rng = createRng(seed);
  let r: Rating = { rating: R0, n: 0 };
  const played: Played[] = [];
  for (let i = 0; i < ITEMS; i++) {
    const target = targetDifficulty(r.rating);
    const itemSeed = rng.int(0, 0x7fffffff);
    let effectiveD: number;
    let limitMs: number | null = null;
    if (lever) {
      const item = generateTrainingItem('arith', target, itemSeed);
      limitMs = item.timeLimitMs;
      effectiveD = effectiveDifficulty(item.difficulty, item.timeLimitMs);
    } else {
      effectiveD = generateItem('arith', target, itemSeed).difficulty;
    }
    const success = rng.next() < expectedScore(TRUE_STRENGTH, effectiveD);
    r = updateRating(r, effectiveD, success);
    played.push({ rating: r.rating, effectiveD, success, limitMs });
  }
  return played.slice(WINDOW_START);
}

const cache = new Map<boolean, Played[][]>();
/** Items 201–300 of every seed; each run is simulated once per file. */
function runs(lever: boolean): Played[][] {
  let out = cache.get(lever);
  if (out === undefined) {
    out = SEEDS.map((seed) => play(seed, lever));
    cache.set(lever, out);
  }
  return out;
}

const seedMean = (window: readonly Played[], value: (p: Played) => number): number => mean(window.map(value));
const overSeeds = (all: readonly Played[][], value: (p: Played) => number): number =>
  mean(all.map((w) => seedMean(w, value)));
const rating = (p: Played): number => p.rating;
const successRate = (p: Played): number => (p.success ? 1 : 0);

describe('number series time-limit lever (R36) simulation', () => {
  it("strong player's arith rating rises past the old cap", () => {
    const lever = runs(true);
    const plain = runs(false);

    // Rating: past 1500 with the lever, and clearly above the same player without it (W2-R17).
    // Seeds 0–99: the gap averages 75.6 and every disjoint group of 10 seeds gives ≥ 66.9, so +60
    // holds whichever seeds the generator's rng draws land on (seeds 1–10 here: 1605 vs 1525).
    const leverR = overSeeds(lever, rating);
    expect(leverR).toBeGreaterThanOrEqual(1500);
    lever.forEach((w, i) => {
      expect(seedMean(w, rating), `seed ${String(SEEDS[i])}`).toBeGreaterThanOrEqual(1450);
    });
    expect(leverR).toBeGreaterThanOrEqual(overSeeds(plain, rating) + 60);

    // Items: the lever lifts the effective difficulty above what arith reaches structurally.
    expect(overSeeds(lever, (p) => p.effectiveD)).toBeGreaterThanOrEqual(1300);
    expect(overSeeds(plain, (p) => p.effectiveD)).toBeLessThanOrEqual(STRUCT_D_MAX.arith);

    const rate = overSeeds(lever, successRate);
    expect(rate).toBeGreaterThanOrEqual(0.68);
    expect(rate).toBeLessThanOrEqual(0.84);

    for (const p of lever.flat()) {
      expect(p.limitMs).not.toBeNull();
      expect(p.limitMs ?? 0).toBeGreaterThanOrEqual(MIN_ITEM_LIMIT_MS);
      expect(p.limitMs ?? 0).toBeLessThan(BASE_ITEM_LIMIT_MS);
    }
  }, 120_000);

  it('without the lever the same player meets items that are too easy', () => {
    expect(overSeeds(runs(false), successRate)).toBeGreaterThanOrEqual(0.95);
  }, 120_000);
});
