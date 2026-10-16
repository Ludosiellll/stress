import type { Repository } from '../data/repository';
import type { BlockRow, DiagnosticRow, SessionRow } from '../data/rows';
import { localDayIso, localDayNumber } from '../engine/dates';
import type { FormDay } from '../engine/dayForm';
import { sessionEndPoints, type LevelPoint } from '../engine/derive';
import { parseResults, type DiagnosticMetrics, type DiagnosticResults } from '../engine/diagnostic';
import { L_NORM, OLD_L_NORM, TEST_FORMAT_ORDER, type TestFormatId } from '../engine/planner';
import { mean, median } from '../engine/stats';
import { isBandModule, MODULE_IDS, type ModuleId, type ReactionModuleId, type SessionKind } from '../engine/types';
import { moduleTitles } from '../modules/registry';
import { assessModules, meanFamilyRating, type ModuleAssessment } from '../session/assessment';
import { buildBlockHistory, scoreFromCounts } from '../session/blockHistory';
import { pastBlocks, testFormatRunsAt, warmupDays, type PastBlocks } from '../session/pastBlocks';
import { shownCost } from '../session/steps';
import { TEST_FORMAT_NAMES, testFormatBest, type TestFormatBest } from '../session/testFormat';
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
  /**
   * The break before the first session of the load bands (Р9): its x and the norm before it (OLD_L_NORM). Only the six
   * band modules; null without a load-band session or without a session before it.
   */
  marker: { x: string; normBefore: number } | null;
}

/** The mean penalised score of the band modules' overload blocks over OVERLOAD_DAYS days and how many there were. */
export interface OverloadMean {
  mean: number;
  blocks: number;
}

/** The runs of one test format (F4): a point per run (x «дд.мм»), its best and how many runs there were. */
export interface TestFormatProgress {
  format: TestFormatId;
  name: string;
  /** The mean (РДО: the deviation) of each run; null: the run has none. */
  mean: ChartPoint[];
  sd: ChartPoint[];
  best: TestFormatBest;
  runs: number;
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
  /** «Оценка по модулям», in MODULE_IDS order. */
  assessment: ModuleAssessment[];
  diagnostics: ChartSpec[];
  /** «Форма дня»: the daily median of the ПЗМР warm-up over FORM_CHART_DAYS days (F5). */
  formOfDay: ChartPoint[];
  /** «Прогоны в формате теста»: the formats with at least one stored run, in TEST_FORMAT_ORDER (F4). */
  testFormats: TestFormatProgress[];
  levels: LevelChartSpec[];
  /** «Средний балл блоков перегрузки за 28 дней» (F3); null without such blocks. */
  overload28d: OverloadMean | null;
  /** Newest first, at most SESSION_LINES. */
  sessions: SessionLine[];
  sessionCount: number;
}

export const SESSION_LINES = 50;
/** The form-of-day chart covers today and the 29 days before it. */
export const FORM_CHART_DAYS = 30;

/** The window of overload28d: [now − 28 days, now]. */
export const OVERLOAD_DAYS = 28;
const DAY_MS = 86_400_000;

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
    reaction('rdo', 'РДО, средняя ошибка по модулю, мс', 'мс', true, 'РДО', 'rdoMeanAbsErrorMs'),
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

/**
 * One point per local day with a warm-up in the last FORM_CHART_DAYS days (today included): the median of all its
 * clean hits, whatever the band; x is «дд.мм». Days come in date order.
 */
export function formOfDayPoints(days: readonly FormDay[], today: string): ChartPoint[] {
  const end = localDayNumber(today);
  const byDay = new Map<string, number[]>();
  for (const d of days) {
    const n = localDayNumber(d.day);
    if (n > end || n <= end - FORM_CHART_DAYS || d.rts.length === 0) continue;
    byDay.set(d.day, [...(byDay.get(d.day) ?? []), ...d.rts]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, rts]) => ({ x: `${day.slice(8, 10)}.${day.slice(5, 7)}`, y: median(rts) }));
}

/** Local date, dd.mm. */
function dayMonth(iso: string): string {
  const d = new Date(iso);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}`;
}

/** Each format with stored runs (testFormatRunsAt): the points of its two charts, its best and its runs. */
export function testFormatProgress(past: PastBlocks): TestFormatProgress[] {
  return TEST_FORMAT_ORDER.flatMap((format) => {
    const runs = testFormatRunsAt(past, format);
    const best = testFormatBest(runs.map((r) => r.metrics));
    if (best === null) return [];
    return [
      {
        format,
        name: TEST_FORMAT_NAMES[format],
        mean: runs.map((r) => ({ x: dayMonth(r.at), y: r.metrics.mean })),
        sd: runs.map((r) => ({ x: dayMonth(r.at), y: r.metrics.sd })),
        best,
        runs: runs.length,
      },
    ];
  });
}

/**
 * A level chart: the session end levels as recorded (not the capped cache) and, in a band module, the marker at the
 * first load-rule session when an older session comes before it.
 */
export function levelChart(module: ModuleId, points: readonly LevelPoint[]): LevelChartSpec {
  const first = isBandModule(module) ? points.findIndex((p) => p.loadRule) : -1;
  return {
    module,
    title: moduleTitles[module],
    norm: L_NORM[module],
    series: [{ name: 'Уровень', points: points.map((p, i) => ({ x: String(i + 1), y: p.level })) }],
    marker: first > 0 ? { x: String(first + 1), normBefore: OLD_L_NORM[module] } : null,
  };
}

/** Overload blocks of the band modules started in [now − OVERLOAD_DAYS days, now], scored by scoreFromCounts. */
export function overload28d(blocks: readonly Pick<BlockRow, 'module' | 'flags' | 'startedAt' | 'summaryJson'>[], now: Date): OverloadMean | null {
  const end = now.getTime();
  const start = end - OVERLOAD_DAYS * DAY_MS;
  const scores = blocks.flatMap((b) => {
    const t = Date.parse(b.startedAt);
    if (!isBandModule(b.module) || !b.flags.includes('overload') || !(t >= start && t <= end)) return [];
    const s = scoreFromCounts(b.summaryJson);
    return s === null ? [] : [s];
  });
  return scores.length === 0 ? null : { mean: mean(scores), blocks: scores.length };
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

export async function loadProgressModel(repo: Repository, now: Date = new Date()): Promise<ProgressModel> {
  const [diagnostics, states, sessions, blocks, ratings] = await Promise.all([
    repo.listDiagnostics(),
    repo.getModuleStates(),
    repo.listSessions(),
    repo.listBlocks(),
    repo.getRatings(),
  ]);
  const blocksBySession = count(blocks.map((b) => b.sessionId));
  const points = sessionEndPoints(sessions, blocks);
  const past = pastBlocks(blocks, sessions);
  return {
    readiness: readinessOf(diagnostics),
    assessment: assessModules({ states, meanRating: meanFamilyRating(ratings), history: buildBlockHistory(blocks, sessions), now }),
    diagnostics: diagnosticCharts(diagnostics),
    formOfDay: formOfDayPoints(warmupDays(past), localDayIso(now.toISOString())),
    testFormats: testFormatProgress(past),
    levels: LEVEL_MODULES.map((module) => levelChart(module, points[module])),
    overload28d: overload28d(blocks, now),
    sessions: sessionLines(sessions, blocksBySession),
    sessionCount: sessions.length,
  };
}
