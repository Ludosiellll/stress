import { LAPSE_HOLD_CAP } from '../engine/adaptive';
import type { AudioStressorParams } from '../engine/audio/stressors';
import { DAY_FORM_DAYS, DAY_FORM_MIN_DAYS, type DayForm } from '../engine/dayForm';
import type { DiagnosticResults } from '../engine/diagnostic';
import { BASE_ITEM_LIMIT_MS } from '../engine/itemLimit';
import { LAYOUT_NAMES } from '../engine/layouts';
import { condPairOf, type ConditionStats } from '../engine/reaction/conditions';
import { LAPSE_MEDIAN_FACTOR, type Stability } from '../engine/reaction/stability';
import { penaltyPoints } from '../engine/reaction/summary';
import type { ReactionSummary, TrialSpec } from '../engine/reaction/types';
import type { BlockFlag, InputKey, LayoutId, ModuleId, ReactionModuleId, TableModuleId } from '../engine/types';
import type { ParamChange } from '../modules/describe';
import type { MemoryTrial } from '../modules/memory/generate';
import { cardExposureText, MEMORY_MODE_NAMES, type MemoryMode, type MemoryParams } from '../modules/memory/params';
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
   * `span` (diagnostics): the span protocol, whose answers end early once spanProtocolStops says so. `audio`: the sound
   * of a 3×3 card with sound (CARD_AUDIO, F13), played only while the card is on screen; null otherwise.
   */
  | {
      kind: 'memory_block';
      L: number;
      mode: MemoryMode;
      params: MemoryParams;
      trials: MemoryTrial[];
      protocol: 'fixed' | 'span';
      audio: AudioStressorParams | null;
    }
  /** A one-time lesson before a new kind of block (F13: the strategy before the first 3×3 card); ackLesson() goes on. */
  | { kind: 'lesson'; lines: readonly string[] }
  | { kind: 'summary'; view: BlockSummaryView }
  /**
   * Diagnostics: the block is played again, and this says why; ackNotice() starts it. A reaction block that was
   * timingUnreliable is replayed once (I1); the first Esc of a task restarts it (F11, Р32).
   */
  | { kind: 'notice'; module: ModuleId; text: string }
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
      /** The user's own layout, the one a diagnostic plays: on the mouse ПЗМР and СЗМР get no norm (T-R23). */
      layout: LayoutId;
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
  /** The module's title; a test-format run's says so: «Прогон в формате теста · СЗМР» (F4). */
  title: string;
  lBefore: number;
  lAfter: number;
  /** Only the parameters whose value changed between lBefore and lAfter. */
  changes: ParamChange[];
  /**
   * «Успешно»: the share of successes ∈ [0, 1]. For reaction blocks it is summary.score without the error penalty
   * (the penalised s is in the error line, Р4); for the other modules it is their block score.
   */
  score: number;
  lines: string[];
  flags: BlockFlag[];
  /**
   * Training and free blocks of modules with a level; diagnostics play at a fixed level and hide it (M5), and so do a
   * warm-up (its levelNote instead) and a test-format run (its flag's note, F4).
   */
  showLevel: boolean;
  /** Said instead of the level line (a warm-up: WARMUP_LEVEL_NOTE); null: none. */
  levelNote: string | null;
  /** The «Оценка» lines (assessBlock); absent: no section. */
  assessment?: BlockAssessment;
}

/** One number-series answer; `given` null = no valid answer (time ran out, or skipped). */
export interface SeriesAnswer {
  itemId: string;
  given: number | null;
  timeMs: number;
  /** Skipped (F11: not reached before a counted Esc): a wrong answer, whatever `given` says. */
  skipped?: boolean;
}

/**
 * What Esc (or a focus loss, a drawing error) did to the block on screen (F11): `restarted` — played again for free;
 * `counted` — stored as s = 0 (`progress` the share done, `levelMoves` whether the level changed, `series` number series,
 * whose answered items count); `refused` — a diagnostic task whose restart is used up: nothing changed.
 */
export type DiscardOutcome =
  | { kind: 'restarted' }
  | { kind: 'counted'; progress: number; lBefore: number; lAfter: number; levelMoves: boolean; series: boolean }
  | { kind: 'refused' };

/** Opens the instruction of an overload table or memory block (finisher, plateau mix). */
export const OVERLOAD_PREFIX = 'Блок с перегрузкой: уровень на 3 выше обычного. ';
/** Opens the instruction of an overload reaction block: it plays the finisher sound on every trial (M1). */
export const OVERLOAD_SOUND_PREFIX = 'Блок с перегрузкой: уровень на 3 выше обычного, со звуковыми помехами. Надень наушники. ';
/**
 * Opens the instruction of an overload block of a band module (Р16): it plays the next band's load at its own level
 * with the finisher sound, so the level-3-above prefix would not be true.
 */
export function overloadBandPrefix(bandLabel: string): string {
  return `Блок с перегрузкой, со звуковыми помехами. Надень наушники. Перегрузка: нагрузка следующей полосы — ${bandLabel}. Уровень не меняется. `;
}

/** The summary line of a block whose window rested on the personal floor (F3): windowMs > nominalWindowMs. */
export function floorLine(windowMs: number, nominalWindowMs: number): string {
  return `Окно ответа: ${String(windowMs)} мс — твой минимум для этой нагрузки (по уровню — ${String(nominalWindowMs)} мс).`;
}

/** The level line of a warm-up block (F5): it plays at L_saved − 1 and moves nothing. */
export const WARMUP_LEVEL_NOTE = 'Разминка: уровень не меняется';

/**
 * «Сегодня раскладка: пульт (стрелки и цифры). Основная — клавиатура.» (F9): on Home and at the start of the session's
 * first instruction, when the layout of the day is not the primary.
 */
export function dayLayoutLine(day: LayoutId, primary: LayoutId): string {
  return `Сегодня раскладка: ${LAYOUT_NAMES[day]}. Основная — ${LAYOUT_NAMES[primary]}.`;
}
export const UNRELIABLE_REPLAY_NOTICE = 'Замер ненадёжен (пропуски кадров). Блок будет повторён.';
/** The notice after the first Esc of a diagnostic task (F11). */
export const DIAGNOSTIC_RESTART_NOTICE = 'Блок перезапущен. В диагностике это можно сделать один раз за задание.';
/** Shown on an Esc in a diagnostic task whose restart is used up (F11). */
export const RESTART_USED_HINT = 'Перезапуск уже использован — доведи задание до конца.';
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

/**
 * The share done in whole percent, rounded up: a block counted as 0 (more than 30 % done) never reads «30 %». The
 * tolerance keeps 0,45 at 45 (100 · 0,45 is a little above 45 in floating point).
 */
const percentDone = (p: number): number => Math.ceil(100 * p - 1e-9);

/**
 * The first line of the pause after Esc in training (F11): «Блок прерван на 45 % — засчитан как 0, уровень 12,5 → 10,5.»;
 * «…уровень не меняется.» when it did not move; for number series that their answered items count; «Блок прерван в
 * начале — не засчитан.» after a free restart.
 */
export function discardText(o: Extract<DiscardOutcome, { kind: 'counted' }> | { kind: 'restarted' }): string {
  if (o.kind === 'restarted') return 'Блок прерван в начале — не засчитан.';
  const head = `Блок прерван на ${String(percentDone(o.progress))} %`;
  if (o.series) return `${head} — отвеченные задачи засчитаны, остальные — как пропущенные.`;
  if (!o.levelMoves) return `${head} — засчитан как 0, уровень не меняется.`;
  return `${head} — засчитан как 0, уровень ${decimal(o.lBefore, 1)} → ${decimal(o.lAfter, 1)}.`;
}

/** The outcomes the error penalty counts (PENALTY, F1). */
export type ErrorKind = 'wrong' | 'false_start' | 'commission';

/** The error kinds that can happen in the module, in the order of the error line. */
export const ERROR_KINDS: Readonly<Record<ReactionModuleId, readonly ErrorKind[]>> = {
  pzmr: ['false_start'],
  szmr: ['wrong', 'false_start'],
  gonogo: ['commission', 'false_start'],
  rdo: ['false_start'],
  stroop: ['wrong', 'false_start'],
  taskswitch: ['wrong', 'false_start'],
  pomeh: ['wrong', 'false_start'],
};

const ERROR_NAMES: Readonly<Record<ErrorKind, string>> = {
  wrong: 'неверная клавиша',
  false_start: 'фальстарты',
  commission: 'нажатия на no-go',
};

/**
 * The first line of a reaction block summary (F1): «Ошибки: неверная клавиша — 2, фальстарты — 1. Штраф −4 из 20,
 * балл 0,65.» — every error kind of the module, the penalty and the penalised score the level moved by; «Ошибок нет.»
 * when they are all 0.
 */
export function errorLine(module: ReactionModuleId, s: ReactionSummary): string {
  const kinds = ERROR_KINDS[module];
  if (kinds.every((k) => s.counts[k] === 0)) return 'Ошибок нет.';
  const list = kinds.map((k) => `${ERROR_NAMES[k]} — ${String(s.counts[k])}`).join(', ');
  return `Ошибки: ${list}. Штраф −${String(penaltyPoints(s.counts))} из ${String(s.n)}, балл ${decimal(s.penalizedScore, 2)}.`;
}

/** A period in seconds as the texts write it: 1500 → «1,5», 2000 → «2» (F14). */
export function periodSeconds(periodMs: number): string {
  return String(periodMs / 1000).replace('.', ',');
}

/** The speed a training or free РДО block plays, at the end of its instruction (T-R61): «Скорость: оборот за 2 с.» */
export function rdoSpeedNote(periodMs: number): string {
  return `Скорость: оборот за ${periodSeconds(periodMs)} с.`;
}

/**
 * РДО (F14, Р24): «Скорость: оборот за 1,5 с · смещение −18 мс (раньше отметки) · точно 12 из 20 · рано 5, поздно 3.»
 * The bias is the signed mean error in whole ms, «0 мс» without a side; a block without any timed answer has none.
 */
export function speedLine(s: ReactionSummary, periodMs: number): string {
  const parts = [`Скорость: оборот за ${periodSeconds(periodMs)} с`];
  if (s.meanSignedErrorMs !== null) {
    const e = whole(s.meanSignedErrorMs);
    parts.push(e === 0 ? 'смещение 0 мс' : `смещение ${signedMs(e)} мс (${e < 0 ? 'раньше' : 'позже'} отметки)`);
  }
  parts.push(`точно ${String(s.counts.hit)} из ${String(s.n)}`, `рано ${String(s.counts.early)}, поздно ${String(s.counts.timing_late)}`);
  return `${parts.join(' · ')}.`;
}

/**
 * Errors first; then the times, the РДО lines, and the misses last (Р5, T-R6). «Стабильность (CV)» is CV_all, what the
 * stability rule sees, when the block's `stability` is given; otherwise the CV of the hits (Р6). РДО keeps «Средняя
 * ошибка по модулю», the number its history and the diagnostic compare (FW1, T-R2), and its speed line takes the place
 * of the bias and count lines (Р24): it needs the period the block played. RangeError for РДО without one.
 */
export function reactionLines(
  module: ReactionModuleId,
  s: ReactionSummary,
  stability: Pick<Stability, 'cvAll'> | null = null,
  periodMs: number | null = null,
): string[] {
  const lines = [errorLine(module, s)];
  if (s.medianRt !== null) lines.push(`Медиана: ${String(whole(s.medianRt))} мс`);
  if (s.meanRt !== null) lines.push(`Среднее: ${String(whole(s.meanRt))} мс`);
  if (s.sdRt !== null) lines.push(`Разброс (SD): ${String(whole(s.sdRt))} мс`);
  const cv = stability === null ? s.cvRt : stability.cvAll;
  if (cv !== null) lines.push(`Стабильность (CV): ${decimal(cv, 2)}`);
  if (s.meanAbsErrorMs !== null) lines.push(`Средняя ошибка по модулю: ${String(whole(s.meanAbsErrorMs))} мс`);
  if (module === 'rdo') {
    if (periodMs === null) throw new RangeError('reactionLines: an РДО block needs the period it played');
    lines.push(speedLine(s, periodMs));
  }
  // A miss is no answer inside the window (spec §5), so late answers count too.
  lines.push(`Пропуски: ${String(s.counts.miss + s.counts.late)}`);
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

const VERDICT_TEXT: Readonly<Record<NonNullable<DayForm['verdict']>, string>> = {
  same: 'как обычно',
  better: 'лучше обычного',
  worse: 'хуже обычного',
};

/**
 * «Форма дня» of a warm-up block (F5): «Форма дня: медиана 236 мс (обычно 241) · разброс 31 мс (обычно 35) — как
 * обычно.», or that there are not enough earlier warm-ups on this band yet. Whole ms.
 */
export function dayFormLine(f: DayForm): string {
  if (f.usual === null || f.verdict === null) {
    return `Форма дня: мало данных — нужно ${String(DAY_FORM_MIN_DAYS)} разминки за ${String(DAY_FORM_DAYS)} дней на этой нагрузке.`;
  }
  const ms = (x: number): string => String(whole(x));
  return (
    `Форма дня: медиана ${ms(f.today.median)} мс (обычно ${ms(f.usual.median)}) · ` +
    `разброс ${ms(f.today.sd)} мс (обычно ${ms(f.usual.sd)}) — ${VERDICT_TEXT[f.verdict]}.`
  );
}

/** What the stability rule saw and the cap it put on the level step (stabilityHold). */
export interface StabilityView {
  cvAll: number | null;
  lapses: number;
  lapseLimit: number;
  cvMax: number;
  cap: number;
}

/** A number with a decimal comma and no trailing zeros: 0,5; 1,5; 22. */
const shortDecimal = (x: number): string => String(x).replace('.', ',');
/** A share in percent with one decimal at most: 0.205 → «20,5», 0.24 → «24». */
const percentText = (x: number): string => shortDecimal(Math.round(1000 * x) / 10);

/**
 * Why the level rose less than the score says (F2, F-R1; shown only when the rule lowered the step, Р8):
 * «Уровень повышен только на 0,5: разброс 24 % при пороге 22 %.», or for lapses, which win,
 * «Уровень не повышен: провалов 3 (пропуск или ответ дольше 1,5 медианы), допускается 1.».
 */
export function stabilityLine(s: StabilityView): string {
  if (s.cap === LAPSE_HOLD_CAP) {
    const factor = shortDecimal(LAPSE_MEDIAN_FACTOR);
    return `Уровень не повышен: провалов ${String(s.lapses)} (пропуск или ответ дольше ${factor} медианы), допускается ${String(s.lapseLimit - 1)}.`;
  }
  if (s.cvAll === null) throw new RangeError('stabilityLine: a CV cap without CV_all');
  return `Уровень повышен только на ${shortDecimal(s.cap)}: разброс ${percentText(s.cvAll)} % при пороге ${percentText(s.cvMax)} %.`;
}

export function tableLines(r: TableRunResult): string[] {
  const time = r.timeMs === null ? 'Не закончено за лимит' : `Время: ${decimal(r.timeMs / 1000, 1)} с`;
  return [time, `Ошибки: ${String(r.errors)}`];
}

/**
 * The line of a fixed memory block (F13): «Верных позиций: 78 % · точных рядов: 3 из 10 · длина 9 (карточка 3×3, 7 с)»;
 * the partial score s first, in whole percent, the exact rows second; the card names its showing, «, со звуком» too.
 */
export function memoryLine(o: {
  partial: number;
  exact: number;
  trials: number;
  length: number;
  mode: MemoryMode;
  exposureMs: number | null;
  sound: boolean;
}): string {
  const name = MEMORY_MODE_NAMES[o.mode];
  const how = o.exposureMs === null ? name : `${name}, ${cardExposureText(o.exposureMs, o.sound)}`;
  return (
    `Верных позиций: ${String(whole(100 * o.partial))} % · точных рядов: ${String(o.exact)} из ${String(o.trials)}` +
    ` · длина ${String(o.length)} (${how})`
  );
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
