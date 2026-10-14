import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BAND_GORBOV_P,
  BAND_GORBOV_PI,
  BAND_GORBOV_V,
  baselineScore,
  bandScore,
  readiness,
} from './readiness';
import type { DiagnosticResults } from './diagnostic';

const full = (over: Partial<DiagnosticResults> = {}): DiagnosticResults => ({
  pzmrMedianRt: 250,
  szmrMedianRt: 400,
  gonogoScore: 80,
  rdoMeanAbsErrorMs: 60,
  gorbov: { V: 33, P: 70, Pi: 24 },
  numseriesCorrect: 12,
  ...over,
});

const empty: DiagnosticResults = {
  pzmrMedianRt: null,
  szmrMedianRt: null,
  gonogoScore: null,
  rdoMeanAbsErrorMs: null,
  gorbov: null,
  numseriesCorrect: null,
};

describe('bandScore', () => {
  it('hits the published points and interpolates', () => {
    expect(bandScore(29, BAND_GORBOV_V)).toBe(100);
    expect(bandScore(33, BAND_GORBOV_V)).toBe(90);
    expect(bandScore(37, BAND_GORBOV_V)).toBe(80);
    expect(bandScore(70, BAND_GORBOV_V)).toBe(20);
  });
  it('clamps beyond the ends', () => {
    expect(bandScore(80, BAND_GORBOV_V)).toBe(20);
    expect(bandScore(20, BAND_GORBOV_V)).toBe(100);
  });
  it('exports P and Pi bands from the reference table', () => {
    expect(bandScore(43, BAND_GORBOV_P)).toBe(100);
    expect(bandScore(126, BAND_GORBOV_P)).toBe(20);
    expect(bandScore(9, BAND_GORBOV_PI)).toBe(100);
    expect(bandScore(49, BAND_GORBOV_PI)).toBe(20);
    expect(bandScore(13, BAND_GORBOV_PI)).toBe(90);
  });
  it('sorts unsorted points and handles a single point', () => {
    expect(bandScore(5, [[10, 0], [0, 100]])).toBe(50);
    expect(bandScore(99, [[10, 55]])).toBe(55);
  });
  it('throws on empty points', () => {
    expect(() => bandScore(1, [])).toThrow(RangeError);
  });
  it('property: monotone non-increasing for the V band and within [20, 100]', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 200, noNaN: true }), fc.double({ min: 0, max: 200, noNaN: true }), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const sl = bandScore(lo, BAND_GORBOV_V);
        const sh = bandScore(hi, BAND_GORBOV_V);
        return sl >= sh && sl <= 100 && sh >= 20;
      }),
      { numRuns: 1000 },
    );
  });
});

describe('baselineScore', () => {
  it('gives 60 at the baseline and 100 / 20 at +-25 %', () => {
    expect(baselineScore(250, 250, true)).toBe(60);
    expect(baselineScore(187.5, 250, true)).toBe(100);
    expect(baselineScore(312.5, 250, true)).toBe(20);
    expect(baselineScore(312.5, 250, false)).toBe(100);
    expect(baselineScore(187.5, 250, false)).toBe(20);
  });
  it('clamps to [0, 100]', () => {
    expect(baselineScore(400, 250, true)).toBe(0);
    expect(baselineScore(100, 250, true)).toBe(100);
    expect(baselineScore(1000, 250, false)).toBe(100);
  });
  it('property: always within [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e5, noNaN: true }),
        fc.double({ min: 1, max: 1e5, noNaN: true }),
        fc.boolean(),
        (v, v0, low) => {
          const s = baselineScore(v, v0, low);
          return s >= 0 && s <= 100;
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('readiness', () => {
  it('with baseline = latest, baseline-scored abilities are 60 and Gorbov uses bands', () => {
    const d = full();
    const r = readiness(d, d);
    expect(r.abilities.reaction).toBe(60);
    expect(r.abilities.logic).toBe(60);
    expect(r.abilities.switching).toBe(bandScore(24, BAND_GORBOV_PI));
    expect(r.abilities.attention).toBe((bandScore(33, BAND_GORBOV_V) + 60) / 2);
    expect(r.abilities.memory).toBeNull();
    const vals = [r.abilities.reaction, r.abilities.attention, r.abilities.switching, r.abilities.logic] as number[];
    expect(r.overall).toBeCloseTo(vals.reduce((a, b) => a + b, 0) / 4, 12);
  });

  it('reflects improvement relative to baseline', () => {
    const base = full();
    const latest = full({ pzmrMedianRt: 200, szmrMedianRt: 320, rdoMeanAbsErrorMs: 48, numseriesCorrect: 15 });
    const r = readiness(latest, base);
    // each reaction metric is 20 % better => 60 + 40 * 0.8 = 92
    expect(r.abilities.reaction).toBeCloseTo(92, 10);
    expect(r.abilities.logic).toBe(100);
  });

  it('skips metrics with null latest or baseline and averages the rest', () => {
    const base = full();
    const latest = full({ szmrMedianRt: null, rdoMeanAbsErrorMs: null });
    const r = readiness(latest, base);
    expect(r.abilities.reaction).toBe(60);
    const base2 = full({ pzmrMedianRt: null });
    expect(readiness(full(), base2).abilities.reaction).toBe(60);
  });

  it('returns null abilities and overall when nothing is available', () => {
    const r = readiness(empty, empty);
    expect(r.abilities).toEqual({ reaction: null, attention: null, switching: null, memory: null, logic: null });
    expect(r.overall).toBeNull();
  });

  it('attention falls back to a single available metric', () => {
    const base = full();
    expect(readiness(full({ gorbov: null }), base).abilities.attention).toBe(60);
    expect(readiness(full({ gonogoScore: null }), base).abilities.attention).toBe(bandScore(33, BAND_GORBOV_V));
    expect(readiness(full({ gorbov: null }), base).abilities.switching).toBeNull();
  });

  it('uses max(v0, 1) so a zero baseline does not divide by zero', () => {
    const r = readiness(full({ numseriesCorrect: 1 }), full({ numseriesCorrect: 0 }));
    expect(r.abilities.logic).toBe(60);
  });

  it('property: all non-null scores are within [0, 100]', () => {
    const num = fc.option(fc.double({ min: 0, max: 2000, noNaN: true }), { nil: null });
    const g = fc.option(
      fc.record({
        V: fc.double({ min: 0, max: 200, noNaN: true }),
        P: fc.double({ min: 0, max: 300, noNaN: true }),
        Pi: fc.double({ min: -50, max: 200, noNaN: true }),
      }),
      { nil: null },
    );
    const res = fc.record({
      pzmrMedianRt: num,
      szmrMedianRt: num,
      gonogoScore: num,
      rdoMeanAbsErrorMs: num,
      gorbov: g,
      numseriesCorrect: num,
    });
    fc.assert(
      fc.property(res, res, (a, b) => {
        const r = readiness(a, b);
        const all = [...Object.values(r.abilities), r.overall];
        return all.every((x) => x === null || (x >= 0 && x <= 100));
      }),
      { numRuns: 1000 },
    );
  });
});
