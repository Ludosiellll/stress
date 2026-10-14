import type { Repository } from '../data/repository';
import type { DiagnosticRow, SessionRow } from '../data/rows';
import type { DiagnosticResults } from '../engine/diagnostic';
import { L_NORM } from '../engine/planner';
import type { ModuleId, ReactionModuleId, SessionKind } from '../engine/types';
import { moduleTitles } from '../modules/registry';
import type { ChartDomain, ChartPoint, ChartSeries } from './charts/LineChart';
import { parseResults, readinessOf, type HomeModel } from './homeModel';

export interface ChartSpec {
  id: string;
  /** With the unit, as the card shows it. */
  title: string;
  /** Which direction is an improvement. */
  lowerIsBetter: boolean;
  yLabel: string;
  series: ChartSeries[];
  /** x labels of the diagnostics whose value was measured with dropped frames (I1); the points carry a note too. */
  unreliable: string[];
  /** Values the metric can take; the axis stays inside. */
  domain: ChartDomain;
}

/** Times, errors, counts and levels are never negative; Go/No-Go is a percentage. */
const NON_NEGATIVE: ChartDomain = { min: 0 };
const PERCENT: ChartDomain = { min: 0, max: 100 };

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

const UNRELIABLE_NOTE = 'замер ненадёжен';

/** The numeric metrics of DiagnosticResults (gorbov is an object). */
type NumericMetric = 'pzmrMedianRt' | 'szmrMedianRt' | 'gonogoScore' | 'rdoMeanAbsErrorMs' | 'numseriesCorrect';

/**
 * One chart per metric of the control diagnostics; a missing metric is a gap, never a zero. A value measured
 * with dropped frames (DiagnosticResults.unreliable) keeps its point, with a note on it and under the chart.
 */
export function diagnosticCharts(rows: readonly DiagnosticRow[]): ChartSpec[] {
  const parsed = rows.map((row) => ({ x: `№${String(row.number)}`, r: parseResults(row) }));
  const shaky = (module: ReactionModuleId | null, r: DiagnosticResults | null): boolean =>
    module !== null && r !== null && r.unreliable.includes(module);
  const line = (name: string, pick: (r: DiagnosticResults | null) => number | null, module: ReactionModuleId | null = null): ChartSeries => ({
    name,
    points: parsed.map<ChartPoint>(({ x, r }) => {
      const y = pick(r);
      return y !== null && shaky(module, r) ? { x, y, note: UNRELIABLE_NOTE } : { x, y };
    }),
  });
  const metric = (r: DiagnosticResults | null, key: NumericMetric): number | null => num(r?.[key]);
  const reaction = (
    id: ReactionModuleId,
    title: string,
    yLabel: string,
    lowerIsBetter: boolean,
    name: string,
    key: NumericMetric,
    domain: ChartDomain = NON_NEGATIVE,
  ): ChartSpec => {
    const series = [line(name, (r) => metric(r, key), id)];
    const unreliable = (series[0]?.points ?? []).flatMap((p) => (p.note === undefined ? [] : [p.x]));
    return { id, title, yLabel, lowerIsBetter, series, unreliable, domain };
  };
  return [
    reaction('pzmr', 'ПЗМР, медиана, мс', 'мс', true, 'ПЗМР', 'pzmrMedianRt'),
    reaction('szmr', 'СЗМР, медиана, мс', 'мс', true, 'СЗМР', 'szmrMedianRt'),
    reaction('gonogo', 'Go/No-Go, точность, %', '%', false, 'Go/No-Go', 'gonogoScore', PERCENT),
    reaction('rdo', 'РДО, средняя ошибка, мс', 'мс', true, 'РДО', 'rdoMeanAbsErrorMs'),
    {
      id: 'gorbov',
      title: 'Таблица Горбова: V, P, Π, с',
      yLabel: 'с',
      lowerIsBetter: true,
      series: [line('V', (r) => gorbovOf(r).V), line('P', (r) => gorbovOf(r).P), line('Π', (r) => gorbovOf(r).Pi)],
      unreliable: [],
      // Π = t3 − (t1 + t2) is usually negative: no bound.
      domain: {},
    },
    {
      id: 'numseries',
      title: 'Числовые ряды, верно из 20',
      yLabel: 'верно из 20',
      lowerIsBetter: false,
      series: [line('Числовые ряды', (r) => metric(r, 'numseriesCorrect'))],
      unreliable: [],
      domain: NON_NEGATIVE,
    },
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
