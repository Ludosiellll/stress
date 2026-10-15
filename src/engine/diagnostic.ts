import { hashString } from './rng';
import { REACTION_MODULE_IDS, type FamilyId, type ModuleId, type ReactionModuleId } from './types';
import type { Segment, SessionPlan } from './planner';

/**
 * The measured values of one control diagnostic; null = metric not available. The W2 metrics (pomeh … memorySpan)
 * are null in rows stored before 0.2.0, the mean RTs in rows stored before 0.3.0, and a condition median is null
 * below MIN_COND_RTS RTs.
 */
export interface DiagnosticMetrics {
  pzmrMedianRt: number | null;
  /** Mean RT of ПЗМР: the published norms are of the mean (the screens still show the median). */
  pzmrMeanRt: number | null;
  szmrMedianRt: number | null;
  /** Mean RT of СЗМР, as pzmrMeanRt. */
  szmrMeanRt: number | null;
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
  pzmrMeanRt: null,
  szmrMedianRt: null,
  szmrMeanRt: null,
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

const REACTION_IDS: readonly string[] = REACTION_MODULE_IDS;
export const isReactionId = (v: unknown): v is ReactionModuleId => typeof v === 'string' && REACTION_IDS.includes(v);

type NumberMetric = Exclude<keyof DiagnosticMetrics, 'gorbov'>;
const NUMBER_METRICS = Object.keys(EMPTY_METRICS).filter((k): k is NumberMetric => k !== 'gorbov');

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Горбов needs all three of V, P and Π as finite numbers; anything else reads as not measured. */
function gorbovOf(v: unknown): DiagnosticMetrics['gorbov'] {
  if (typeof v !== 'object' || v === null) return null;
  const g = v as Readonly<Record<string, unknown>>;
  const [V, P, Pi] = [finite(g['V']), finite(g['P']), finite(g['Pi'])];
  return V === null || P === null || Pi === null ? null : { V, P, Pi };
}

/**
 * The stored results of a diagnostic, or null when the row does not hold a JSON object. A missing metric
 * reads as null (the W2 metrics of a 0.1.0 row, the mean RTs of a 0.2.0 one: missing, never 0); rows written before `unreliable` existed
 * read as reliable (I1). A damaged or imported row is read field by field (FW9): a metric that is not a finite number,
 * or a Горбов result without numeric V, P and Π, reads as null; unknown entries are dropped. Structural: DiagnosticRow fits.
 */
export function parseResults(row: { readonly resultsJson: string }): DiagnosticResults | null {
  let value: unknown;
  try {
    value = JSON.parse(row.resultsJson);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Readonly<Record<string, unknown>>;
  const metrics = { ...EMPTY_METRICS, gorbov: gorbovOf(r['gorbov']) };
  for (const k of NUMBER_METRICS) metrics[k] = finite(r[k]);
  const unreliable = Array.isArray(r['unreliable']) ? (r['unreliable'] as unknown[]).filter(isReactionId) : [];
  return { ...metrics, unreliable };
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
