import type { DiagnosticResults } from '../engine/diagnostic';
import { BASE_ITEM_LIMIT_MS } from '../engine/itemLimit';
import { condCost, type ConditionStats } from '../engine/reaction/conditions';
import type { Outcome, ReactionSummary, TrialCond, TrialSpec } from '../engine/reaction/types';
import type { BlockFlag, InputKey, LayoutId, ModuleId, ReactionModuleId, TableModuleId } from '../engine/types';
import type { ParamChange } from '../modules/describe';
import type { BlockStressors } from '../modules/reaction/common';
import type { TimedSeriesItem } from '../modules/numseries/generate';
import type { TableCell, TableParams, TableTaskId } from '../modules/tables/gorbov';
import type { TableRunResult } from '../modules/tables/score';

/** What the session screen shows now; the UI renders `controller.step` and reports back through the controller. */
export type Step =
  | { kind: 'instruction'; module: ModuleId; text: string; keysHint: string }
  | {
      kind: 'reaction_block';
      module: ReactionModuleId;
      L: number;
      specs: TrialSpec[];
      /** Every key the block accepts (attachInput's allowed keys). */
      keys: InputKey[];
      /** Effective layout: 'keyboard' when the mouse cannot serve this many keys. */
      layout: LayoutId;
      /** Key hint under the stimulus (ReactionModule.legend); null: none. */
      legend: string | null;
      /** Noise and sound of the block (stressorsOf); `seed` = deriveSeed(block seed, 'layers') feeds both. */
      layers: BlockStressors & { seed: number };
    }
  | {
      kind: 'table_block';
      module: TableModuleId;
      L: number;
      task: TableTaskId;
      cells: TableCell[];
      params: TableParams;
      /** Block seed; TableView reshuffles with it. */
      seed: number;
    }
  /** Every item carries its own limit (training, R36); diagnostic items have none and `totalLimitMs` applies. */
  | { kind: 'numseries_block'; items: TimedSeriesItem[]; totalLimitMs: number | null }
  | { kind: 'summary'; view: BlockSummaryView }
  /** Diagnostics: the reaction block just played was timingUnreliable and is replayed once (I1); ackNotice() starts it. */
  | { kind: 'notice'; module: ReactionModuleId; text: string }
  | { kind: 'fatigue_prompt'; module: ModuleId }
  /** canAbandon: abandonPending() may drop the unsaved writes (not for the session row itself). */
  | { kind: 'save_error'; message: string; canAbandon: boolean; what: SaveErrorWhat }
  | { kind: 'wellbeing' }
  /** seriesTotal: number-series items of a diagnostic (for «14 из 20»); null otherwise or if that block was not stored. */
  | { kind: 'done'; sessionId: string; diagnostic: DiagnosticResults | null; seriesTotal: number | null };

/**
 * Which writes failed (Ruling R32): `block` — the block itself (skipping drops it as if it was never played);
 * `block_cache` — only the cached level/ratings after the block was stored (rebuilt at the next start);
 * `session_start` — the session row; `session_end` — the session end (and wellbeing / diagnostic results).
 */
export type SaveErrorWhat = 'block' | 'block_cache' | 'session_start' | 'session_end';

export type StepOf<K extends Step['kind']> = Extract<Step, { kind: K }>;

export interface BlockSummaryView {
  module: ModuleId;
  title: string;
  lBefore: number;
  lAfter: number;
  /** Only the parameters whose value changed between lBefore and lAfter. */
  changes: ParamChange[];
  /** Block score s ∈ [0, 1]. */
  score: number;
  lines: string[];
  flags: BlockFlag[];
  /** Training and free blocks of modules with a level; diagnostics play at a fixed level and hide it (M5). */
  showLevel: boolean;
}

/** One number-series answer; `given` null = no valid answer (time ran out). */
export interface SeriesAnswer {
  itemId: string;
  given: number | null;
  timeMs: number;
}

export const UNRELIABLE_REPLAY_NOTICE = 'Замер ненадёжен (пропуски кадров). Блок будет повторён.';
/** Summary line of a block that had sound which did not play (no device, a blocked context, volume 0). */
export const AUDIO_NOT_PLAYED = 'Звук не воспроизводился: проверь устройство вывода и громкость помех в настройках.';
export const SERIES_INSTRUCTION_TRAINING =
  'Найди закономерность и введи следующее число. На задачу до 40 секунд, на трудных уровнях меньше: остаток времени показывает полоса.';
export const TABLE_KEYS_HINT = 'Мышь';
export const SERIES_KEYS_HINT = 'Цифры и Enter';

/** Text of the `save_error` step. */
export function saveErrorMessage(e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e);
  return `Не удалось сохранить результаты. Они пока в памяти: не закрывай программу и повтори сохранение. Ошибка: ${detail}`;
}

/** Russian noun form for n: plural(n, 'задача', 'задачи', 'задач'). */
export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}

/** «10 минут» for whole minutes, otherwise «12 секунд». */
function durationText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s > 0 && s % 60 === 0) return `${String(s / 60)} ${plural(s / 60, 'минута', 'минуты', 'минут')}`;
  return `${String(s)} ${plural(s, 'секунда', 'секунды', 'секунд')}`;
}

/** «20 задач, общее время — 10 минут. Найди закономерность…» from the segment's item count and total limit. */
export function seriesDiagnosticInstruction(count: number, totalLimitMs: number | null): string {
  const tasks = `${String(count)} ${plural(count, 'задача', 'задачи', 'задач')}`;
  const head = totalLimitMs === null ? `${tasks}.` : `${tasks}, общее время — ${durationText(totalLimitMs)}.`;
  return `${head} Найди закономерность и введи следующее число.`;
}

/** Rounded to a whole number; never «-0». */
const whole = (x: number): number => Math.round(x) + 0;
/** Fixed decimals with a comma: 41,2. */
const decimal = (x: number, digits: number): string => x.toFixed(digits).replace('.', ',');

type CountLine = [label: string, count: (c: Record<Outcome, number>) => number];

const FALSE_STARTS: CountLine = ['Фальстарты', (c) => c.false_start];
/** A miss is no answer inside the window (spec §5), so late answers count too. */
const MISSES: CountLine = ['Пропуски', (c) => c.miss + c.late];

/** Only the error kinds that can happen in the module. */
const COUNT_LINES: Record<ReactionModuleId, readonly CountLine[]> = {
  pzmr: [FALSE_STARTS, MISSES],
  szmr: [FALSE_STARTS, MISSES, ['Ошибки выбора', (c) => c.wrong]],
  gonogo: [FALSE_STARTS, MISSES, ['Нажатия на no-go', (c) => c.commission]],
  rdo: [FALSE_STARTS, MISSES],
  stroop: [FALSE_STARTS, MISSES, ['Ошибки', (c) => c.wrong]],
  taskswitch: [FALSE_STARTS, MISSES, ['Ошибки', (c) => c.wrong]],
  pomeh: [FALSE_STARTS, MISSES, ['Ошибки выбора', (c) => c.wrong]],
};

function timingErrorLine(meanSignedErrorMs: number): string {
  const e = whole(meanSignedErrorMs);
  if (e > 0) return `Средняя ошибка: +${String(e)} мс (запаздываешь)`;
  if (e < 0) return `Средняя ошибка: −${String(-e)} мс (торопишься)`;
  return 'Средняя ошибка: 0 мс';
}

export function reactionLines(module: ReactionModuleId, s: ReactionSummary): string[] {
  const lines: string[] = [];
  if (s.medianRt !== null) lines.push(`Медиана: ${String(whole(s.medianRt))} мс`);
  if (s.meanRt !== null) lines.push(`Среднее: ${String(whole(s.meanRt))} мс`);
  if (s.sdRt !== null) lines.push(`Разброс (SD): ${String(whole(s.sdRt))} мс`);
  if (s.cvRt !== null) lines.push(`Стабильность (CV): ${decimal(s.cvRt, 2)}`);
  if (s.meanSignedErrorMs !== null) lines.push(timingErrorLine(s.meanSignedErrorMs));
  if (module === 'rdo') {
    lines.push(`Точных попаданий: ${String(s.counts.hit)} из ${String(s.n)}`);
    lines.push(`Опережений: ${String(s.counts.early)}, запаздываний: ${String(s.counts.timing_late)}`);
  }
  for (const [label, count] of COUNT_LINES[module]) lines.push(`${label}: ${String(count(s.counts))}`);
  return lines;
}

/** Signed whole milliseconds: «+90», «−30», «0». */
function signedMs(x: number): string {
  const v = whole(x);
  if (v > 0) return `+${String(v)}`;
  if (v < 0) return `−${String(-v)}`;
  return '0';
}

/** Modules that compare two kinds of trials: the fast and slow conditions with their labels, and the difference. */
interface CondLines {
  fast: [cond: TrialCond, label: string];
  slow: [cond: TrialCond, label: string];
  cost: string;
}

const COND_LINES: Partial<Record<ReactionModuleId, CondLines>> = {
  stroop: { fast: ['congruent', 'Цвет совпадает со словом'], slow: ['incongruent', 'Не совпадает'], cost: 'Интерференция' },
  taskswitch: { fast: ['repeat', 'Правило повторяется'], slow: ['switch', 'Правило сменилось'], cost: 'Цена переключения' },
  pomeh: { fast: ['quiet', 'Без помех'], slow: ['noisy', 'С помехами'], cost: 'Разница' },
};

/** «Цвет совпадает со словом: 520 мс», «Не совпадает: 610 мс», «Интерференция: +90 мс»; a line only for a known value. */
export function conditionLines(module: ReactionModuleId, stats: ConditionStats): string[] {
  const spec = COND_LINES[module];
  if (spec === undefined) return [];
  const lines: string[] = [];
  for (const [cond, label] of [spec.fast, spec.slow]) {
    const rt = stats[cond]?.medianRt ?? null;
    if (rt !== null) lines.push(`${label}: ${String(whole(rt))} мс`);
  }
  const cost = condCost(stats, spec.slow[0], spec.fast[0]);
  if (cost !== null) lines.push(`${spec.cost}: ${signedMs(cost)} мс`);
  return lines;
}

/** «Уровень не повышен: разброс выше порога (CV 0,24 > 0,19)» (I3). */
export function stabilityLine(cvRt: number, cvMax: number): string {
  return `Уровень не повышен: разброс выше порога (CV ${decimal(cvRt, 2)} > ${decimal(cvMax, 2)})`;
}

export function tableLines(r: TableRunResult): string[] {
  const time = r.timeMs === null ? 'Не закончено за лимит' : `Время: ${decimal(r.timeMs / 1000, 1)} с`;
  return [time, `Ошибки: ${String(r.errors)}`];
}

/** «12 с», or «11,9 с» for a limit that is not whole seconds (limits are multiples of 100 ms). */
function limitSeconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : decimal(s, 1);
}

/** Plus «Самый короткий лимит: 12 с» when an item of the block had less than 40 s (R36). */
export function seriesLines(correct: number, total: number, meanTimeMs: number, shortestLimitMs: number | null): string[] {
  const lines = [`Верно: ${String(correct)} из ${String(total)}`, `Среднее время: ${String(whole(meanTimeMs / 1000))} с`];
  if (shortestLimitMs !== null && shortestLimitMs < BASE_ITEM_LIMIT_MS) {
    lines.push(`Самый короткий лимит: ${limitSeconds(shortestLimitMs)} с`);
  }
  return lines;
}
