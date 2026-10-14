import type { Repository } from '../data/repository';
import type { DiagnosticRow } from '../data/rows';
import { hashString } from '../engine/rng';
import { planDiagnostic, type DiagnosticResults } from '../engine/diagnostic';
import { isDiagnosticDue, planTraining, type SessionPlan } from '../engine/planner';
import { readiness, type Ability } from '../engine/readiness';
import { computeStreak, daysUntil } from '../engine/streak';

export interface HomeModel {
  plan: SessionPlan;
  diagnosticDue: boolean;
  diagnosticPlan: SessionPlan;
  /** null until the first diagnostic exists. */
  readiness: { abilities: Record<Ability, number | null>; overall: number | null } | null;
  streak: number;
  daysToTest: number | null;
}

const NO_ABILITIES: Record<Ability, number | null> = { reaction: null, attention: null, switching: null, memory: null, logic: null };

function parseResults(row: DiagnosticRow): DiagnosticResults | null {
  try {
    const value = JSON.parse(row.resultsJson) as unknown;
    return typeof value === 'object' && value !== null ? (value as DiagnosticResults) : null;
  } catch {
    return null;
  }
}

/** Everything Home shows, computed from the repository at the given local date (YYYY-MM-DD). */
export async function loadHomeModel(repo: Repository, today: string): Promise<HomeModel> {
  const [states, sessions, diagnostics, settings] = await Promise.all([
    repo.getModuleStates(),
    repo.listSessions(),
    repo.listDiagnostics(),
    repo.getSettings(),
  ]);
  const first = diagnostics[0];
  const last = diagnostics[diagnostics.length - 1];
  const latest = last === undefined ? null : parseResults(last);
  const baseline = first === undefined ? null : parseResults(first);
  const trainingDays = sessions.flatMap((s) => (s.kind === 'training' && s.endedAt !== null ? [s.endedAt] : []));
  return {
    plan: planTraining(states, today, hashString(`${today}:${String(sessions.length)}`)),
    diagnosticDue: isDiagnosticDue(last?.at ?? null, today),
    diagnosticPlan: planDiagnostic(diagnostics.length + 1),
    readiness:
      last === undefined
        ? null
        : latest !== null && baseline !== null
          ? readiness(latest, baseline)
          : { abilities: NO_ABILITIES, overall: null },
    streak: computeStreak(trainingDays, today),
    daysToTest: daysUntil(settings.testDate, today),
  };
}
