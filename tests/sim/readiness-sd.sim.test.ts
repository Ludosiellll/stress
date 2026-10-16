import { describe, expect, it } from 'vitest';
import { sdScore } from '../../src/engine/readiness';
import { mean, sd, sdTrimmed } from '../../src/engine/stats';
import { trend, TREND_POINTS, type Trend } from '../../src/engine/trend';
import { exGaussRt } from './models/exgauss';
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
  return Array.from({ length: b.n }, () => exGaussRt(r, b.mu + day, b.sigma, b.tau, LAPSE));
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

/** σ̂ on a straight line with noise (Справочник F7): σ = 10, a slope of 0,4σ per step, k = 6 points, 20 000 lines. */
const LINE = { sigma: 10, slopePerStep: 0.4 * 10, k: TREND_POINTS, repeats: 20_000 };

describe('noise band simulation (F7)', () => {
  it('σ̂ on a noisy line is off by ≤ 15 % at k = 6', () => {
    const r = new Rand(SEED);
    const sigmas = Array.from({ length: LINE.repeats }, () => {
      const points = Array.from({ length: LINE.k }, (_, i) => ({ t: 7 * i, y: LINE.slopePerStep * i + LINE.sigma * r.normal() }));
      return (trend(points, true) as Trend).sigma;
    });
    // Seed 3: mean(σ̂)/σ = 0.980. The plain SD of the points (trend included) gives 1.19, the differences without the
    // factor 2 give 1.39: both fail.
    expect(Math.abs(mean(sigmas) / LINE.sigma - 1)).toBeLessThanOrEqual(0.15);
  });
});
