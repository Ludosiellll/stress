import { describe, expect, it } from 'vitest';
import { nextLevel, type DeltaInput } from '../../src/engine/adaptive';
import { MEMORY_TRIALS, memoryModeForBlock, memoryParams, type MemoryMode } from '../../src/modules/memory/params';
import { Rand } from './models/learner';
import { capacity, expectedRowShare, recallRow } from './models/memory';

/**
 * F13 (spec §4.7, §8.5): one level for the four memory modes, 10 rows a block, the level moved by the partial score
 * s = positions right / positions shown. The recall model is that of the spec (models/memory.ts, seed 5); the rows,
 * their lengths and the card's exposure and sound are the app's memoryParams, the step its nextLevel at g = 1 (as in
 * §8.5: the session's g = 2 boosts are left out).
 */

/** Rows sampled where the computed expectation is checked against recallRow. */
const SAMPLED_ROWS = 50_000;
const MODES_VS_DIGITS: readonly MemoryMode[] = ['letters', 'positions', 'card3x3'];
const LADDER_BLOCKS = 4000;
/** Blocks left out before the equilibrium is read: the ladder starts at L 9. */
const BURN_IN = 200;
const START_L = 9;

/**
 * The expected share of positions right of a row of `mode` at L, computed (expectedRowShare) rather than sampled: the
 * narrowest gap (0.0373 of 0.04) carries no sampling error (T-R67).
 */
function expectedPartial(mode: MemoryMode, L: number): number {
  const p = memoryParams(L, mode);
  return expectedRowShare(p.length, capacity(mode, p.exposureMs, p.sound));
}

/** A block's staircase input: s and nothing else (no calibration, no boost, no stability rule for memory). */
const plain = (score: number): DeltaInput => ({
  score,
  calibration: false,
  prevScoreSameSession: null,
  firstOfSegment: false,
  cvAll: null,
  lapses: 0,
  lapseLimit: 0,
  cvMax: null,
  timingUnreliable: false,
});

/**
 * LADDER_BLOCKS blocks of MEMORY_TRIALS rows in the mode cycle, from L 9: the mean level after BURN_IN blocks and the
 * root mean square of ΔL per block over them (around the equilibrium the mean step is 0).
 */
function ladder(r: Rand): { equilibrium: number; sdDelta: number } {
  let L = START_L;
  const levels: number[] = [];
  const steps: number[] = [];
  for (let b = 0; b < LADDER_BLOCKS; b++) {
    const mode = memoryModeForBlock(b);
    const p = memoryParams(L, mode);
    const k = capacity(mode, p.exposureMs, p.sound);
    let right = 0;
    for (let i = 0; i < MEMORY_TRIALS; i++) right += recallRow(r, p.length, k);
    const next = nextLevel(L, plain(right / (MEMORY_TRIALS * p.length)));
    if (b >= BURN_IN) {
      levels.push(L);
      steps.push(next - L);
    }
    L = next;
  }
  const mean = (xs: readonly number[]): number => xs.reduce((a, x) => a + x, 0) / xs.length;
  return { equilibrium: mean(levels), sdDelta: Math.sqrt(mean(steps.map((d) => d * d))) };
}

describe('memory simulation (F13)', () => {
  it('the computed expectation is the mean of recallRow (within 4 standard errors)', () => {
    const r = new Rand(5);
    for (const [length, k] of [[7, 7.5], [9, 7.5], [9, 5.2], [12, 6.3], [4, 0.6]] as const) {
      let sum = 0;
      let squares = 0;
      for (let i = 0; i < SAMPLED_ROWS; i++) {
        const share = recallRow(r, length, k) / length;
        sum += share;
        squares += share * share;
      }
      const mean = sum / SAMPLED_ROWS;
      const se = Math.sqrt((squares / SAMPLED_ROWS - mean * mean) / SAMPLED_ROWS);
      expect(Math.abs(expectedRowShare(length, k) - mean), `length ${String(length)}, K ${String(k)}`).toBeLessThanOrEqual(4 * se);
    }
  });

  it('each mode is within 0.04 of digits in expected partial score at L 9…27', () => {
    for (let L = 9; L <= 27; L += 3) {
      const digits = expectedPartial('digits', L);
      for (const mode of MODES_VS_DIGITS) {
        expect(Math.abs(expectedPartial(mode, L) - digits), `${mode} at L ${String(L)}`).toBeLessThanOrEqual(0.04);
      }
    }
  });

  it('SD of ΔL per block ≤ 0.5 with 10 rows and partial scoring', () => {
    // Spec §8.5: 0.23 (6 rows scored by the exact ones: 0.86).
    expect(ladder(new Rand(5)).sdDelta).toBeLessThanOrEqual(0.5);
  });

  it('the equilibrium of a span-7.5 player lies in 15–20', () => {
    // Spec §8.5: 17.5 (6 rows scored by the exact ones: 9.1, the L_norm of 0.2.0).
    const { equilibrium } = ladder(new Rand(5));
    expect(equilibrium).toBeGreaterThanOrEqual(15);
    expect(equilibrium).toBeLessThanOrEqual(20);
  });
});
