import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BAND_GORBOV_P,
  BAND_GORBOV_PI,
  BAND_GORBOV_V,
  DIFF_SCALE_MS,
  baselineScore,
  bandScore,
  diffScore,
  mergedBaseline,
  readiness,
} from './readiness';
import { EMPTY_METRICS, type DiagnosticMetrics, type DiagnosticResults } from './diagnostic';

/** A 0.1.0 diagnostic: the W2 metrics are null. */
const full = (over: Partial<DiagnosticMetrics> = {}): DiagnosticMetrics => ({
  ...EMPTY_METRICS,
  pzmrMedianRt: 250,
  szmrMedianRt: 400,
  gonogoScore: 80,
  rdoMeanAbsErrorMs: 60,
  gorbov: { V: 33, P: 70, Pi: 24 },
  numseriesCorrect: 12,
  ...over,
});

/** A 0.2.0 diagnostic with every metric. */
const fullW2 = (over: Partial<DiagnosticMetrics> = {}): DiagnosticMetrics =>
  full({
    pomehQuietRt: 280,
    pomehNoisyRt: 330,
    pomehDeltaMs: 50,
    stroopCongruentRt: 520,
    stroopIncongruentRt: 620,
    stroopInterferenceMs: 100,
    switchRepeatRt: 600,
    switchSwitchRt: 720,
    switchCostMs: 120,
    memorySpan: 7,
    ...over,
  });

const empty: DiagnosticMetrics = EMPTY_METRICS;

describe('diffScore (П1)', () => {
  it('60 at the baseline, 40 points per scale step, clamped to [0, 100]', () => {
    expect(diffScore(70, 100, 60)).toBe(80);
    expect(diffScore(100, 100, 40)).toBe(60);
    expect(diffScore(-100, 100, 40)).toBe(100);
    expect(diffScore(300, 100, 40)).toBe(0);
    expect(diffScore(160, 100, 60)).toBe(20);
  });

  it('works around zero and below it', () => {
    expect(diffScore(-20, -10, 40)).toBe(70);
    expect(diffScore(0, 0, 60)).toBe(60);
    expect(diffScore(10, 0, 40)).toBe(50);
  });

  it('scales: pomeh 40 ms, stroop and taskswitch 60 ms', () => {
    expect(DIFF_SCALE_MS).toEqual({ pomeh: 40, stroop: 60, taskswitch: 60 });
  });

  it('property: always within [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -2000, max: 2000, noNaN: true }),
        fc.double({ min: -2000, max: 2000, noNaN: true }),
        fc.constantFrom(40, 60),
        (v, v0, scale) => {
          const s = diffScore(v, v0, scale);
          return s >= 0 && s <= 100;
        },
      ),
      { numRuns: 1000 },
    );
  });
});

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

  it('0.1.0 results give the 0.1.0 abilities', () => {
    // The two diagnostics of the W1 Home test; the W2 metrics are missing (null), not zero.
    const baseline = full({ pzmrMedianRt: 400, szmrMedianRt: 600, rdoMeanAbsErrorMs: 50, gonogoScore: 80, numseriesCorrect: 10, gorbov: { V: 60, P: 100, Pi: 40 } });
    const latest = full({ pzmrMedianRt: 300, szmrMedianRt: 450, rdoMeanAbsErrorMs: 40, gonogoScore: 90, numseriesCorrect: 14, gorbov: { V: 30, P: 60, Pi: 10 } });
    const r = readiness(latest, baseline);
    expect(r.abilities.reaction).toBeCloseTo((100 + 100 + 92) / 3, 12);
    expect(Math.round(r.abilities.reaction ?? NaN)).toBe(97);
    expect(Math.round(r.abilities.attention ?? NaN)).toBe(89);
    expect(Math.round(r.abilities.switching ?? NaN)).toBe(98);
    expect(r.abilities.logic).toBe(100);
    expect(r.abilities.memory).toBeNull();
    expect(Math.round(r.overall ?? NaN)).toBe(96);
    // A W2 latest against a 0.1.0 baseline: the W2 parts have no baseline, so they are left out, never scored as 0.
    const latestW2 = { ...latest, pomehDeltaMs: 30, stroopInterferenceMs: 90, switchCostMs: 100, memorySpan: 7 };
    expect(readiness(latestW2, baseline)).toEqual(r);
  });

  it('with latest = baseline and the W2 metrics every ability is 60, except the Gorbov bands; memory 60', () => {
    const d = fullW2();
    const r = readiness(d, d);
    expect(r.abilities.reaction).toBe(60);
    expect(r.abilities.attention).toBe((bandScore(33, BAND_GORBOV_V) + 60 + 60) / 3);
    expect(r.abilities.switching).toBe((bandScore(24, BAND_GORBOV_PI) + 60) / 2);
    expect(r.abilities.memory).toBe(60);
    expect(r.abilities.logic).toBe(60);
  });

  it('the pomeh difference 40 ms better scores 100 in reaction', () => {
    const r = readiness(fullW2({ pomehDeltaMs: 10 }), fullW2({ pomehDeltaMs: 50 }));
    expect(r.abilities.reaction).toBe((60 + 60 + 60 + 100) / 4);
  });

  it('interference goes into attention, the switch cost into switching, both by diffScore', () => {
    const base = fullW2({ gorbov: null });
    const r = readiness(fullW2({ gorbov: null, stroopInterferenceMs: 70, switchCostMs: 180 }), fullW2({ ...base, stroopInterferenceMs: 100 }));
    expect(r.abilities.attention).toBe((60 + diffScore(70, 100, 60)) / 2);
    expect(r.abilities.attention).toBe(70);
    expect(r.abilities.switching).toBe(diffScore(180, 120, 60));
    expect(r.abilities.switching).toBe(20);
  });

  it('memory: span against the own baseline, max(span0, 1)', () => {
    expect(readiness(fullW2({ memorySpan: 8 }), fullW2({ memorySpan: 7 })).abilities.memory).toBeCloseTo(60 + (40 * 1) / (0.25 * 7), 12);
    expect(readiness(fullW2({ memorySpan: 3 }), fullW2({ memorySpan: 0 })).abilities.memory).toBe(100);
    expect(readiness(fullW2({ memorySpan: null }), fullW2()).abilities.memory).toBeNull();
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

  it('scores gonogo as percent against its baseline: 80 -> 85 gives 70', () => {
    const r = readiness(full({ gorbov: null, gonogoScore: 85 }), full({ gorbov: null, gonogoScore: 80 }));
    expect(r.abilities.attention).toBeCloseTo(70, 10);
  });

  it('scores Gorbov from bands even when the baseline has no Gorbov result', () => {
    const r = readiness(full(), full({ gorbov: null }));
    expect(r.abilities.switching).toBe(bandScore(24, BAND_GORBOV_PI));
    expect(r.abilities.attention).toBe((bandScore(33, BAND_GORBOV_V) + 60) / 2);
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
    const diff = fc.option(fc.double({ min: -500, max: 500, noNaN: true }), { nil: null });
    const res = fc.record({
      pzmrMedianRt: num,
      szmrMedianRt: num,
      gonogoScore: num,
      rdoMeanAbsErrorMs: num,
      gorbov: g,
      numseriesCorrect: num,
      pomehQuietRt: num,
      pomehNoisyRt: num,
      pomehDeltaMs: diff,
      stroopCongruentRt: num,
      stroopIncongruentRt: num,
      stroopInterferenceMs: diff,
      switchRepeatRt: num,
      switchSwitchRt: num,
      switchCostMs: diff,
      memorySpan: fc.option(fc.integer({ min: 0, max: 12 }), { nil: null }),
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

const EMPTY: DiagnosticResults = { ...EMPTY_METRICS, unreliable: [] };

describe('mergedBaseline (M2)', () => {
  it('takes every metric from the first diagnostic that has it', () => {
    const merged = mergedBaseline([
      { ...EMPTY, pzmrMedianRt: 320 },
      { ...EMPTY, pzmrMedianRt: 300, rdoMeanAbsErrorMs: 40, gorbov: { V: 40, P: 80, Pi: 20 } },
      { ...EMPTY, pzmrMedianRt: 280, rdoMeanAbsErrorMs: 30, numseriesCorrect: 12 },
    ]);
    expect(merged).toEqual({
      ...EMPTY_METRICS,
      pzmrMedianRt: 320,
      szmrMedianRt: null,
      gonogoScore: null,
      rdoMeanAbsErrorMs: 40,
      gorbov: { V: 40, P: 80, Pi: 20 },
      numseriesCorrect: 12,
    });
  });

  it('takes every W2 metric from the first diagnostic that has it (a 0.1.0 one has none)', () => {
    const w2 = {
      pomehQuietRt: 300,
      pomehNoisyRt: 340,
      pomehDeltaMs: 40,
      stroopCongruentRt: 500,
      stroopIncongruentRt: 600,
      stroopInterferenceMs: 100,
      switchRepeatRt: 550,
      switchSwitchRt: 640,
      switchCostMs: 90,
      memorySpan: 6,
    };
    const merged = mergedBaseline([
      { ...EMPTY, pzmrMedianRt: 320 },
      { ...EMPTY, ...w2, stroopInterferenceMs: null, stroopIncongruentRt: null, memorySpan: 0 },
      { ...EMPTY, ...w2, pomehDeltaMs: -5, stroopInterferenceMs: 70, stroopIncongruentRt: 570, memorySpan: 8 },
    ]);
    expect(merged).toEqual({
      ...EMPTY_METRICS,
      pzmrMedianRt: 320,
      ...w2,
      stroopIncongruentRt: 570,
      stroopInterferenceMs: 70,
      // 0 is a value (a span of 0), not a missing one.
      memorySpan: 0,
    });
  });
});
