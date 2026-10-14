import { daysBetween } from './dates';
import type { ModuleId, ReactionModuleId, SessionKind } from './types';

export { daysBetween };

/** Level at which a module counts as "at norm" (planner priority, R1). numseries has no level. */
export const L_NORM: Record<ModuleId, number> = {
  pzmr: 14,
  szmr: 12,
  gonogo: 10,
  rdo: 10,
  gorbov: 12,
  schulte: 6,
  stroop: 10,
  taskswitch: 10,
  numseries: 0,
};

export type SegmentPurpose = 'warmup' | 'reaction' | 'attention' | 'logic' | 'diagnostic' | 'free';

/** `budgetMs === 0` means fixed volume (Ruling R16): the controller uses trialCount / runs / items instead of time. */
export interface Segment {
  module: ModuleId;
  budgetMs: number;
  purpose: SegmentPurpose;
  fixedL?: number;
  trialCount?: number;
  practiceTrials?: number;
  runs?: number;
  items?: number;
  totalTimeLimitMs?: number;
}

export interface SessionPlan {
  kind: SessionKind;
  segments: Segment[];
  seed: number;
  diagnosticNumber?: number;
  /** Diagnostics: the index their block seeds come from (diagnosticSegmentSeed); diagnosticNumber when absent. */
  diagnosticSeedIndex?: number;
}

export interface ModuleState {
  module: ModuleId;
  lSaved: number;
  sessionEndLevels: number[];
  savedHistory: number[];
  plateau: boolean;
  lastTrainedAt: string | null;
  lifetimeBlocks: number;
}

const MS_PER_MIN = 60_000;
const DIAGNOSTIC_INTERVAL_DAYS = 14;
/** Tie order for the reaction slots: earlier wins. */
const REACTION_CANDIDATES: readonly ReactionModuleId[] = ['szmr', 'gonogo', 'rdo'];

/** min(daysSince, 7)/7 + clamp(1 − L_saved/L_norm, 0, 1) + (plateau ? 0.5 : 0); never-trained counts as 7 days. */
export function modulePriority(s: ModuleState, todayIso: string): number {
  const daysSince = s.lastTrainedAt === null ? 7 : daysBetween(s.lastTrainedAt, todayIso);
  const norm = L_NORM[s.module];
  const weakness = norm > 0 ? Math.min(1, Math.max(0, 1 - s.lSaved / norm)) : 0;
  return Math.min(daysSince, 7) / 7 + weakness + (s.plateau ? 0.5 : 0);
}

export function planTraining(states: Record<ModuleId, ModuleState>, todayIso: string, seed: number): SessionPlan {
  const ranked = REACTION_CANDIDATES.map((module, order) => ({
    module,
    order,
    priority: modulePriority(states[module], todayIso),
  })).sort((a, b) => b.priority - a.priority || a.order - b.order);
  const [first, second] = ranked as [(typeof ranked)[number], (typeof ranked)[number]];
  return {
    kind: 'training',
    seed,
    segments: [
      { module: 'pzmr', budgetMs: 2 * MS_PER_MIN, purpose: 'warmup' },
      { module: first.module, budgetMs: 5 * MS_PER_MIN, purpose: 'reaction' },
      { module: second.module, budgetMs: 5 * MS_PER_MIN, purpose: 'reaction' },
      { module: 'gorbov', budgetMs: 6 * MS_PER_MIN, purpose: 'attention' },
      { module: 'schulte', budgetMs: 4 * MS_PER_MIN, purpose: 'attention' },
      { module: 'numseries', budgetMs: 10 * MS_PER_MIN, purpose: 'logic' },
    ],
  };
}

export function planFree(module: ModuleId, seed: number): SessionPlan {
  return { kind: 'free', seed, segments: [{ module, budgetMs: 5 * MS_PER_MIN, purpose: 'free' }] };
}

/** A control diagnostic is due if none was done yet or ≥ 14 days have passed since the last one. */
export function isDiagnosticDue(lastIso: string | null, todayIso: string): boolean {
  return lastIso === null || daysBetween(lastIso, todayIso) >= DIAGNOSTIC_INTERVAL_DAYS;
}
