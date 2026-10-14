import type { Repository } from '../data/repository';
import type { DiagnosticRow, SessionRow } from '../data/rows';
import { localDayNumber } from '../engine/dates';
import { MODULE_IDS } from '../engine/derive';
import { parseResults, planDiagnostic } from '../engine/diagnostic';
import { BASE_DAYS, CALIBRATION_BLOCKS, currentPhase, type PhaseId, type PhaseInfo } from '../engine/phases';
import {
  OVERLOAD_REACTION_MINUTES,
  TAPER_VOLUME,
  isDiagnosticDue,
  isRehearsalDue,
  planTraining,
  type Segment,
  type SessionPlan,
} from '../engine/planner';
import { mergedBaseline, readiness, type Ability } from '../engine/readiness';
import { hashString } from '../engine/rng';
import { computeStreak, daysUntil } from '../engine/streak';
import type { ReactionModuleId } from '../engine/types';
import { moduleTitles } from '../modules/registry';
import { budgetMinutes } from './format';

export interface HomeModel {
  plan: SessionPlan;
  diagnosticDue: boolean;
  diagnosticPlan: SessionPlan;
  /** null until the first diagnostic exists. `unreliable`: reaction modules marked «замер ненадёжен» in the latest one. */
  readiness: { abilities: Record<Ability, number | null>; overall: number | null; unreliable: ReactionModuleId[] } | null;
  streak: number;
  /** As in W1: 0 once the date has passed (the phase ignores a past date). */
  daysToTest: number | null;
  phase: PhaseInfo;
  phaseTitle: string;
  phaseWhy: string;
  /** Reminders of the taper (empty in the other phases). */
  hints: string[];
  /** A taper rehearsal is due (Home shows the regular diagnostic banner instead when that one is due). */
  rehearsalDue: boolean;
}

const NO_ABILITIES: Record<Ability, number | null> = { reaction: null, attention: null, switching: null, memory: null, logic: null };

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

const PHASE_TITLES: Record<PhaseId, string> = {
  base: 'Фаза: база',
  development: 'Фаза: развитие',
  overload: 'Фаза: перегрузка',
  taper: 'Фаза: подводка',
};

const TAPER_HINTS: readonly string[] = ['Тренируйся утром, в то же время, на которое назначен тест.', 'Перед тестом спи не меньше 8 часов.'];

const LONG_REACTION = `модули реакции по ${String(OVERLOAD_REACTION_MINUTES)} мин`;
const TAPER_RULES = `объём меньше на ${String(Math.round((1 - TAPER_VOLUME) * 100))} %, без финишера и новых модулей`;

/** The overload rules as the plan has them: the finisher is named only when the plan has one. */
function overloadRules(plan: Pick<SessionPlan, 'segments'>): string {
  const finisher = plan.segments.find((s) => s.overload === 'finisher');
  return finisher === undefined ? LONG_REACTION : `финишер ${budgetMinutes(finisher.budgetMs)} мин, ${LONG_REACTION}`;
}

/**
 * What Home says about the phase: the title, why the plan looks the way it does, and the taper reminders.
 * `plan` is the plan shown under it, so the reason never promises a finisher the plan does not have.
 */
export function phaseTexts(p: PhaseInfo, plan: Pick<SessionPlan, 'segments'>): { title: string; why: string; hints: string[] } {
  const days = String(p.daysToTest ?? 0);
  let why: string;
  switch (p.reason) {
    case 'first_days':
      why = `День ${String(p.dayNumber)} из ${String(BASE_DAYS)}: калибровка уровней и стартовая диагностика.`;
      break;
    case 'calibration':
      why = `Нужно откалибровать (по ${String(CALIBRATION_BLOCKS)} блока): ${p.uncalibrated.map((m) => moduleTitles[m]).join(', ')}.`;
      break;
    case 'weak_spots':
      why = 'Больше времени отстающим модулям и тем, что давно не тренировались.';
      break;
    case 'test_soon':
      why = `До теста ${days} дн.: ${overloadRules(plan)}.`;
      break;
    case 'day_60':
      why = `${String(p.dayNumber)}-й день тренировок, дата теста не задана: ${overloadRules(plan)}.`;
      break;
    case 'taper':
      why = p.daysToTest === 0 ? `Сегодня тест: ${TAPER_RULES}.` : `До теста ${days} дн.: ${TAPER_RULES}.`;
      break;
  }
  return { title: PHASE_TITLES[p.phase], why, hints: p.phase === 'taper' ? [...TAPER_HINTS] : [] };
}

const OVERLOAD_SUFFIX: Record<NonNullable<Segment['overload']>, string> = {
  finisher: ' — финишер с перегрузкой',
  mix: ' — с блоками перегрузки (плато)',
};

/** A line of the plan on Home: «Струп — 3 мин — финишер с перегрузкой». */
export function planLine(s: Segment): string {
  const suffix = s.overload === undefined ? '' : OVERLOAD_SUFFIX[s.overload];
  return `${moduleTitles[s.module]} — ${budgetMinutes(s.budgetMs)} мин${suffix}`;
}

/** The start of the earliest session of any kind (by local calendar day); null without sessions. */
function firstSessionAt(sessions: readonly SessionRow[]): string | null {
  let first: SessionRow | null = null;
  for (const s of sessions) {
    if (first === null || localDayNumber(s.startedAt) < localDayNumber(first.startedAt)) first = s;
  }
  return first?.startedAt ?? null;
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
  const phase = currentPhase({ firstSessionAt: firstSessionAt(sessions), today, testDate: settings.testDate, states });
  const plan = planTraining(states, today, hashString(`${today}:${String(sessions.length)}`), phase);
  const texts = phaseTexts(phase, plan);
  return {
    plan,
    diagnosticDue: isDiagnosticDue(last?.at ?? null, today),
    diagnosticPlan: planDiagnostic(diagnostics.length + 1, diagnosticsStarted + 1),
    readiness: readinessOf(diagnostics),
    streak: computeStreak(trainingDays, today),
    daysToTest: daysUntil(settings.testDate, today),
    phase,
    phaseTitle: texts.title,
    phaseWhy: texts.why,
    hints: texts.hints,
    rehearsalDue: isRehearsalDue(phase, diagnostics.map((d) => d.at), settings.testDate, today),
  };
}
