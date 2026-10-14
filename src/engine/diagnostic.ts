import { hashString } from './rng';
import type { FamilyId, ModuleId, ReactionModuleId } from './types';
import type { Segment, SessionPlan } from './planner';

/** The measured values of one control diagnostic; null = metric not available. */
export interface DiagnosticMetrics {
  pzmrMedianRt: number | null;
  szmrMedianRt: number | null;
  /** Percent of successful trials, 0–100 (the controller fills it as summary.score · 100). */
  gonogoScore: number | null;
  rdoMeanAbsErrorMs: number | null;
  gorbov: { V: number; P: number; Pi: number } | null;
  numseriesCorrect: number | null;
}

/** Results of one control diagnostic as stored (resultsJson). */
export interface DiagnosticResults extends DiagnosticMetrics {
  /**
   * Reaction modules whose block stayed timingUnreliable after its one replay (I1). Their values are kept and
   * used by readiness, but every screen marks them «замер ненадёжен». Rows stored before 0.1.0 lack it: read as [].
   */
  unreliable: ReactionModuleId[];
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
 * Diagnostic number n (shown and stored). Its blocks are generated from seedIndex: it defaults to n, and
 * callers pass «diagnostic sessions ever started + 1» so a diagnostic abandoned halfway is not replayed with
 * the same tables and series next time (I5). budgetMs is 0 everywhere: the volume is fixed (R16), the
 * controller uses trialCount / runs / items instead of a time budget.
 */
export function planDiagnostic(n: number, seedIndex: number = n): SessionPlan {
  const segment = (module: ModuleId, extra: Partial<Segment>): Segment => ({
    module,
    budgetMs: 0,
    purpose: 'diagnostic',
    ...extra,
  });
  return {
    kind: 'diagnostic',
    seed: hashString('diag:' + String(seedIndex)),
    diagnosticNumber: n,
    diagnosticSeedIndex: seedIndex,
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
