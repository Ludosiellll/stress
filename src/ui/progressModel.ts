import type { Repository } from '../data/repository';
import type { DiagnosticRow, SessionRow } from '../data/rows';
import { parseResults, type DiagnosticMetrics, type DiagnosticResults } from '../engine/diagnostic';
import { L_NORM } from '../engine/planner';
import { MODULE_IDS, type ModuleId, type ReactionModuleId, type SessionKind } from '../engine/types';
import { moduleTitles } from '../modules/registry';
import { shownCost } from '../session/steps';
import type { ChartDomain, ChartPoint, ChartSeries } from './charts/LineChart';
import { readinessOf, type HomeModel } from './homeModel';

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
  /** Whole units (ms, %, counts): rounded as the results table rounds them, whole ticks (B6). */
  whole: boolean;
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
const LEVEL_MODULES: readonly ModuleId[] = MODULE_IDS.filter((m) => m !== 'numseries');

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

/** How many times each key occurs. */
function count<T>(keys: readonly T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

/**
 * x labels of the diagnostics: «№2». A number two diagnostics share (after a restore merge) gets the local date,
 * «№1 (05.10)», and the time too when they share the day, «№1 (01.10 09:30)», so no label shows twice.
 */
function diagnosticLabels(rows: readonly DiagnosticRow[]): string[] {
  const numbers = count(rows.map((r) => r.number));
  const day = (iso: string): string => {
    const d = new Date(iso);
    return `${two(d.getDate())}.${two(d.getMonth() + 1)}`;
  };
  const time = (iso: string): string => {
    const d = new Date(iso);
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
  };
  const days = count(rows.map((r) => `${String(r.number)} ${day(r.at)}`));
  return rows.map((r) => {
    const n = `№${String(r.number)}`;
    if ((numbers.get(r.number) ?? 0) < 2) return n;
    const sameDay = (days.get(`${String(r.number)} ${day(r.at)}`) ?? 0) > 1;
    return `${n} (${day(r.at)}${sameDay ? ` ${time(r.at)}` : ''})`;
  });
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function gorbovOf(r: DiagnosticResults | null): { V: number | null; P: number | null; Pi: number | null } {
  const g = r?.gorbov;
  if (typeof g !== 'object' || g === null) return { V: null, P: null, Pi: null };
  return { V: num(g.V), P: num(g.P), Pi: num(g.Pi) };
}

const UNRELIABLE_NOTE = 'замер ненадёжен';

/** The numeric metrics of DiagnosticResults (gorbov is an object). */
type NumericMetric = Exclude<keyof DiagnosticMetrics, 'gorbov'>;

/**
 * One chart per metric of the control diagnostics; a missing metric is a gap, never a zero (0.1.0 rows have no
 * W2 metrics). A value measured with dropped frames (DiagnosticResults.unreliable) keeps its point, with a note on
 * it and under the chart. Differences of medians (noise, interference, switch cost) can be negative: no bound.
 */
export function diagnosticCharts(rows: readonly DiagnosticRow[]): ChartSpec[] {
  const labels = diagnosticLabels(rows);
  const parsed = rows.map((row, i) => ({ x: labels[i] as string, r: parseResults(row) }));
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
  /** A difference as Done and the block summary show it (shownCost). */
  const cost = (fast: NumericMetric, slow: NumericMetric, stored: NumericMetric) => (r: DiagnosticResults | null): number | null =>
    shownCost(metric(r, fast), metric(r, slow), metric(r, stored));
  const reaction = (
    id: ReactionModuleId,
    title: string,
    yLabel: string,
    lowerIsBetter: boolean,
    name: string,
    key: NumericMetric | ((r: DiagnosticResults | null) => number | null),
    domain: ChartDomain = NON_NEGATIVE,
  ): ChartSpec => {
    const series = [line(name, typeof key === 'function' ? key : (r) => metric(r, key), id)];
    const unreliable = (series[0]?.points ?? []).flatMap((p) => (p.note === undefined ? [] : [p.x]));
    return { id, title, yLabel, lowerIsBetter, series, unreliable, domain, whole: true };
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
      whole: false,
    },
    {
      id: 'numseries',
      title: 'Числовые ряды, верно из 20',
      yLabel: 'верно из 20',
      lowerIsBetter: false,
      series: [line('Числовые ряды', (r) => metric(r, 'numseriesCorrect'))],
      unreliable: [],
      domain: NON_NEGATIVE,
      whole: true,
    },
    reaction('pomeh', 'Помехоустойчивость: разница, мс', 'мс', true, moduleTitles.pomeh, cost('pomehQuietRt', 'pomehNoisyRt', 'pomehDeltaMs'), {}),
    reaction('stroop', 'Струп: интерференция, мс', 'мс', true, moduleTitles.stroop, cost('stroopCongruentRt', 'stroopIncongruentRt', 'stroopInterferenceMs'), {}),
    reaction('taskswitch', 'Переключение правил: цена переключения, мс', 'мс', true, moduleTitles.taskswitch, cost('switchRepeatRt', 'switchSwitchRt', 'switchCostMs'), {}),
    {
      id: 'memory',
      title: 'Память: объём',
      yLabel: 'цифр',
      lowerIsBetter: false,
      series: [line(moduleTitles.memory, (r) => metric(r, 'memorySpan'))],
      unreliable: [],
      domain: NON_NEGATIVE,
      whole: true,
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
    Promise.all(MODULE_IDS.map((m) => repo.listBlockLevels(m))),
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
