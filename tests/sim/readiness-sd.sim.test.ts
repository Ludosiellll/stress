import { describe, expect, it } from 'vitest';
import { sdScore } from '../../src/engine/readiness';
import { sd, sdTrimmed } from '../../src/engine/stats';
import { Rand } from './models/learner';

/**
 * F7 (spec §4.1, §8.6; ported from the fixes simulation sdnoise2.ts): how much the SD part of «Реакция» moves between
 * two diagnostics without any real change. A diagnostic block is ex-Gaussian, RT = μ + day + σ·N(0, 1) + Exp(τ), with
 * 1.5 % lapses (+300…700 ms) and a day state N(0, day SD) shared by the block. The rules are the app's: the trimmed SD
 * (sdTrimmed) and sdScore with v0 = max(v₁, 1).
 */
interface DiagnosticBlock {
  name: string;
  n: number;
  mu: number;
  sigma: number;
  tau: number;
  daySd: number;
}

const BLOCKS: readonly DiagnosticBlock[] = [
  { name: 'ПЗМР', n: 50, mu: 222, sigma: 18, tau: 40, daySd: 10 },
  { name: 'СЗМР', n: 70, mu: 300, sigma: 30, tau: 60, daySd: 12 },
];
const LAPSE = 0.015;
const PAIRS = 20_000;
const SEED = 3;

function blockRts(b: DiagnosticBlock, r: Rand): number[] {
  const day = b.daySd * r.normal();
  return Array.from({ length: b.n }, () => {
    let x = b.mu + day + b.sigma * r.normal() + r.exp(b.tau);
    if (r.next() < LAPSE) x += 300 + 400 * r.next();
    return x;
  });
}

/** The SD part of the second diagnostic against the first, over PAIRS pairs of diagnostics of the same player. */
function sdParts(b: DiagnosticBlock): number[] {
  const r = new Rand(SEED);
  return Array.from({ length: PAIRS }, () => {
    const v1 = sdTrimmed(blockRts(b, r));
    const v2 = sdTrimmed(blockRts(b, r));
    return sdScore(v2, Math.max(v1, 1));
  });
}

describe('readiness SD simulation (F7)', () => {
  it.each(BLOCKS)('$name: the SD part moves by ≤ 23 points SD without a real change', (b) => {
    // Seed 3: ПЗМР 19.3, СЗМР 15.0 (the clamp at 0 and 100 trims the tails).
    expect(sd(sdParts(b))).toBeLessThanOrEqual(23);
  });
});
