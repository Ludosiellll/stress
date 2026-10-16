import { mean } from './stats';

/**
 * The noise band and the trend of a «Прогресс» chart (F7, spec 2026-10-15 §4.1, Р19): σ̂ from the successive
 * differences and a least-squares line, both over the same last ≤ TREND_POINTS points by date.
 */
export const TREND_POINTS = 6;
/** Fewer points give no band and no trend. */
export const TREND_MIN_POINTS = 3;

/** A value at a time; t in days. */
export interface TrendPoint {
  t: number;
  y: number;
}

export interface Trend {
  /** Per day. */
  slope: number;
  /** The line at t = 0. */
  intercept: number;
  /** σ̂: the band is the line ± 2σ̂. */
  sigma: number;
  /** slope × (t_k − t_1). */
  change: number;
  /** t_k − t_1. */
  days: number;
  /** |change| ≤ 2σ̂ is noise; otherwise better or worse by the direction of the metric. */
  verdict: 'better' | 'worse' | 'noise';
}

/** σ̂ = √(Σ_{i=2..k} (y_i − y_{i−1})² / (2(k − 1))): a slow trend hardly inflates it. 0 for fewer than two values. */
export function noiseSigma(ys: readonly number[]): number {
  if (ys.length < 2) return 0;
  let ss = 0;
  for (let i = 1; i < ys.length; i += 1) ss += ((ys[i] as number) - (ys[i - 1] as number)) ** 2;
  return Math.sqrt(ss / (2 * (ys.length - 1)));
}

/** The last TREND_POINTS points by t (a stable sort: equal times keep their order). */
export function trendWindow<P extends TrendPoint>(points: readonly P[]): P[] {
  return [...points].sort((a, b) => a.t - b.t).slice(-TREND_POINTS);
}

/**
 * The trend of the last TREND_POINTS points by t; null below TREND_MIN_POINTS. Points all at one time have no slope,
 * nor do points all of one value: the line is that value (the sums alone leave a rounding residue, T-R56).
 */
export function trend(points: readonly TrendPoint[], lowerIsBetter: boolean): Trend | null {
  const w = trendWindow(points);
  if (w.length < TREND_MIN_POINTS) return null;
  const first = w[0] as TrendPoint;
  const last = w[w.length - 1] as TrendPoint;
  const ys = w.map((p) => p.y);
  const tMean = mean(w.map((p) => p.t));
  const yMean = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (const p of w) {
    sxx += (p.t - tMean) ** 2;
    sxy += (p.t - tMean) * (p.y - yMean);
  }
  const flat = ys.every((y) => y === first.y);
  const slope = sxx === 0 || flat ? 0 : sxy / sxx;
  const sigma = noiseSigma(ys);
  const days = last.t - first.t;
  const change = slope * days;
  const verdict = Math.abs(change) <= 2 * sigma ? 'noise' : change < 0 === lowerIsBetter ? 'better' : 'worse';
  return { slope, intercept: flat ? first.y : yMean - slope * tMean, sigma, change, days, verdict };
}
