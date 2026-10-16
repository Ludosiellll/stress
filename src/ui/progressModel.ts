import type { Repository } from '../data/repository';
import type { BlockRow, DiagnosticRow, SessionRow } from '../data/rows';
import { localDayIso, localDayNumber } from '../engine/dates';
import type { FormDay } from '../engine/dayForm';
import { sessionEndPoints, type LevelPoint } from '../engine/derive';
import { parseResults, type DiagnosticMetrics, type DiagnosticResults } from '../engine/diagnostic';
import { L_NORM, OLD_L_NORM, TEST_FORMAT_ORDER, type TestFormatId } from '../engine/planner';
import { readinessOfLatest } from '../engine/readiness';
import { mean, median } from '../engine/stats';
import { trend, trendWindow, type Trend } from '../engine/trend';
import { isBandModule, MODULE_IDS, type BlockFlag, type ModuleId, type ReactionModuleId, type SessionKind } from '../engine/types';
import { RDO_PERIODS } from '../modules/reaction/rdo';
import { moduleTitles } from '../modules/registry';
import { assessModules, meanFamilyRating, type ModuleAssessment } from '../session/assessment';
import { buildBlockHistory, parseObject, scoreFromCounts } from '../session/blockHistory';
import type { DiscardReason } from '../session/controller';
import { pastBlocks, testFormatRunsAt, warmupDays, type PastBlocks } from '../session/pastBlocks';
import { plural, shownCost } from '../session/steps';
import { TEST_FORMAT_NAMES, testFormatBest, type TestFormatBest } from '../session/testFormat';
import type { ChartDomain, ChartPoint, ChartSeries } from './charts/LineChart';
import { decimal } from './format';
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
  /** One per series, in series order (F7). */
  trends: TrendView[];
}

/** The unit of a trend line: ms, %, s, or none (counts, index points). */
export type TrendUnit = 'мс' | '%' | 'с' | '';

/**
 * The trend line under a chart and the noise band of one series (F7, Р19): the band is the trend line ± 2σ̂ at the x
 * of the points the trend uses; none below 3 points, where the text says when they come.
 */
export interface TrendView {
  text: string;
  /** slot: the index of the point in the series, the chart slot it draws in (T-R56). */
  band: { x: string; slot: number; lo: number; hi: number }[];
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

/** The mean signed error of the РДО blocks at one speed over OVERLOAD_DAYS days (F14); meanMs null: no block. */
export interface RdoBias {
  periodMs: number;
  meanMs: number | null;
  blocks: number;
}

/** The runs of one test format (F4): a point per run (x «дд.мм»), its best and how many runs there were. */
export interface TestFormatProgress {
  format: TestFormatId;
  name: string;
  /** The mean (РДО: the deviation) of each run; null: the run has none. */
  mean: ChartPoint[];
  sd: ChartPoint[];
  /** The trends of the two charts (F7). */
  trends: { mean: TrendView; sd: TrendView };
  best: TestFormatBest;
  runs: number;
}

/** «Прерванные блоки по неделям» (F11): one week Monday to Sunday, «дд.мм–дд.мм». */
export interface DiscardWeek {
  week: string;
  /** Blocks stopped with Esc: restarted for free or counted as 0. */
  manual: number;
  /** Of them, counted as 0 (flag `discarded`). */
  counted: number;
  /** Restarted after a focus loss. */
  focus: number;
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
  /** «Общий индекс готовности» by diagnostic (F7). */
  indexChart: ChartSpec;
  /** «Форма дня»: the daily median of the ПЗМР warm-up over FORM_CHART_DAYS days (F5). */
  formOfDay: ChartPoint[];
  /** The trend of the form-of-day chart (F7). */
  formOfDayTrend: TrendView;
  /** «Прогоны в формате теста»: the formats with at least one stored run, in TEST_FORMAT_ORDER (F4). */
  testFormats: TestFormatProgress[];
  levels: LevelChartSpec[];
  /** «Средний балл блоков перегрузки за 28 дней» (F3); null without such blocks. */
  overload28d: OverloadMean | null;
  /** «РДО: смещение по скоростям за 28 дней» (F14): one per speed, in RDO_PERIODS order. */
  rdoBias: RdoBias[];
  /** «Прерванные блоки по неделям» (F11): DISCARD_WEEKS weeks, newest first. */
  discards: DiscardWeek[];
  /** Newest first, at most SESSION_LINES. */
  sessions: SessionLine[];
  sessionCount: number;
}

export const SESSION_LINES = 50;
/** The form-of-day chart covers today and the 29 days before it. */
export const FORM_CHART_DAYS = 30;

/** The window of overload28d: [now − 28 days, now]. */
export const OVERLOAD_DAYS = 28;
/** «Прерванные блоки по неделям» covers this week and the 7 before it. */
export const DISCARD_WEEKS = 8;
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

/** Local date, dd.mm. */
function dayMonth(iso: string): string {
  const d = new Date(iso);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}`;
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

/** The local calendar day of an ISO time, the t of a trend (F7); null when it does not read as a date. */
function dayOf(iso: string): number | null {
  try {
    return localDayNumber(iso);
  } catch {
    return null;
  }
}

export const NO_TREND = 'Полоса шума и тренд появятся после 3 точек.';

const VERDICTS: Record<Trend['verdict'], string> = { better: 'лучше', worse: 'хуже', noise: 'в пределах шума' };

/**
 * «Тренд: −12 мс за 5 недель — лучше (шум ±3 мс)» (F7): the change and 2σ̂ in whole units, seconds with one decimal;
 * the period in weeks from 14 days on, else in days. With a series name: «V: тренд …». Without a trend: NO_TREND.
 */
export function trendText(t: Trend | null, unit: TrendUnit, seriesName?: string): string {
  if (t === null) return NO_TREND;
  const size = (v: number): string => (unit === 'с' ? decimal(Math.abs(v), 1) : String(Math.round(Math.abs(v))));
  const withUnit = (text: string): string => (unit === '' ? text : `${text} ${unit}`);
  const change = size(t.change);
  const signed = /^0(,0)?$/.test(change) ? '0' : `${t.change < 0 ? '−' : '+'}${change}`;
  const days = Math.round(t.days);
  const weeks = Math.round(days / 7);
  const period = days >= 14 ? `${String(weeks)} ${plural(weeks, 'неделю', 'недели', 'недель')}` : `${String(days)} дн.`;
  const line = `${withUnit(signed)} за ${period} — ${VERDICTS[t.verdict]} (шум ±${withUnit(size(2 * t.sigma))})`;
  return seriesName === undefined ? `Тренд: ${line}` : `${seriesName}: тренд ${line}`;
}

/** A chart point with its time in days; t null: no date, left out of the trend like a missing value. */
interface TimedPoint {
  x: string;
  t: number | null;
  y: number | null;
}

/**
 * The trend of a series and its band: the line ± 2σ̂ at the x of the same last ≤ 6 points by date (Р19). `points` are
 * the series' points in slot order: each band point keeps its point's index as its slot (T-R56).
 */
export function trendView(points: readonly TimedPoint[], lowerIsBetter: boolean, unit: TrendUnit, seriesName?: string): TrendView {
  const window = trendWindow(
    points.flatMap((p, slot) => (p.y === null || p.t === null ? [] : [{ x: p.x, slot, t: p.t, y: p.y }])),
  );
  const t = trend(window, lowerIsBetter);
  const band =
    t === null
      ? []
      : window.map((p) => {
          const mid = t.intercept + t.slope * p.t;
          return { x: p.x, slot: p.slot, lo: mid - 2 * t.sigma, hi: mid + 2 * t.sigma };
        });
  return { text: trendText(t, unit, seriesName), band };
}

/** One trend per series, the point at index i taken at time ts[i]; named by its series when the chart has several. */
function seriesTrends(series: readonly ChartSeries[], ts: readonly (number | null)[], lowerIsBetter: boolean, unit: TrendUnit): TrendView[] {
  const several = series.length > 1;
  return series.map((s) =>
    trendView(
      s.points.map((p, i) => ({ x: p.x, t: ts[i] ?? null, y: p.y })),
      lowerIsBetter,
      unit,
      several ? s.name : undefined,
    ),
  );
}

/**
 * x labels of the diagnostics: «№2». A number two diagnostics share (after a restore merge) gets the local date,
 * «№1 (05.10)», and the time too when they share the day, «№1 (01.10 09:30)», so no label shows twice.
 */
function diagnosticLabels(rows: readonly DiagnosticRow[]): string[] {
  const numbers = count(rows.map((r) => r.number));
  const time = (iso: string): string => {
    const d = new Date(iso);
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
  };
  const days = count(rows.map((r) => `${String(r.number)} ${dayMonth(r.at)}`));
  return rows.map((r) => {
    const n = `№${String(r.number)}`;
    if ((numbers.get(r.number) ?? 0) < 2) return n;
    const sameDay = (days.get(`${String(r.number)} ${dayMonth(r.at)}`) ?? 0) > 1;
    return `${n} (${dayMonth(r.at)}${sameDay ? ` ${time(r.at)}` : ''})`;
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
  const ts = rows.map((row) => dayOf(row.at));
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
  /** A chart before its trends; the unit of its trend lines is its y label, or none for counts. */
  type Draft = Omit<ChartSpec, 'trends'> & { unit: TrendUnit };
  const reaction = (
    id: ReactionModuleId,
    title: string,
    unit: 'мс' | '%',
    lowerIsBetter: boolean,
    name: string,
    key: NumericMetric | ((r: DiagnosticResults | null) => number | null),
    domain: ChartDomain = NON_NEGATIVE,
  ): Draft => {
    const series = [line(name, typeof key === 'function' ? key : (r) => metric(r, key), id)];
    const unreliable = (series[0]?.points ?? []).flatMap((p) => (p.note === undefined ? [] : [p.x]));
    return { id, title, yLabel: unit, unit, lowerIsBetter, series, unreliable, domain, whole: true };
  };
  const drafts: Draft[] = [
    reaction('pzmr', 'ПЗМР, медиана, мс', 'мс', true, 'ПЗМР', 'pzmrMedianRt'),
    reaction('szmr', 'СЗМР, медиана, мс', 'мс', true, 'СЗМР', 'szmrMedianRt'),
    reaction('gonogo', 'Go/No-Go, точность, %', '%', false, 'Go/No-Go', 'gonogoScore', PERCENT),
    reaction('rdo', 'РДО, средняя ошибка по модулю, мс', 'мс', true, 'РДО', 'rdoMeanAbsErrorMs'),
    {
      id: 'gorbov',
      title: 'Таблица Горбова: V, P, Π, с',
      yLabel: 'с',
      unit: 'с',
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
      unit: '',
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
      unit: '',
      lowerIsBetter: false,
      series: [line(moduleTitles.memory, (r) => metric(r, 'memorySpan'))],
      unreliable: [],
      domain: NON_NEGATIVE,
      whole: true,
    },
  ];
  return drafts.map(({ unit, ...c }) => ({ ...c, trends: seriesTrends(c.series, ts, c.lowerIsBetter, unit) }));
}

/**
 * «Общий индекс готовности» by diagnostic (F7): the overall index of each diagnostic after the ones before it, as Home
 * shows it for the latest (readinessOf); an unreadable row is a gap and no baseline for the later ones.
 */
export function indexChart(rows: readonly DiagnosticRow[]): ChartSpec {
  const labels = diagnosticLabels(rows);
  const earlier: DiagnosticMetrics[] = [];
  const points = rows.map<ChartPoint>((row, i) => {
    const x = labels[i] as string;
    const r = parseResults(row);
    if (r === null) return { x, y: null };
    const y = readinessOfLatest(earlier, r).overall;
    earlier.push(r);
    return { x, y };
  });
  const series = [{ name: 'Общий индекс', points }];
  return {
    id: 'index',
    title: 'Общий индекс готовности',
    yLabel: 'баллы',
    lowerIsBetter: false,
    series,
    unreliable: [],
    domain: PERCENT,
    whole: true,
    trends: seriesTrends(
      series,
      rows.map((row) => dayOf(row.at)),
      false,
      '',
    ),
  };
}

/**
 * One point per local day with a warm-up in the last FORM_CHART_DAYS days (today included): the median of all its
 * clean hits, whatever the band; x is «дд.мм». Days come in date order.
 */
export function formOfDayPoints(days: readonly FormDay[], today: string): ChartPoint[] {
  return formOfDayDays(days, today).map(({ x, y }) => ({ x, y }));
}

/** The trend of the form-of-day chart (F7): its points at their days; lower is better. */
export function formOfDayTrend(days: readonly FormDay[], today: string): TrendView {
  return trendView(formOfDayDays(days, today), true, 'мс');
}

function formOfDayDays(days: readonly FormDay[], today: string): { x: string; t: number; y: number }[] {
  const end = localDayNumber(today);
  const byDay = new Map<string, number[]>();
  for (const d of days) {
    const n = localDayNumber(d.day);
    if (n > end || n <= end - FORM_CHART_DAYS || d.rts.length === 0) continue;
    byDay.set(d.day, [...(byDay.get(d.day) ?? []), ...d.rts]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, rts]) => ({ x: `${day.slice(8, 10)}.${day.slice(5, 7)}`, t: localDayNumber(day), y: median(rts) }));
}

/** Each format with stored runs (testFormatRunsAt): the points of its two charts, its best and its runs. */
export function testFormatProgress(past: PastBlocks): TestFormatProgress[] {
  return TEST_FORMAT_ORDER.flatMap((format) => {
    const runs = testFormatRunsAt(past, format);
    const best = testFormatBest(runs.map((r) => r.metrics));
    if (best === null) return [];
    const timed = (pick: (m: (typeof runs)[number]['metrics']) => number | null): TimedPoint[] =>
      runs.map((r) => ({ x: dayMonth(r.at), t: dayOf(r.at), y: pick(r.metrics) }));
    return [
      {
        format,
        name: TEST_FORMAT_NAMES[format],
        mean: runs.map((r) => ({ x: dayMonth(r.at), y: r.metrics.mean })),
        sd: runs.map((r) => ({ x: dayMonth(r.at), y: r.metrics.sd })),
        trends: { mean: trendView(timed((m) => m.mean), true, 'мс'), sd: trendView(timed((m) => m.sd), true, 'мс') },
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

/**
 * Overload blocks of the band modules started in [now − OVERLOAD_DAYS days, now], scored by scoreFromCounts; a block
 * counted as 0 after Esc is left out (it measured nothing, T-R10).
 */
export function overload28d(blocks: readonly Pick<BlockRow, 'module' | 'flags' | 'startedAt' | 'summaryJson'>[], now: Date): OverloadMean | null {
  const end = now.getTime();
  const start = end - OVERLOAD_DAYS * DAY_MS;
  const scores = blocks.flatMap((b) => {
    const t = Date.parse(b.startedAt);
    if (!isBandModule(b.module) || !b.flags.includes('overload') || b.flags.includes('discarded') || !(t >= start && t <= end)) return [];
    const s = scoreFromCounts(b.summaryJson);
    return s === null ? [] : [s];
  });
  return scores.length === 0 ? null : { mean: mean(scores), blocks: scores.length };
}

/** РДО blocks that do not measure the bias: counted as 0 after Esc, or with dropped frames. */
const BIAS_OUT: readonly BlockFlag[] = ['discarded', 'timing_unreliable'];

/**
 * «РДО: смещение по скоростям за 28 дней» (F14): the mean summaryJson.meanSignedErrorMs of the РДО blocks started in
 * [now − OVERLOAD_DAYS days, now] at each speed of RDO_PERIODS, by paramsJson.periodMs, whatever the session (a block
 * at a speed measures the bias there, a diagnostic or test-format one at 3000 ms too); a block counted as 0 after Esc
 * (T-R10), one with dropped frames (their errorMs is off, T-R60), a period that is no speed (0.2.0) and an unreadable
 * bias are left out.
 */
export function rdoBias(blocks: readonly Pick<BlockRow, 'module' | 'flags' | 'startedAt' | 'paramsJson' | 'summaryJson'>[], now: Date): RdoBias[] {
  const end = now.getTime();
  const start = end - OVERLOAD_DAYS * DAY_MS;
  const bySpeed = new Map<number, number[]>(RDO_PERIODS.map((v) => [v, []]));
  for (const b of blocks) {
    const t = Date.parse(b.startedAt);
    if (b.module !== 'rdo' || b.flags.some((f) => BIAS_OUT.includes(f)) || !(t >= start && t <= end)) continue;
    const periodMs = num(parseObject(b.paramsJson)?.['periodMs']);
    const errors = periodMs === null ? undefined : bySpeed.get(periodMs);
    const e = num(parseObject(b.summaryJson)?.['meanSignedErrorMs']);
    if (errors !== undefined && e !== null) errors.push(e);
  }
  return RDO_PERIODS.map((periodMs) => {
    const errors = bySpeed.get(periodMs) ?? [];
    return { periodMs, meanMs: errors.length === 0 ? null : mean(errors), blocks: errors.length };
  });
}

/** «дд.мм» of a day number (localDayNumber). */
function dayLabel(day: number): string {
  const iso = new Date(day * DAY_MS).toISOString();
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

/** The Monday of the week of a day number (day 0, 1970-01-01, was a Thursday). */
const mondayOf = (day: number): number => day - ((((day + 3) % 7) + 7) % 7);

/** Every DiscardReason, listed by a Record so that a new reason cannot be missed. */
const RESTART_REASONS: Readonly<Record<DiscardReason, true>> = { user: true, focus_lost: true, error: true };
const isRestartReason = (v: string): v is DiscardReason => Object.hasOwn(RESTART_REASONS, v);

/** The reasons of summaryJson.restarts (F11); a damaged list or entry is none. */
function restartReasons(summaryJson: string): DiscardReason[] {
  const restarts = parseObject(summaryJson)?.['restarts'];
  if (!Array.isArray(restarts)) return [];
  return (restarts as unknown[]).flatMap((r) => {
    const reason = typeof r === 'object' && r !== null ? (r as Record<string, unknown>)['reason'] : undefined;
    return typeof reason === 'string' && isRestartReason(reason) ? [reason] : [];
  });
}

/**
 * «Прерванные блоки по неделям» (F11): DISCARD_WEEKS weeks Monday to Sunday by local day, newest first, the current one
 * included. Every stored block counts, whatever its session: its restarts by Esc (`user`) and the block itself when it
 * was counted as 0 are «вручную», the counted ones also «засчитано как 0», the restarts after a focus loss «из-за потери
 * фокуса»; restarts after a drawing error are not shown. A block whose date does not read is left out.
 */
export function discardWeeks(blocks: readonly Pick<BlockRow, 'flags' | 'startedAt' | 'summaryJson'>[], now: Date): DiscardWeek[] {
  const thisWeek = mondayOf(localDayNumber(now.toISOString()));
  const weeks = Array.from({ length: DISCARD_WEEKS }, (_, i) => {
    const monday = thisWeek - 7 * i;
    return { week: `${dayLabel(monday)}–${dayLabel(monday + 6)}`, manual: 0, counted: 0, focus: 0 };
  });
  for (const b of blocks) {
    const day = dayOf(b.startedAt);
    if (day === null) continue;
    const week = weeks[(thisWeek - mondayOf(day)) / 7];
    if (week === undefined) continue;
    if (b.flags.includes('discarded')) {
      week.manual++;
      week.counted++;
    }
    for (const reason of restartReasons(b.summaryJson)) {
      if (reason === 'user') week.manual++;
      else if (reason === 'focus_lost') week.focus++;
    }
  }
  return weeks;
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
  const today = localDayIso(now.toISOString());
  return {
    readiness: readinessOf(diagnostics),
    assessment: assessModules({ states, meanRating: meanFamilyRating(ratings), history: buildBlockHistory(blocks, sessions), now }),
    diagnostics: diagnosticCharts(diagnostics),
    indexChart: indexChart(diagnostics),
    formOfDay: formOfDayPoints(warmupDays(past), today),
    formOfDayTrend: formOfDayTrend(warmupDays(past), today),
    testFormats: testFormatProgress(past),
    levels: LEVEL_MODULES.map((module) => levelChart(module, points[module])),
    overload28d: overload28d(blocks, now),
    rdoBias: rdoBias(blocks, now),
    discards: discardWeeks(blocks, now),
    sessions: sessionLines(sessions, blocksBySession),
    sessionCount: sessions.length,
  };
}
