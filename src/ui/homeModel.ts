import type { Repository } from '../data/repository';
import type { DiagnosticRow } from '../data/rows';
import { MODULE_IDS } from '../engine/derive';
import { planDiagnostic, type DiagnosticMetrics, type DiagnosticResults } from '../engine/diagnostic';
import { isDiagnosticDue, planTraining, type SessionPlan } from '../engine/planner';
import { readiness, type Ability } from '../engine/readiness';
import { hashString } from '../engine/rng';
import { computeStreak, daysUntil } from '../engine/streak';
import { REACTION_MODULE_IDS, type ReactionModuleId } from '../engine/types';

export interface HomeModel {
  plan: SessionPlan;
  diagnosticDue: boolean;
  diagnosticPlan: SessionPlan;
  /** null until the first diagnostic exists. `unreliable`: reaction modules marked «замер ненадёжен» in the latest one. */
  readiness: { abilities: Record<Ability, number | null>; overall: number | null; unreliable: ReactionModuleId[] } | null;
  streak: number;
  daysToTest: number | null;
}

const NO_ABILITIES: Record<Ability, number | null> = { reaction: null, attention: null, switching: null, memory: null, logic: null };

const REACTION_IDS: readonly string[] = REACTION_MODULE_IDS;
const isReactionId = (v: unknown): v is ReactionModuleId => typeof v === 'string' && REACTION_IDS.includes(v);

const NO_METRICS: DiagnosticMetrics = {
  pzmrMedianRt: null,
  szmrMedianRt: null,
  gonogoScore: null,
  rdoMeanAbsErrorMs: null,
  gorbov: null,
  numseriesCorrect: null,
};

/**
 * The stored results of a diagnostic, or null when the row does not hold a JSON object. A missing metric
 * reads as null; rows written before `unreliable` existed read as reliable (I1); unknown entries are dropped.
 */
export function parseResults(row: DiagnosticRow): DiagnosticResults | null {
  try {
    const value = JSON.parse(row.resultsJson) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const r = value as Partial<DiagnosticResults>;
    const unreliable = Array.isArray(r.unreliable) ? (r.unreliable as unknown[]).filter(isReactionId) : [];
    return { ...NO_METRICS, ...r, unreliable };
  } catch {
    return null;
  }
}

/** Baseline per metric (M2): the first non-null value across the diagnostics, in order. */
export function mergedBaseline(results: readonly DiagnosticResults[]): DiagnosticMetrics {
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
  };
}

/**
 * Readiness of the latest diagnostic against the merged baseline (each metric from the first diagnostic that
 * has it); null until the first diagnostic exists. Values marked unreliable still count (they are marked on screen).
 */
export function readinessOf(diagnostics: readonly DiagnosticRow[]): HomeModel['readiness'] {
  const last = diagnostics[diagnostics.length - 1];
  if (last === undefined) return null;
  const latest = parseResults(last);
  if (latest === null) return { abilities: NO_ABILITIES, overall: null, unreliable: [] };
  const all = diagnostics.flatMap((d) => parseResults(d) ?? []);
  return { ...readiness(latest, mergedBaseline(all)), unreliable: latest.unreliable };
}

/** Everything Home shows, computed from the repository at the given local date (YYYY-MM-DD). */
export async function loadHomeModel(repo: Repository, today: string): Promise<HomeModel> {
  const [states, sessions, diagnostics, settings, blockLevels] = await Promise.all([
    repo.getModuleStates(),
    repo.listSessions(),
    repo.listDiagnostics(),
    repo.getSettings(),
    Promise.all(MODULE_IDS.map((m) => repo.listBlockLevels(m))),
  ]);
  const last = diagnostics[diagnostics.length - 1];
  // A training day counts when its session ended or stored at least one block (M1: an unwritten end loses nothing).
  const withBlocks = new Set(blockLevels.flat().map((b) => b.sessionId));
  const trainingDays = sessions.flatMap((s) =>
    s.kind === 'training' && (s.endedAt !== null || withBlocks.has(s.id)) ? [s.endedAt ?? s.startedAt] : [],
  );
  // Seeds count every diagnostic ever started, so an abandoned one is not replayed with the same tables (I5).
  const diagnosticsStarted = sessions.filter((s) => s.kind === 'diagnostic').length;
  return {
    plan: planTraining(states, today, hashString(`${today}:${String(sessions.length)}`)),
    diagnosticDue: isDiagnosticDue(last?.at ?? null, today),
    diagnosticPlan: planDiagnostic(diagnostics.length + 1, diagnosticsStarted + 1),
    readiness: readinessOf(diagnostics),
    streak: computeStreak(trainingDays, today),
    daysToTest: daysUntil(settings.testDate, today),
  };
}
