import { mean } from './stats';
import type { DiagnosticMetrics } from './diagnostic';

export type Ability = 'reaction' | 'attention' | 'switching' | 'memory' | 'logic';

type Points = ReadonlyArray<readonly [number, number]>;

/**
 * Published Gorbov-Shulte bands, piecewise linear, (value in seconds -> score).
 * Source: common.md «Индекс готовности (§7.5)», spec §7.5, research note Test_Battery_Research_BY.md.
 */
export const BAND_GORBOV_V: Points = [[29, 100], [37, 80], [50, 60], [60, 40], [70, 20]];
/** P = t3 (seconds). Not part of any ability in W1; exported for the progress screen. */
export const BAND_GORBOV_P: Points = [[43, 100], [56, 80], [86, 60], [106, 40], [126, 20]];
export const BAND_GORBOV_PI: Points = [[9, 100], [17, 80], [31, 60], [40, 40], [49, 20]];

/** Piecewise-linear score through `points` (sorted by value); clamped to the end scores outside. */
export function bandScore(value: number, points: Points): number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first === undefined || last === undefined) throw new RangeError('bandScore needs at least one point');
  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  // first < value < last here, so a segment end exists and is never the first point.
  const i = pts.findIndex((p) => value <= p[0]);
  const [x0, y0] = pts[i - 1] as readonly [number, number];
  const [x1, y1] = pts[i] as readonly [number, number];
  return y0 + ((y1 - y0) * (value - x0)) / (x1 - x0);
}

/** Score relative to the own baseline v0 (callers pass max(v0, 1)): 60 at baseline, ±40 per 25 %, clamped to [0, 100]. */
export function baselineScore(v: number, v0: number, lowerIsBetter: boolean): number {
  const diff = lowerIsBetter ? v0 - v : v - v0;
  const raw = 60 + (40 * diff) / (0.25 * v0);
  return Math.min(100, Math.max(0, raw));
}

/** Step of diffScore per module: 40 points per this many ms (≈ 2 standard errors of a median difference, П1). */
export const DIFF_SCALE_MS: Readonly<{ pomeh: 40; stroop: 60; taskswitch: 60 }> = Object.freeze({ pomeh: 40, stroop: 60, taskswitch: 60 });

/**
 * Score of a difference of medians (noise, interference, switch cost; lower is better) against its baseline v0:
 * 60 at the baseline, ±40 per scaleMs, clamped to [0, 100]. Works for v0 near or below zero, unlike baselineScore (П1).
 */
export function diffScore(v: number, v0: number, scaleMs: number): number {
  const raw = 60 + (40 * (v0 - v)) / scaleMs;
  return Math.min(100, Math.max(0, raw));
}

/** Baseline per metric (M2): the first non-null value across the diagnostics, in order. */
export function mergedBaseline(results: readonly DiagnosticMetrics[]): DiagnosticMetrics {
  const first = <K extends keyof DiagnosticMetrics>(k: K): DiagnosticMetrics[K] => {
    for (const r of results) {
      const v = r[k];
      if (v !== null) return v;
    }
    return null;
  };
  return {
    pzmrMedianRt: first('pzmrMedianRt'),
    szmrMedianRt: first('szmrMedianRt'),
    gonogoScore: first('gonogoScore'),
    rdoMeanAbsErrorMs: first('rdoMeanAbsErrorMs'),
    gorbov: first('gorbov'),
    numseriesCorrect: first('numseriesCorrect'),
    pomehQuietRt: first('pomehQuietRt'),
    pomehNoisyRt: first('pomehNoisyRt'),
    pomehDeltaMs: first('pomehDeltaMs'),
    stroopCongruentRt: first('stroopCongruentRt'),
    stroopIncongruentRt: first('stroopIncongruentRt'),
    stroopInterferenceMs: first('stroopInterferenceMs'),
    switchRepeatRt: first('switchRepeatRt'),
    switchSwitchRt: first('switchSwitchRt'),
    switchCostMs: first('switchCostMs'),
    memorySpan: first('memorySpan'),
  };
}

function avg(scores: readonly number[]): number | null {
  return scores.length === 0 ? null : mean(scores);
}

/**
 * Abilities of the latest diagnostic against the baseline (§7.5). An ability is the mean of the parts that both
 * diagnostics have; a part missing on either side (e.g. a W2 metric of a 0.1.0 row) is left out, never scored as 0,
 * and an ability without any part is null. The overall index is the mean of the abilities that are not null.
 */
export function readiness(
  latest: DiagnosticMetrics,
  baseline: DiagnosticMetrics,
): { abilities: Record<Ability, number | null>; overall: number | null } {
  const rel = (v: number | null, v0: number | null, lowerIsBetter: boolean): number[] =>
    v === null || v0 === null ? [] : [baselineScore(v, Math.max(v0, 1), lowerIsBetter)];
  const diff = (v: number | null, v0: number | null, scaleMs: number): number[] =>
    v === null || v0 === null ? [] : [diffScore(v, v0, scaleMs)];
  // Absolute published bands: scored from the latest result alone, no baseline needed (R18a).
  const band = (
    pick: (g: { V: number; P: number; Pi: number }) => number,
    points: Points,
  ): number[] =>
    latest.gorbov === null ? [] : [bandScore(pick(latest.gorbov), points)];

  const abilities: Record<Ability, number | null> = {
    reaction: avg([
      ...rel(latest.pzmrMedianRt, baseline.pzmrMedianRt, true),
      ...rel(latest.szmrMedianRt, baseline.szmrMedianRt, true),
      ...rel(latest.rdoMeanAbsErrorMs, baseline.rdoMeanAbsErrorMs, true),
      ...diff(latest.pomehDeltaMs, baseline.pomehDeltaMs, DIFF_SCALE_MS.pomeh),
    ]),
    attention: avg([
      ...band((g) => g.V, BAND_GORBOV_V),
      ...rel(latest.gonogoScore, baseline.gonogoScore, false),
      ...diff(latest.stroopInterferenceMs, baseline.stroopInterferenceMs, DIFF_SCALE_MS.stroop),
    ]),
    switching: avg([...band((g) => g.Pi, BAND_GORBOV_PI), ...diff(latest.switchCostMs, baseline.switchCostMs, DIFF_SCALE_MS.taskswitch)]),
    memory: avg(rel(latest.memorySpan, baseline.memorySpan, false)),
    logic: avg(rel(latest.numseriesCorrect, baseline.numseriesCorrect, false)),
  };
  const available = Object.values(abilities).filter((a): a is number => a !== null);
  return { abilities, overall: avg(available) };
}
