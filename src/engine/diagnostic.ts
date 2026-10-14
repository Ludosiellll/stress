import { hashString } from './rng';
import type { ModuleId, FamilyId } from './types';
import type { Segment, SessionPlan } from './planner';

/** Results of one control diagnostic; null = metric not available. */
export interface DiagnosticResults {
  pzmrMedianRt: number | null;
  szmrMedianRt: number | null;
  /** Percent of successful trials, 0–100 (the controller fills it as summary.score · 100). */
  gonogoScore: number | null;
  rdoMeanAbsErrorMs: number | null;
  gorbov: { V: number; P: number; Pi: number } | null;
  numseriesCorrect: number | null;
}

/** Family order of the number-series diagnostic; mirrors the module's FAMILIES (engine must not import src/modules). */
const SERIES_FAMILIES: readonly FamilyId[] = ['arith', 'geom', 'second', 'alt', 'fib', 'linrec', 'powers', 'opcycle'];
const SERIES_ITEMS = 20;

/** Seed of one diagnostic segment: hashString('diag:' + n + ':' + module). */
export function diagnosticSegmentSeed(n: number, module: ModuleId): number {
  return hashString('diag:' + String(n) + ':' + module);
}

/** Family and target difficulty for each of the 20 diagnostic number-series items. */
export function diagnosticSeriesSchedule(): { family: FamilyId; targetD: number }[] {
  return Array.from({ length: SERIES_ITEMS }, (_, i) => ({
    family: SERIES_FAMILIES[i % SERIES_FAMILIES.length] as FamilyId,
    targetD: 900 + 30 * i,
  }));
}

/**
 * Diagnostic number n. budgetMs is 0 everywhere: the volume is fixed (R16), the controller
 * uses trialCount / runs / items instead of a time budget.
 */
export function planDiagnostic(n: number): SessionPlan {
  const segment = (module: ModuleId, extra: Partial<Segment>): Segment => ({
    module,
    budgetMs: 0,
    purpose: 'diagnostic',
    ...extra,
  });
  return {
    kind: 'diagnostic',
    seed: hashString('diag:' + String(n)),
    diagnosticNumber: n,
    segments: [
      segment('pzmr', { fixedL: 0, trialCount: 50, practiceTrials: 5 }),
      segment('szmr', { fixedL: 0, trialCount: 70, practiceTrials: 5 }),
      segment('gonogo', { fixedL: 10, trialCount: 60, practiceTrials: 5 }),
      segment('rdo', { fixedL: 0, trialCount: 50, practiceTrials: 5 }),
      segment('gorbov', { fixedL: 0, runs: 3 }),
      segment('numseries', { items: SERIES_ITEMS, totalTimeLimitMs: 600_000 }),
    ],
  };
}
