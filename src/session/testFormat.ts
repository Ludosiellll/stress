import type { TestFormatId } from '../engine/planner';
import { isCleanHitRt } from '../engine/reaction/summary';
import type { Outcome, TrialResult } from '../engine/reaction/types';
import { mean, sdTrimmed } from '../engine/stats';
import { parseObject } from './blockHistory';
import { plural, whole } from './steps';

/**
 * The test-format runs (F4, Справочник): the metrics of one run, stored as summaryJson.testFormat, the personal best
 * of the earlier runs of a format, and the texts of the run.
 */

/**
 * Mean and SD: ПЗМР, СЗМР, Go/No-Go — of the clean hit RTs (SD trimmed at 3 SD); РДО — the mean |error| and the
 * trimmed SD of the signed errors. null: no value (an SD needs two). `thirds`: the mean of the same values in each
 * third of the trials (for a later report on the drop over a run; not shown).
 */
export interface TestFormatMetrics {
  mean: number | null;
  sd: number | null;
  errors: number;
  falseStarts: number;
  thirds: [number | null, number | null, number | null];
}

/** The lowest value of each metric over the earlier runs of a format. */
export type TestFormatBest = Omit<TestFormatMetrics, 'thirds'>;

/** The short names of the formats (Home, the summary, «Прогресс»). */
export const TEST_FORMAT_NAMES: Readonly<Record<TestFormatId, string>> = Object.freeze({
  pzmr: 'ПЗМР',
  szmr: 'СЗМР',
  gonogo: 'Go/No-Go',
  rdo: 'РДО',
});

/** What counts as an error of a run, by format (the false starts are a metric of their own). */
const ERROR_OUTCOMES: Readonly<Record<TestFormatId, readonly Outcome[]>> = {
  pzmr: ['miss', 'late'],
  szmr: ['wrong', 'miss', 'late'],
  gonogo: ['commission', 'miss', 'late'],
  rdo: ['early', 'timing_late'],
};

/** The value a trial adds to the mean: a clean hit's RT, РДО's |error| of an answer with the right key; null: none. */
function meanValue(module: TestFormatId, r: TrialResult): number | null {
  if (module === 'rdo') return r.errorMs === null ? null : Math.abs(r.errorMs);
  return isCleanHitRt(r) ? r.rtMs : null;
}

/** The value a trial adds to the SD: the same RT, or РДО's signed error. */
function spreadValue(module: TestFormatId, r: TrialResult): number | null {
  return module === 'rdo' ? r.errorMs : meanValue(module, r);
}

const values = (xs: readonly (number | null)[]): number[] => xs.filter((x): x is number => x !== null);
const meanOrNull = (xs: readonly number[]): number | null => (xs.length === 0 ? null : mean(xs));

/** The metrics of a run from its trial results; practice trials are left out. */
export function testFormatMetrics(module: TestFormatId, results: readonly TrialResult[]): TestFormatMetrics {
  const trials = results.filter((r) => !r.practice);
  const n = trials.length;
  const errorOutcomes = ERROR_OUTCOMES[module];
  const spread = values(trials.map((r) => spreadValue(module, r)));
  const third = (from: number, to: number): number | null => meanOrNull(values(trials.slice(from, to).map((r) => meanValue(module, r))));
  const cut1 = Math.floor(n / 3);
  const cut2 = Math.floor((2 * n) / 3);
  return {
    mean: meanOrNull(values(trials.map((r) => meanValue(module, r)))),
    sd: spread.length < 2 ? null : sdTrimmed(spread),
    errors: trials.filter((r) => errorOutcomes.includes(r.outcome)).length,
    falseStarts: trials.filter((r) => r.outcome === 'false_start').length,
    thirds: [third(0, cut1), third(cut1, cut2), third(cut2, n)],
  };
}

/** The lowest of the values; null without any. */
function lowest(xs: readonly (number | null)[]): number | null {
  const known = values(xs);
  return known.length === 0 ? null : Math.min(...known);
}

/** The lowest value of each metric over the runs (a metric without a value is left out of its minimum); none: null. */
export function testFormatBest(runs: readonly TestFormatMetrics[]): TestFormatBest | null {
  if (runs.length === 0) return null;
  return {
    mean: lowest(runs.map((r) => r.mean)),
    sd: lowest(runs.map((r) => r.sd)),
    errors: Math.min(...runs.map((r) => r.errors)),
    falseStarts: Math.min(...runs.map((r) => r.falseStarts)),
  };
}

const DASH = '—';
const shown = (v: number | null): string => (v === null ? DASH : String(whole(v)));
/** Strictly better than the best as shown (О2): an equal rounded value is no new best; a missing value never is. */
const beats = (v: number | null, best: number | null): boolean => v !== null && best !== null && whole(v) < whole(best);

/** One metric of the summary line: as shown, with « (лучшее …)» when there is a best, and whether it beats it. */
interface Part {
  label: string;
  /** In «Новый лучший результат: …». */
  name: string;
  text: string;
  record: boolean;
}

/**
 * The summary lines of a run: «Среднее 352 мс (лучшее 341) · SD 57 мс (лучшее 58) · ошибки 2 (лучшее 1) · фальстарты 0
 * (лучшее 0)» (РДО: «Отклонение …»), then the metrics that beat the best («Новый лучший результат: SD»), or, without
 * earlier runs of the format, that there is nothing to compare with yet. Whole ms; a missing value is a dash.
 */
export function testFormatLines(module: TestFormatId, m: TestFormatMetrics, best: TestFormatBest | null): string[] {
  const ms = (v: number | null): string => (v === null ? DASH : `${shown(v)} мс`);
  const part = (label: string, name: string, value: string, current: number | null, of: (b: TestFormatBest) => number | null): Part => ({
    label,
    name,
    text: best === null ? `${label} ${value}` : `${label} ${value} (лучшее ${shown(of(best))})`,
    record: best !== null && beats(current, of(best)),
  });
  const rdo = module === 'rdo';
  const parts = [
    part(rdo ? 'Отклонение' : 'Среднее', rdo ? 'отклонение' : 'среднее', ms(m.mean), m.mean, (b) => b.mean),
    part('SD', 'SD', ms(m.sd), m.sd, (b) => b.sd),
    part('ошибки', 'ошибки', String(m.errors), m.errors, (b) => b.errors),
    part('фальстарты', 'фальстарты', String(m.falseStarts), m.falseStarts, (b) => b.falseStarts),
  ];
  const line = parts.map((p) => p.text).join(' · ');
  if (best === null) return [line, 'Первый прогон в этом формате: сравнивать пока не с чем.'];
  const records = parts.filter((p) => p.record).map((p) => p.name);
  return records.length === 0 ? [line] : [line, `Новый лучший результат: ${records.join(', ')}`];
}

/** «70 сигналов». */
export function signalsText(n: number): string {
  return `${String(n)} ${plural(n, 'сигнал', 'сигнала', 'сигналов')}`;
}

/** Opens the instruction of a run of `n` trials; the module's own instruction follows. */
export function testFormatInstruction(n: number): string {
  return `Прогон в формате теста: ${signalsText(n)} подряд, как на настоящем тесте. Сначала 5 пробных, потом без остановки. Итог — в конце. Уровень не меняется. `;
}

const isValue = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** summaryJson.testFormat of a stored run; null when absent or damaged (any field of the wrong type). */
export function readTestFormat(summaryJson: string): TestFormatMetrics | null {
  const raw = parseObject(summaryJson)?.['testFormat'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const t = raw as Readonly<Record<string, unknown>>;
  const { mean: m, sd, errors, falseStarts, thirds } = t;
  if (!isValue(m) || !isValue(sd) || !isCount(errors) || !isCount(falseStarts)) return null;
  if (!Array.isArray(thirds) || thirds.length !== 3) return null;
  const [a, b, c] = thirds as unknown[];
  if (!isValue(a) || !isValue(b) || !isValue(c)) return null;
  return { mean: m, sd, errors, falseStarts, thirds: [a, b, c] };
}
