import { describe, expect, it } from 'vitest';
import { R0, expectedScore, targetDifficulty, updateRating, type Rating } from '../../src/engine/elo';
import { ITEM_LIMIT_START_MS, MIN_ITEM_LIMIT_MS, effectiveDifficulty } from '../../src/engine/itemLimit';
import { createRng } from '../../src/engine/rng';
import { mean } from '../../src/engine/stats';
import { STRUCT_D_MAX, generateItem, generateTrainingItem } from '../../src/modules/numseries/generate';

const TRUE_STRENGTH = 1600;
const ITEMS = 300;
const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
/** Items 201–300. */
const WINDOW_START = 200;
/** Below this targetD a training item has 30 s (F12). */
const SHRINK_FROM_D = 1000;

interface Played {
  /** The target the item was served at. */
  targetD: number;
  /** Rating after the item. */
  rating: number;
  effectiveD: number;
  success: boolean;
  /** null without the lever. */
  limitMs: number | null;
}

/**
 * A player of fixed strength solves only arith items served at targetDifficulty(R); every item. With the lever the item
 * is the training one (generateTrainingItem: aimed at structTarget, 30 s from the start, shorter from targetD 1000, F12);
 * without it, generateItem at the target and the 40 s of D_eff's reference.
 */
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
    played.push({ targetD: target, rating: r.rating, effectiveD, success, limitMs });
  }
  return played;
}

const cache = new Map<boolean, Played[][]>();
/** Every item of every seed; each run is simulated once per file. */
function runs(lever: boolean): Played[][] {
  let out = cache.get(lever);
  if (out === undefined) {
    out = SEEDS.map((seed) => play(seed, lever));
    cache.set(lever, out);
  }
  return out;
}
/** Items 201–300 of every seed. */
const windows = (lever: boolean): Played[][] => runs(lever).map((all) => all.slice(WINDOW_START));

const seedMean = (window: readonly Played[], value: (p: Played) => number): number => mean(window.map(value));
const overSeeds = (all: readonly Played[][], value: (p: Played) => number): number =>
  mean(all.map((w) => seedMean(w, value)));
const rating = (p: Played): number => p.rating;
const successRate = (p: Played): number => (p.success ? 1 : 0);

describe('number series time-limit lever (R36, F12) simulation', () => {
  it("strong player's arith rating rises past the old cap", () => {
    const lever = windows(true);
    const plain = windows(false);

    // Rating: past 1500 with the lever, and clearly above the same player without it (W2-R17). Seeds 1–10: 1617 against
    // 1525, the lowest seed 1545; success 0.82 (aimed at arith's ceiling of 950, any item of 800–950 is taken and the
    // limit stops at 8 s).
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

    for (const p of runs(true).flat()) {
      expect(p.limitMs).not.toBeNull();
      expect(p.limitMs ?? 0).toBeGreaterThanOrEqual(MIN_ITEM_LIMIT_MS);
      expect(p.limitMs ?? 0).toBeLessThanOrEqual(ITEM_LIMIT_START_MS);
    }
  }, 120_000);

  it('without the lever the same player meets items that are too easy', () => {
    expect(overSeeds(windows(false), successRate)).toBeGreaterThanOrEqual(0.95);
  }, 120_000);

  it('the first items of a new rating get 30 s', () => {
    for (const [i, all] of runs(true).entries()) {
      const seed = `seed ${String(SEEDS[i])}`;
      // A new rating is R0: its target is below 1000, so the first item has the full 30 s.
      expect(all[0]?.targetD, seed).toBeLessThan(SHRINK_FROM_D);
      expect(all[0]?.limitMs, seed).toBe(ITEM_LIMIT_START_MS);
      // So does every item served below targetD 1000; the limit shrinks only after.
      const early = all.filter((p) => p.targetD < SHRINK_FROM_D);
      expect(early.length, seed).toBeGreaterThan(1);
      for (const p of early) expect(p.limitMs, seed).toBe(ITEM_LIMIT_START_MS);
    }
    // The lever does shorten the limit once the rating has grown.
    expect(runs(true).flat().some((p) => (p.limitMs ?? ITEM_LIMIT_START_MS) < ITEM_LIMIT_START_MS)).toBe(true);
  }, 120_000);
});
