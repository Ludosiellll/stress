import type { DiagnosticResults } from '../engine/diagnostic';
import { BASE_ITEM_LIMIT_MS } from '../engine/itemLimit';
import { condPairOf, type ConditionStats } from '../engine/reaction/conditions';
import type { Outcome, ReactionSummary, TrialSpec } from '../engine/reaction/types';
import type { BlockFlag, InputKey, LayoutId, ModuleId, ReactionModuleId, TableModuleId } from '../engine/types';
import type { ParamChange } from '../modules/describe';
import type { MemoryTrial } from '../modules/memory/generate';
import type { MemoryMode, MemoryParams } from '../modules/memory/params';
import type { BlockStressors } from '../modules/reaction/common';
import type { TimedSeriesItem } from '../modules/numseries/generate';
import type { TableCell, TableParams, TableTaskId } from '../modules/tables/gorbov';
import type { TableRunResult } from '../modules/tables/score';
import type { BlockAssessment } from './assessment';

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
  /**
   * Training: every item carries its own limit (R36) and `totalLimitMs` is null. Diagnostic: items have none and
   * `totalLimitMs` applies. Never both: scoreSeries rejects a step with item limits and a total limit.
   */
  | { kind: 'numseries_block'; items: TimedSeriesItem[]; totalLimitMs: number | null }
  /**
   * «Память»: each trial is shown, then reproduced; answered with submitMemory. `fixed`: one answer per trial.
   * `span` (diagnostics): the span protocol, whose answers end early once spanProtocolStops says so.
   */
  | { kind: 'memory_block'; L: number; mode: MemoryMode; params: MemoryParams; trials: MemoryTrial[]; protocol: 'fixed' | 'span' }
  | { kind: 'summary'; view: BlockSummaryView }
  /** Diagnostics: the reaction block just played was timingUnreliable and is replayed once (I1); ackNotice() starts it. */
  | { kind: 'notice'; module: ReactionModuleId; text: string }
  | { kind: 'fatigue_prompt'; module: ModuleId }
  /** canAbandon: abandonPending() may drop the unsaved writes (not for the session row itself). */
  | { kind: 'save_error'; message: string; canAbandon: boolean; what: SaveErrorWhat }
  | { kind: 'wellbeing' }
  /**
   * seriesTotal: number-series items of a diagnostic (for «14 из 20»); null otherwise or if that block was not stored.
   * indexDeferred: parts of this diagnostic are their own baseline and count in the readiness index from the next one
   * (W2-R31); false for training and free sessions.
   * comparison: null for training and free sessions, and when the earlier diagnostics could not be read (О9).
   */
  | {
      kind: 'done';
      sessionId: string;
      diagnostic: DiagnosticResults | null;
      seriesTotal: number | null;
      indexDeferred: boolean;
      comparison: DiagnosticComparison | null;
    };

/** A stored diagnostic as parseResults read it. */
export interface PastDiagnostic {
  number: number;
  at: string;
  metrics: DiagnosticResults;
}

/** What «Сессия завершена» compares a diagnostic with (§3.3). */
export interface DiagnosticComparison {
  /** The diagnostic before this one in listDiagnostics order (by `at`, W2-R33); null: this is the first. */
  previous: PastDiagnostic | null;
  /** readinessOfLatest(earlier, this).overall. */
  readiness: number | null;
  /** readinessOfLatest(earlier without the last, the last).overall; null without a previous diagnostic. */
  readinessPrevious: number | null;
  /** No previous one although this is not the first diagnostic (its number is above 1): the earlier ones are unreadable. */
  earlierUnreadable: boolean;
}

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
  /** The «Оценка» lines (assessBlock); absent: no section. */
  assessment?: BlockAssessment;
}

/** One number-series answer; `given` null = no valid answer (time ran out). */
export interface SeriesAnswer {
  itemId: string;
  given: number | null;
  timeMs: number;
}

/** Opens the instruction of an overload table or memory block (finisher, plateau mix). */
export const OVERLOAD_PREFIX = 'Блок с перегрузкой: уровень на 3 выше обычного. ';
/** Opens the instruction of an overload reaction block: it plays the finisher sound on every trial (M1). */
export const OVERLOAD_SOUND_PREFIX = 'Блок с перегрузкой: уровень на 3 выше обычного, со звуковыми помехами. Надень наушники. ';
export const UNRELIABLE_REPLAY_NOTICE = 'Замер ненадёжен (пропуски кадров). Блок будет повторён.';
/** Summary line of a block that had sound which did not play (no device, a blocked context, volume 0). */
export const AUDIO_NOT_PLAYED = 'Звук не воспроизводился: проверь устройство вывода и громкость помех в настройках.';
export const SERIES_INSTRUCTION_TRAINING =
  'Найди закономерность и введи следующее число. На задачу до 40 секунд, на трудных уровнях меньше: остаток времени показывает полоса.';
/** The span protocol of the diagnostic (digits only; its rows grow every two trials). */
export const MEMORY_SPAN_INSTRUCTION =
  'Запомни цифры по порядку. Потом набери их и нажми Enter. Сначала ряд из 3 цифр, после каждых двух проб он удлиняется ' +
  'на одну цифру. Проверка закончится, когда оба ряда одной длины будут набраны с ошибкой.';
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
export const whole = (x: number): number => Math.round(x) + 0;
/** Rounded to one decimal as `decimal(x, 1)` shows it (seconds of the tables, A-R2). */
export const round1 = (x: number): number => Number(x.toFixed(1));
/** Fixed decimals with a comma: 41,2. */
export const decimal = (x: number, digits: number): string => x.toFixed(digits).replace('.', ',');

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

/** РДО: the signed mean error, «−» early and «+» late. */
function biasLine(meanSignedErrorMs: number): string {
  const e = whole(meanSignedErrorMs);
  if (e > 0) return `Смещение: +${String(e)} мс (запаздываешь)`;
  if (e < 0) return `Смещение: −${String(-e)} мс (торопишься)`;
  return 'Смещение: 0 мс';
}

export function reactionLines(module: ReactionModuleId, s: ReactionSummary): string[] {
  const lines: string[] = [];
  if (s.medianRt !== null) lines.push(`Медиана: ${String(whole(s.medianRt))} мс`);
  if (s.meanRt !== null) lines.push(`Среднее: ${String(whole(s.meanRt))} мс`);
  if (s.sdRt !== null) lines.push(`Разброс (SD): ${String(whole(s.sdRt))} мс`);
  if (s.cvRt !== null) lines.push(`Стабильность (CV): ${decimal(s.cvRt, 2)}`);
  // The error by modulus is the РДО number the history and the diagnostic compare (FW1).
  if (s.meanAbsErrorMs !== null) lines.push(`Средняя ошибка по модулю: ${String(whole(s.meanAbsErrorMs))} мс`);
  if (s.meanSignedErrorMs !== null) lines.push(biasLine(s.meanSignedErrorMs));
  if (module === 'rdo') {
    lines.push(`Точных попаданий: ${String(s.counts.hit)} из ${String(s.n)}`);
    lines.push(`Опережений: ${String(s.counts.early)}, запаздываний: ${String(s.counts.timing_late)}`);
  }
  for (const [label, count] of COUNT_LINES[module]) lines.push(`${label}: ${String(count(s.counts))}`);
  return lines;
}

/** Signed whole milliseconds: «+90», «−30», «0». */
export function signedMs(x: number): string {
  const v = whole(x);
  if (v > 0) return `+${String(v)}`;
  if (v < 0) return `−${String(-v)}`;
  return '0';
}

/** A difference of two medians as the screens show it: the rounded medians' difference, so it agrees with them. */
export function displayedCost(fastMs: number, slowMs: number): number {
  return whole(slowMs) - whole(fastMs);
}

/**
 * A stored diagnostic difference as the screens show it: displayedCost of the stored medians, so Done and the
 * progress charts read what the block summary read; the stored cost only when a median is missing.
 */
export function shownCost(fastMs: number | null, slowMs: number | null, storedCost: number | null): number | null {
  return fastMs !== null && slowMs !== null ? displayedCost(fastMs, slowMs) : storedCost;
}

/** Labels of the fast and slow conditions of a module (COND_PAIRS) and of their difference. */
const COND_LABELS: Partial<Record<ReactionModuleId, { fast: string; slow: string; cost: string }>> = {
  stroop: { fast: 'Цвет совпадает со словом', slow: 'Не совпадает', cost: 'Интерференция' },
  taskswitch: { fast: 'Правило повторяется', slow: 'Правило сменилось', cost: 'Цена переключения' },
  pomeh: { fast: 'Без помех', slow: 'С помехами', cost: 'Разница' },
};
/** An overload block plays the sound on every trial: pomeh's conditions then differ only by the figures (W2-R10, M2). */
const OVERLOAD_COND_LABELS: Partial<Record<ReactionModuleId, { fast: string; slow: string; cost: string }>> = {
  pomeh: { fast: 'Без отвлекающих фигур', slow: 'С отвлекающими фигурами', cost: 'Разница' },
};

/**
 * «Цвет совпадает со словом: 520 мс», «Не совпадает: 610 мс», «Интерференция: +90 мс»; a line only for a known value.
 * The difference is taken between the medians as shown (whole ms), so the three lines always agree.
 */
export function conditionLines(module: ReactionModuleId, stats: ConditionStats, overload = false): string[] {
  const pair = condPairOf(module);
  const labels = (overload ? OVERLOAD_COND_LABELS[module] : undefined) ?? COND_LABELS[module];
  if (pair === null || labels === undefined) return [];
  const fast = stats[pair.fast]?.medianRt ?? null;
  const slow = stats[pair.slow]?.medianRt ?? null;
  const lines: string[] = [];
  if (fast !== null) lines.push(`${labels.fast}: ${String(whole(fast))} мс`);
  if (slow !== null) lines.push(`${labels.slow}: ${String(whole(slow))} мс`);
  if (fast !== null && slow !== null) lines.push(`${labels.cost}: ${signedMs(displayedCost(fast, slow))} мс`);
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

/** «Верно воспроизведено: 4 из 6», «Позиции на своих местах: 85 %» (of all items of the block), «Длина ряда: 6». */
export function memoryLines(exact: number, trials: number, positionsCorrect: number, length: number): string[] {
  const share = trials * length > 0 ? positionsCorrect / (trials * length) : 0;
  return [
    `Верно воспроизведено: ${String(exact)} из ${String(trials)}`,
    `Позиции на своих местах: ${String(whole(100 * share))} %`,
    `Длина ряда: ${String(length)}`,
  ];
}

/** The span protocol: «Верно воспроизведено: 9 из 14» (of the rows shown), «Объём памяти: 7 цифр». */
export function spanLines(exact: number, shown: number, span: number): string[] {
  return [`Верно воспроизведено: ${String(exact)} из ${String(shown)}`, `Объём памяти: ${String(span)} ${plural(span, 'цифра', 'цифры', 'цифр')}`];
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
