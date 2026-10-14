import { hashString } from './rng';
import type { FamilyId, ModuleId, ReactionModuleId } from './types';
import type { Segment, SessionPlan } from './planner';

/**
 * The measured values of one control diagnostic; null = metric not available. The W2 metrics (pomeh … memorySpan)
 * are null in rows stored before 0.2.0, and a condition median is null below MIN_COND_RTS RTs.
 */
export interface DiagnosticMetrics {
  pzmrMedianRt: number | null;
  szmrMedianRt: number | null;
  /** Percent of successful trials, 0–100 (the controller fills it as summary.score · 100). */
  gonogoScore: number | null;
  rdoMeanAbsErrorMs: number | null;
  gorbov: { V: number; P: number; Pi: number } | null;
  numseriesCorrect: number | null;
  pomehQuietRt: number | null;
  pomehNoisyRt: number | null;
  /** noisy − quiet. */
  pomehDeltaMs: number | null;
  stroopCongruentRt: number | null;
  stroopIncongruentRt: number | null;
  /** incongruent − congruent. */
  stroopInterferenceMs: number | null;
  switchRepeatRt: number | null;
  switchSwitchRt: number | null;
  /** switch − repeat. */
  switchCostMs: number | null;
  /** The longest row of the span protocol with an exact answer. */
  memorySpan: number | null;
}

/** Every metric missing: what a diagnostic without any block, or a missing key of a stored row, reads as. */
export const EMPTY_METRICS: Readonly<DiagnosticMetrics> = Object.freeze({
  pzmrMedianRt: null,
  szmrMedianRt: null,
  gonogoScore: null,
  rdoMeanAbsErrorMs: null,
  gorbov: null,
  numseriesCorrect: null,
  pomehQuietRt: null,
  pomehNoisyRt: null,
  pomehDeltaMs: null,
  stroopCongruentRt: null,
  stroopIncongruentRt: null,
  stroopInterferenceMs: null,
  switchRepeatRt: null,
  switchSwitchRt: null,
  switchCostMs: null,
  memorySpan: null,
});

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
 * controller uses trialCount / runs / items instead of a time budget. The six 0.1.0 segments come first,
 * unchanged, so diagnostics stay comparable; the W2 segments follow the number series (П8). Memory plays the
 * span protocol (the controller builds it for a diagnostic), so its segment has no level or volume.
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
      segment('pomeh', { fixedL: 8, trialCount: 40, practiceTrials: 5 }),
      segment('stroop', { fixedL: 8, trialCount: 48, practiceTrials: 5 }),
      segment('taskswitch', { fixedL: 5, trialCount: 48, practiceTrials: 5 }),
      segment('memory', {}),
    ],
  };
}
