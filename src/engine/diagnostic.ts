import { hashString } from './rng';
import { MODULE_IDS, REACTION_MODULE_IDS, type FamilyId, type ModuleId, type ReactionModuleId } from './types';
import type { Segment, SessionPlan } from './planner';

/**
 * The measured values of one control diagnostic; null = metric not available. The W2 metrics (pomeh … memorySpan)
 * are null in rows stored before 0.2.0, the mean RTs and the F7 spread and error counts in rows stored before 0.3.0,
 * and a condition median is null below MIN_COND_RTS RTs.
 */
export interface DiagnosticMetrics {
  pzmrMedianRt: number | null;
  /** Mean RT of ПЗМР: the published norms are of the mean (the screens still show the median). */
  pzmrMeanRt: number | null;
  szmrMedianRt: number | null;
  /** Mean RT of СЗМР, as pzmrMeanRt. */
  szmrMeanRt: number | null;
  /** SD of the clean hit RTs with |z| > 3 left out once (sdTrimmed), ms; null below 2 clean hits (F7). */
  pzmrSdRt: number | null;
  szmrSdRt: number | null;
  /** P75 − P25 of the clean hit RTs (quantile), ms; null below 2 clean hits (F7). */
  pzmrIqrRt: number | null;
  szmrIqrRt: number | null;
  /** Error counts of the block (F7): shown, never part of the index. */
  pzmrFalseStarts: number | null;
  szmrFalseStarts: number | null;
  szmrWrong: number | null;
  /** Presses on no-go. */
  gonogoCommissions: number | null;
  /** Misses and late answers on go. */
  gonogoOmissions: number | null;
  /** Outcomes `early` and `timing_late` of РДО. */
  rdoEarly: number | null;
  rdoLate: number | null;
  /** Mean signed error of РДО (meanSignedErrorMs), ms: below 0 before the mark. */
  rdoSignedBiasMs: number | null;
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
  pzmrSdRt: null,
  szmrSdRt: null,
  pzmrIqrRt: null,
  szmrIqrRt: null,
  pzmrFalseStarts: null,
  szmrFalseStarts: null,
  szmrWrong: null,
  gonogoCommissions: null,
  gonogoOmissions: null,
  rdoEarly: null,
  rdoLate: null,
  rdoSignedBiasMs: null,
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

/** Restarts of a module's tasks in one diagnostic (F11): by Esc (one per task) and after a focus loss. */
export interface ModuleRestarts {
  user: number;
  focus: number;
}

/** Results of one control diagnostic as stored (resultsJson). */
export interface DiagnosticResults extends DiagnosticMetrics {
  /**
   * Reaction modules whose block stayed timingUnreliable after its one replay (I1). Their values are kept and
   * used by readiness, but every screen marks them «замер ненадёжен». Rows stored before 0.1.0 lack it: read as [].
   */
  unreliable: readonly ReactionModuleId[];
  /** The modules whose tasks were restarted (F11); rows stored before 0.3.0 lack it: read as {}. */
  restarts: Partial<Record<ModuleId, ModuleRestarts>>;
  /**
   * Горбов's three tasks played one table (F10). Rows stored before 0.3.0 lack it: read as false (three tables, not
   * comparable with one).
   */
  gorbovOneTable: boolean;
}

/** What makes two diagnostics comparable: Горбов on one table or on three (F10). */
export type DiagnosticFormat = Pick<DiagnosticResults, 'gorbovOneTable'>;

/**
 * Results with every metric missing, nothing unreliable, no restarts and Горбов on three tables (a stored row without
 * the flag): the base of results built in tests and code.
 */
export const EMPTY_RESULTS: Readonly<DiagnosticResults> = Object.freeze({
  ...EMPTY_METRICS,
  unreliable: Object.freeze([]),
  restarts: Object.freeze({}),
  gorbovOneTable: false,
});

const REACTION_IDS: readonly string[] = REACTION_MODULE_IDS;
export const isReactionId = (v: unknown): v is ReactionModuleId => typeof v === 'string' && REACTION_IDS.includes(v);

type NumberMetric = Exclude<keyof DiagnosticMetrics, 'gorbov'>;
const NUMBER_METRICS = Object.keys(EMPTY_METRICS).filter((k): k is NumberMetric => k !== 'gorbov');

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A count: a whole number from 0; anything else reads as 0. */
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
const MODULES: readonly string[] = MODULE_IDS;

/**
 * The restarts of a stored row (F11, T-R22): an entry of a known module whose value is an object, each count a whole
 * number from 0 (a damaged one reads 0); an entry with nothing counted, of an unknown module or not an object is left out.
 */
function restartsOf(v: unknown): DiagnosticResults['restarts'] {
  const restarts: DiagnosticResults['restarts'] = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return restarts;
  for (const [module, entry] of Object.entries(v as Readonly<Record<string, unknown>>)) {
    if (!MODULES.includes(module) || typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const e = entry as Readonly<Record<string, unknown>>;
    const read = { user: count(e['user']), focus: count(e['focus']) };
    if (read.user + read.focus > 0) restarts[module as ModuleId] = read;
  }
  return restarts;
}

/** Горбов needs all three of V, P and Π as finite numbers; anything else reads as not measured. */
function gorbovOf(v: unknown): DiagnosticMetrics['gorbov'] {
  if (typeof v !== 'object' || v === null) return null;
  const g = v as Readonly<Record<string, unknown>>;
  const [V, P, Pi] = [finite(g['V']), finite(g['P']), finite(g['Pi'])];
  return V === null || P === null || Pi === null ? null : { V, P, Pi };
}

/**
 * The stored results of a diagnostic, or null when the row does not hold a JSON object. A missing metric
 * reads as null (the W2 metrics of a 0.1.0 row, the mean RTs and F7 metrics of a 0.2.0 one: missing, never 0); rows written before `unreliable` existed
 * read as reliable (I1), rows without `restarts` as having none (F11). A damaged or imported row is read field by field
 * (FW9, T-R22): a metric that is not a finite number, or a Горбов result without numeric V, P and Π, reads as null; damaged
 * restarts as restartsOf reads them; a gorbovOneTable that is not `true` reads false (F10); unknown entries are dropped.
 * Structural: DiagnosticRow fits.
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
  return { ...metrics, unreliable, restarts: restartsOf(r['restarts']), gorbovOneTable: r['gorbovOneTable'] === true };
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
 * The reaction segments of the diagnostic, as in 0.2.0: planDiagnostic builds them from this table, and the
 * test-format runs take their volume from it. fixedL is the level the diagnostic stores and shows; the block plays
 * DIAGNOSTIC_PARAMS (src/modules/reaction/diagnosticParams.ts), never params(fixedL).
 */
export const DIAGNOSTIC_VOLUME: Readonly<
  Record<ReactionModuleId, Readonly<{ fixedL: number; trialCount: number; practiceTrials: number }>>
> = Object.freeze({
  pzmr: Object.freeze({ fixedL: 0, trialCount: 50, practiceTrials: 5 }),
  szmr: Object.freeze({ fixedL: 0, trialCount: 70, practiceTrials: 5 }),
  gonogo: Object.freeze({ fixedL: 10, trialCount: 60, practiceTrials: 5 }),
  rdo: Object.freeze({ fixedL: 0, trialCount: 50, practiceTrials: 5 }),
  pomeh: Object.freeze({ fixedL: 8, trialCount: 40, practiceTrials: 5 }),
  stroop: Object.freeze({ fixedL: 8, trialCount: 48, practiceTrials: 5 }),
  taskswitch: Object.freeze({ fixedL: 5, trialCount: 48, practiceTrials: 5 }),
});

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
  const reaction = (module: ReactionModuleId): Segment => segment(module, { ...DIAGNOSTIC_VOLUME[module] });
  return {
    kind: 'diagnostic',
    seed: hashString('diag:' + String(seedIndex)),
    diagnosticNumber: n,
    diagnosticSeedIndex: seedIndex,
    segments: [
      reaction('pzmr'),
      reaction('szmr'),
      reaction('gonogo'),
      reaction('rdo'),
      segment('gorbov', { fixedL: 0, runs: 3 }),
      segment('numseries', { items: SERIES_ITEMS, totalTimeLimitMs: 600_000 }),
      reaction('pomeh'),
      reaction('stroop'),
      reaction('taskswitch'),
      segment('memory', {}),
    ],
  };
}
