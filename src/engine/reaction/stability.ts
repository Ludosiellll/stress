import { mean, median } from '../stats';
import type { TrialResult, TrialSpec } from './types';

/** A late press still counts as an answer up to this long after the window (F2); a later one is a lapse. */
export const LATE_LIMIT_EXTRA_MS = 1000;
/** An answer slower than this many medians of its condition is a lapse. */
export const LAPSE_MEDIAN_FACTOR = 1.5;
/** This many lapses hold the level at least… */
const MIN_LAPSE_LIMIT = 2;
/** …and one per this many `press` trials when that is more. */
const TRIALS_PER_LAPSE = 10;

/** How steady the answers of a block were (spec §2.2, Справочник F2). */
export interface Stability {
  /**
   * SD over mean of R, the RTs of clean hits and of late presses up to window + LATE_LIMIT_EXTRA_MS. The SD is pooled
   * within conditions; null below 3 RTs or when no condition has 2 (Р7).
   */
  cvAll: number | null;
  /** Misses, RTs of R above LAPSE_MEDIAN_FACTOR × the median of their condition, late presses beyond R. */
  lapses: number;
  /** lapseLimit(nPress): this many lapses hold the level. */
  lapseLimit: number;
  /** `press` trials outside practice. */
  nPress: number;
}

/** max(2, ⌈0.1 · nPress⌉), computed as ⌈nPress / 10⌉: 0.1 · 30 is 3.0000000000000004 in floating point. */
export function lapseLimit(nPress: number): number {
  return Math.max(MIN_LAPSE_LIMIT, Math.ceil(nPress / TRIALS_PER_LAPSE));
}

/** An answer of a `press` trial that may enter R: a hit or a late press, with its RT. */
const answered = (r: TrialResult): r is TrialResult & { rtMs: number } => (r.outcome === 'hit' || r.outcome === 'late') && r.rtMs !== null;

/**
 * Stability over every answer of the `press` trials outside practice (F2). R leaves out trials whose onset frame was
 * dropped and answers with the wrong key; a late press beyond window + LATE_LIMIT_EXTRA_MS is a lapse whatever its key.
 * Trials without a condition form their own group (Р7), so a module without conditions is one group.
 * RangeError for a result whose trial is not a `press` trial of `specs`.
 */
export function stabilityOf(specs: readonly TrialSpec[], results: readonly TrialResult[]): Stability {
  const groups = new Map<string, number[]>();
  let nPress = 0;
  let lapses = 0;
  for (const r of results) {
    if (r.practice || r.kind !== 'press') continue;
    const spec = specs[r.idx];
    if (spec?.expected.kind !== 'press') throw new RangeError(`stabilityOf: result ${String(r.idx)} is not of a press trial`);
    nPress++;
    if (r.outcome === 'miss') {
      lapses++;
    } else if (answered(r)) {
      if (r.rtMs > spec.windowMs + LATE_LIMIT_EXTRA_MS) lapses++;
      else if (!r.frameDropped && r.key === spec.expected.key) {
        const cond = spec.cond ?? 'none';
        const group = groups.get(cond);
        if (group === undefined) groups.set(cond, [r.rtMs]);
        else group.push(r.rtMs);
      }
    }
  }
  const all: number[] = [];
  let squares = 0;
  let freedom = 0;
  for (const rts of groups.values()) {
    const m = mean(rts);
    const slow = LAPSE_MEDIAN_FACTOR * median(rts);
    for (const x of rts) {
      squares += (x - m) ** 2;
      if (x > slow) lapses++;
    }
    freedom += rts.length - 1;
    all.push(...rts);
  }
  const cvAll = all.length < 3 || freedom === 0 ? null : Math.sqrt(squares / freedom) / mean(all);
  return { cvAll, lapses, lapseLimit: lapseLimit(nPress), nPress };
}
