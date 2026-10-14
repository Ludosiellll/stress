import type { Repository } from '../data/repository';
import type { DiagnosticRow, SessionRow } from '../data/rows';
import type { DiagnosticResults } from '../engine/diagnostic';
import { L_NORM } from '../engine/planner';
import type { ModuleId, SessionKind } from '../engine/types';
import { moduleTitles } from '../modules/registry';
import type { ChartPoint, ChartSeries } from './charts/LineChart';
import { parseResults, readinessOf, type HomeModel } from './homeModel';

export interface ChartSpec {
  id: string;
  /** With the unit, as the card shows it. */
  title: string;
  /** Which direction is an improvement. */
  lowerIsBetter: boolean;
  yLabel: string;
  series: ChartSeries[];
}

export interface LevelChartSpec {
  module: ModuleId;
  title: string;
  /** Level of the test format (L_NORM). */
  norm: number;
  series: ChartSeries[];
}

export interface SessionLine {
  id: string;
  date: string;
  type: string;
  duration: string;
  blocks: number;
}

export interface ProgressModel {
  readiness: HomeModel['readiness'];
  diagnostics: ChartSpec[];
  levels: LevelChartSpec[];
  /** Newest first, at most SESSION_LINES. */
  sessions: SessionLine[];
  sessionCount: number;
}

export const SESSION_LINES = 50;

/** Modules with a level (numseries is rated by Elo, not by L). */
const LEVEL_MODULES: readonly ModuleId[] = ['pzmr', 'szmr', 'gonogo', 'rdo', 'gorbov', 'schulte'];
const ALL_MODULES: readonly ModuleId[] = [...LEVEL_MODULES, 'numseries'];

const KIND_TITLES: Record<SessionKind, string> = { training: 'Тренировка', diagnostic: 'Диагностика', free: 'Свободная' };

const two = (n: number): string => String(n).padStart(2, '0');

/** Local date, dd.mm.yyyy. */
export function ruDate(iso: string): string {
  const d = new Date(iso);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${String(d.getFullYear())}`;
}

/** Whole minutes; «не завершена» while the session has no end. */
export function durationText(startedAt: string, endedAt: string | null): string {
  if (endedAt === null) return 'не завершена';
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? 'меньше минуты' : `${String(minutes)} мин`;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function gorbovOf(r: DiagnosticResults | null): { V: number | null; P: number | null; Pi: number | null } {
  const g = r?.gorbov;
  if (typeof g !== 'object' || g === null) return { V: null, P: null, Pi: null };
  return { V: num(g.V), P: num(g.P), Pi: num(g.Pi) };
}

/** One chart per metric of the control diagnostics; a missing metric is a gap, never a zero. */
export function diagnosticCharts(rows: readonly DiagnosticRow[]): ChartSpec[] {
  const parsed = rows.map((row) => ({ x: `№${String(row.number)}`, r: parseResults(row) }));
  const line = (name: string, pick: (r: DiagnosticResults | null) => number | null): ChartSeries => ({
    name,
    points: parsed.map<ChartPoint>(({ x, r }) => ({ x, y: pick(r) })),
  });
  const metric = (r: DiagnosticResults | null, key: keyof DiagnosticResults): number | null => num(r?.[key]);
  return [
    { id: 'pzmr', title: 'ПЗМР, медиана, мс', yLabel: 'мс', lowerIsBetter: true, series: [line('ПЗМР', (r) => metric(r, 'pzmrMedianRt'))] },
    { id: 'szmr', title: 'СЗМР, медиана, мс', yLabel: 'мс', lowerIsBetter: true, series: [line('СЗМР', (r) => metric(r, 'szmrMedianRt'))] },
    { id: 'gonogo', title: 'Go/No-Go, точность, %', yLabel: '%', lowerIsBetter: false, series: [line('Go/No-Go', (r) => metric(r, 'gonogoScore'))] },
    { id: 'rdo', title: 'РДО, средняя ошибка, мс', yLabel: 'мс', lowerIsBetter: true, series: [line('РДО', (r) => metric(r, 'rdoMeanAbsErrorMs'))] },
    {
      id: 'gorbov',
      title: 'Таблица Горбова: V, P, Π, с',
      yLabel: 'с',
      lowerIsBetter: true,
      series: [line('V', (r) => gorbovOf(r).V), line('P', (r) => gorbovOf(r).P), line('Π', (r) => gorbovOf(r).Pi)],
    },
    { id: 'numseries', title: 'Числовые ряды, верно из 20', yLabel: 'верно из 20', lowerIsBetter: false, series: [line('Числовые ряды', (r) => metric(r, 'numseriesCorrect'))] },
  ];
}

export function sessionLines(sessions: readonly SessionRow[], blocksBySession: ReadonlyMap<string, number>): SessionLine[] {
  return [...sessions]
    .reverse()
    .slice(0, SESSION_LINES)
    .map((s) => ({
      id: s.id,
      date: ruDate(s.startedAt),
      type: KIND_TITLES[s.kind],
      duration: durationText(s.startedAt, s.endedAt),
      blocks: blocksBySession.get(s.id) ?? 0,
    }));
}

export async function loadProgressModel(repo: Repository): Promise<ProgressModel> {
  const [diagnostics, states, sessions, blockLevels] = await Promise.all([
    repo.listDiagnostics(),
    repo.getModuleStates(),
    repo.listSessions(),
    Promise.all(ALL_MODULES.map((m) => repo.listBlockLevels(m))),
  ]);
  const blocksBySession = new Map<string, number>();
  for (const rows of blockLevels) {
    for (const b of rows) blocksBySession.set(b.sessionId, (blocksBySession.get(b.sessionId) ?? 0) + 1);
  }
  return {
    readiness: readinessOf(diagnostics),
    diagnostics: diagnosticCharts(diagnostics),
    levels: LEVEL_MODULES.map((module) => ({
      module,
      title: moduleTitles[module],
      norm: L_NORM[module],
      series: [
        {
          name: 'Уровень',
          points: states[module].sessionEndLevels.map((y, i) => ({ x: String(i + 1), y })),
        },
      ],
    })),
    sessions: sessionLines(sessions, blocksBySession),
    sessionCount: sessions.length,
  };
}
