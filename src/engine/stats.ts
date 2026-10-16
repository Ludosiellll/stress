export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

export function median(xs: readonly number[]): number {
  return medianOfSorted([...xs].sort((a, b) => a - b));
}

/** Median of values already in ascending order, read in place (no copy, no sort); NaN for none. */
export function medianOfSorted(sorted: readonly number[]): number {
  if (sorted.length === 0) return NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Sample standard deviation (n-1); 0 for fewer than two values. */
export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  return Math.sqrt(ss / (xs.length - 1));
}

/** Coefficient of variation sd/mean; 0 when mean is 0. */
export function cv(xs: readonly number[]): number {
  const m = mean(xs);
  return m === 0 ? 0 : sd(xs) / m;
}

/**
 * SD with the outliers left out once: the mean m and SD s of all values, then the SD of those with |x − m| ≤ 3s
 * (Справочник F7). 0 for fewer than two values.
 */
export function sdTrimmed(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const s = sd(xs);
  return sd(xs.filter((x) => Math.abs(x - m) <= 3 * s));
}

/**
 * The p-quantile (0 ≤ p ≤ 1) with linear interpolation between ranks: the sorted values at (k − 1)·p (Справочник F7,
 * IQR). NaN for none; RangeError for p outside [0, 1].
 */
export function quantile(xs: readonly number[], p: number): number {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`quantile needs 0 ≤ p ≤ 1, got ${String(p)}`);
  const sorted = [...xs].sort((a, b) => a - b);
  const last = sorted.length - 1;
  if (last < 0) return NaN;
  const at = last * p;
  const lo = Math.floor(at);
  const below = sorted[lo] as number;
  const above = sorted[Math.min(lo + 1, last)] as number;
  return below + (above - below) * (at - lo);
}
