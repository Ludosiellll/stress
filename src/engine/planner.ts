import { daysBetween, localDayNumber, signedDaysBetween } from './dates';
import { TAPER_DAYS, isCalibrated, type PhaseId, type PhaseInfo } from './phases';
import type { ModuleId, SessionKind } from './types';

export { daysBetween };

/**
 * Level at which a module counts as "at norm" (planner priority, R1). numseries has no level. In the modules with load
 * bands it is the first level of the first band harder than the test format (F3, spec §3.1.5).
 */
export const L_NORM: Record<ModuleId, number> = {
  pzmr: 8,
  szmr: 8,
  gonogo: 8,
  rdo: 10,
  gorbov: 12,
  schulte: 6,
  stroop: 12,
  taskswitch: 8,
  pomeh: 8,
  memory: 9,
  numseries: 0,
};

export type SegmentPurpose = 'warmup' | 'reaction' | 'attention' | 'logic' | 'diagnostic' | 'free' | 'finisher';

/**
 * An overload block of РДО, the tables or memory plays this many levels above the usual one (§6.3); a band module's
 * plays its own level with the next band's load (F3).
 */
export const OVERLOAD_LEVEL_STEP = 3;

/** `budgetMs === 0` means fixed volume (Ruling R16): the controller uses trialCount / runs / items instead of time. */
export interface Segment {
  module: ModuleId;
  budgetMs: number;
  purpose: SegmentPurpose;
  /**
   * finisher: every block is an overload block; mix (a module on a plateau, never in the taper): the odd blocks are.
   * A band module's overload block plays the segment level with the next band's load, its finisher starts at L_saved
   * (F3); the others play OVERLOAD_LEVEL_STEP higher. Overload blocks never move L_saved, fatigue, the g = 2 rule or the
   * module's level in the session.
   */
  overload?: 'finisher' | 'mix';
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
  /** Training plans: the phase they were planned in (stored with the session). */
  phase?: PhaseId;
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

/** Pools of the training slots (§7.1). Pool order is the tie order at equal priority. */
export const REACTION_POOL: readonly ModuleId[] = ['szmr', 'gonogo', 'rdo', 'pomeh', 'pzmr'];
export const ATTENTION_POOL: readonly ModuleId[] = ['gorbov', 'schulte', 'stroop', 'taskswitch'];
/** The «внимание и память» slot; the module already picked for attention is left out. */
export const MEMORY_SLOT_POOL: readonly ModuleId[] = ['memory', ...ATTENTION_POOL];
export const FINISHER_POOL: readonly ModuleId[] = ['szmr', 'gonogo', 'rdo', 'pomeh', 'stroop', 'taskswitch'];

/** Reaction segments are 5 minutes, 6 in the overload phase («длинные прогоны», П5). */
export const REACTION_MINUTES = 5;
export const OVERLOAD_REACTION_MINUTES = 6;
/** Finisher length per phase; none in «База» (calibration, W2-R12) and none in the taper. */
export const FINISHER_MINUTES: Readonly<Record<PhaseId, number | null>> = { base: null, development: 3, overload: 5, taper: null };
/** Taper volume: every budget × 0.6, i.e. 40 % less. */
export const TAPER_VOLUME = 0.6;
const BUDGET_STEP_MS = 30_000;
/** Taper rehearsals (П5): two control diagnostics from TAPER_DAYS before the test date on, at least 2 days apart. */
const REHEARSALS = 2;
const REHEARSAL_GAP_DAYS = 2;

/**
 * The level of every warm-up block: one below L_saved, at least 0 (F5). The warm-up never moves a level, so it is
 * the same all session.
 */
export function warmupLevel(lSaved: number): number {
  return Math.max(0, lSaved - 1);
}

/** min(daysSince, 7)/7 + clamp(1 − L_saved/L_norm, 0, 1) + (plateau ? 0.5 : 0); never-trained counts as 7 days. */
export function modulePriority(s: ModuleState, todayIso: string): number {
  const daysSince = s.lastTrainedAt === null ? 7 : daysBetween(s.lastTrainedAt, todayIso);
  const norm = L_NORM[s.module];
  const weakness = norm > 0 ? Math.min(1, Math.max(0, 1 - s.lSaved / norm)) : 0;
  return Math.min(daysSince, 7) / 7 + weakness + (s.plateau ? 0.5 : 0);
}

/** A taper budget: × 0.6, rounded to 30 s, at least 30 s. */
export function taperBudget(ms: number): number {
  return Math.max(BUDGET_STEP_MS, Math.round((ms * TAPER_VOLUME) / BUDGET_STEP_MS) * BUDGET_STEP_MS);
}

/** `modules` by priority, highest first; ties keep the given order. */
function byPriority(modules: readonly ModuleId[], states: Record<ModuleId, ModuleState>, todayIso: string): ModuleId[] {
  return modules
    .map((module, order) => ({ module, order, priority: modulePriority(states[module], todayIso) }))
    .sort((a, b) => b.priority - a.priority || a.order - b.order)
    .map((r) => r.module);
}

/**
 * `count` modules of `pool` (without `exclude`) by priority. In the taper, never-trained modules are left out; if
 * fewer than `count` remain, the free slots take the first modules of the pool in order.
 */
function pick(
  pool: readonly ModuleId[],
  count: number,
  ctx: { states: Record<ModuleId, ModuleState>; todayIso: string; taper: boolean },
  exclude: ModuleId | null = null,
): ModuleId[] {
  const open = pool.filter((m) => m !== exclude);
  const eligible = ctx.taper ? open.filter((m) => ctx.states[m].lifetimeBlocks > 0) : open;
  const picked = byPriority(eligible, ctx.states, ctx.todayIso).slice(0, count);
  for (const m of open) {
    if (picked.length >= count) break;
    if (!picked.includes(m)) picked.push(m);
  }
  return picked;
}

/**
 * The daily session (§7.1) for the phase (§7.2): ПЗМР warm-up 2 min (at warmupLevel, F5); two reaction modules
 * 5 min each (6 in the overload phase; ПЗМР is in their pool too, F5); an attention module and a memory-or-attention
 * module 5 min each; number series 10 min; then the finisher (3 min in development, 5 in overload; none in base and
 * taper). The taper scales every budget by 0.6 (to 30 s) and skips never-trained modules. A reaction, attention or
 * memory segment whose module is on a plateau mixes in overload blocks; the warm-up and the finisher never do, and
 * nothing does in the taper (it cuts the load).
 */
export function planTraining(
  states: Record<ModuleId, ModuleState>,
  todayIso: string,
  seed: number,
  phase: PhaseInfo,
): SessionPlan {
  const taper = phase.phase === 'taper';
  const ctx = { states, todayIso, taper };
  const budget = (minutes: number): number => (taper ? taperBudget(minutes * MS_PER_MIN) : minutes * MS_PER_MIN);
  const slot = (module: ModuleId, minutes: number, purpose: SegmentPurpose): Segment =>
    states[module].plateau && !taper
      ? { module, budgetMs: budget(minutes), purpose, overload: 'mix' }
      : { module, budgetMs: budget(minutes), purpose };

  const reactionMinutes = phase.phase === 'overload' ? OVERLOAD_REACTION_MINUTES : REACTION_MINUTES;
  const [first, second] = pick(REACTION_POOL, 2, ctx) as [ModuleId, ModuleId];
  const [attention] = pick(ATTENTION_POOL, 1, ctx) as [ModuleId];
  const [memorySlot] = pick(MEMORY_SLOT_POOL, 1, ctx, attention) as [ModuleId];
  const segments: Segment[] = [
    { module: 'pzmr', budgetMs: budget(2), purpose: 'warmup' },
    slot(first, reactionMinutes, 'reaction'),
    slot(second, reactionMinutes, 'reaction'),
    slot(attention, 5, 'attention'),
    slot(memorySlot, 5, 'attention'),
    { module: 'numseries', budgetMs: budget(10), purpose: 'logic' },
  ];

  const finisherMinutes = FINISHER_MINUTES[phase.phase];
  if (finisherMinutes !== null) {
    const inPlan = new Set(segments.map((s) => s.module));
    const [finisher] = byPriority(
      FINISHER_POOL.filter((m) => !inPlan.has(m) && isCalibrated(states[m])),
      states,
      todayIso,
    );
    if (finisher !== undefined) {
      segments.push({ module: finisher, budgetMs: finisherMinutes * MS_PER_MIN, purpose: 'finisher', overload: 'finisher' });
    }
  }
  return { kind: 'training', seed, phase: phase.phase, segments };
}

/**
 * A taper rehearsal (П5) is due when fewer than two control diagnostics fall on or after (test date − 9 days) and
 * the last one was at least 2 days ago (or there is none). Never outside the taper. Days are local calendar days.
 */
export function isRehearsalDue(
  phase: PhaseInfo,
  diagnosticDates: readonly string[],
  testDate: string | null,
  todayIso: string,
): boolean {
  if (phase.phase !== 'taper' || testDate === null) return false;
  const rehearsals = diagnosticDates.filter((d) => signedDaysBetween(d, testDate) <= TAPER_DAYS).length;
  if (rehearsals >= REHEARSALS) return false;
  if (diagnosticDates.length === 0) return true;
  const last = Math.max(...diagnosticDates.map(localDayNumber));
  return localDayNumber(todayIso) - last >= REHEARSAL_GAP_DAYS;
}

export function planFree(module: ModuleId, seed: number): SessionPlan {
  return { kind: 'free', seed, segments: [{ module, budgetMs: 5 * MS_PER_MIN, purpose: 'free' }] };
}

/** A control diagnostic is due if none was done yet or ≥ 14 days have passed since the last one. */
export function isDiagnosticDue(lastIso: string | null, todayIso: string): boolean {
  return lastIso === null || daysBetween(lastIso, todayIso) >= DIAGNOSTIC_INTERVAL_DAYS;
}
