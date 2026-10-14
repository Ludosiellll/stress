import { median, sd } from './stats';

export interface RefreshStats {
  intervalMs: number;
  hz: number;
  jitterMs: number;
  droppedRatio: number;
}

export function isDroppedFrame(deltaMs: number, nominalMs: number): boolean {
  return deltaMs > 1.5 * nominalMs;
}

export function measureRefresh(timestamps: readonly number[]): RefreshStats {
  if (timestamps.length < 10) {
    throw new RangeError(`measureRefresh: need at least 10 timestamps, got ${String(timestamps.length)}`);
  }
  const deltas: number[] = [];
  let prev: number | undefined;
  for (const t of timestamps) {
    if (prev !== undefined) {
      if (!(t > prev)) throw new RangeError('measureRefresh: timestamps must be strictly increasing');
      deltas.push(t - prev);
    }
    prev = t;
  }
  const intervalMs = median(deltas);
  const dropped = deltas.filter((d) => isDroppedFrame(d, intervalMs)).length;
  return {
    intervalMs,
    hz: 1000 / intervalMs,
    jitterMs: sd(deltas),
    droppedRatio: dropped / deltas.length,
  };
}
