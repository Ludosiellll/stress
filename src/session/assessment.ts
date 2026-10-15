import type { BlockRow } from '../data/rows';
import { isCountedSession } from '../engine/derive';
import { R0, type Rating } from '../engine/elo';
import { levelStep, R_FORMAT, ratingStep, stepName, type LevelStep, type RatingStep } from '../engine/levelSteps';
import { cutText, gradeByBands, NORM_HINTS, NORMS, type NormTable } from '../engine/norms';
import { L_NORM, type ModuleState } from '../engine/planner';
import { MODULE_IDS, type FamilyId, type ModuleId, type SessionKind } from '../engine/types';
import { changeText, describeChanges, type ParamChange } from '../modules/describe';
import { FAMILIES } from '../modules/numseries/families';
import { moduleTitles } from '../modules/registry';
import {
  entersHistory,
  gorbovTaskOf,
  historyStats,
  keyMetric,
  KEY_METRICS,
  mainVariant,
  normSamples,
  schulteSize,
  variantOf,
  type BlockHistory,
  type HistoryEntry,
  type HistoryStats,
  type NormSample,
  type VariantKey,
} from './blockHistory';
import { decimal, round1, signedMs, whole } from './steps';

/**
 * The «Оценка» lines of a block summary (assessment spec §3.1, Справочник «Оценка после блока»): the trainer step,
 * the goal (the next step and what changes there), the norm lines or a hint, and the history of the block variant.
 * A diagnostic block gets only the norms and hints. An unreadable stored row never makes it throw; a level of the
 * current block that is negative or not finite does (levelStep), and the controller guards the call (assessOrLog).
 */
export interface BlockAssessment {
  step: string | null;
  goal: string | null;
  /** 0–2 lines: norm lines (ПЗМР gives the mean and the SD) or one hint. */
  norms: string[];
  history: string | null;
}

export interface AssessContext {
  kind: SessionKind;
  /** Before this block; null: it could not be read (no history line, О10). */
  history: BlockHistory | null;
  now: Date;
  /** Number series in training and free sessions: meanFamilyRating after the block; null otherwise. */
  meanRating: number | null;
}

const FIRST_BLOCK = 'Первый такой блок';
/** Only for a block that itself enters the history: the next one is compared with it (FW4). */
const FIRST_BLOCK_KEPT = 'Первый такой блок — будет с чем сравнивать';
const NEW_BEST = ' — новый лучший результат';
const BETTER_THAN_LAST = ' — лучше прошлого раза';
/** Steps 1–4 say «из 5+»; from step 5 there is no ceiling (О14). */
const STEPS_SHOWN_OF = 4;

const HINTS: ReadonlyMap<VariantKey, string> = new Map([
  ['gonogo', NORM_HINTS.gonogo],
  ['stroop', NORM_HINTS.stroop],
  ['taskswitch', NORM_HINTS.taskswitch],
  ['schulte:5', NORM_HINTS.schulte5],
]);

/** The mean of the 8 family ratings; a family without a rating counts as R0. */
export function meanFamilyRating(ratings: ReadonlyMap<FamilyId, Rating>): number {
  return FAMILIES.reduce((sum, f) => sum + (ratings.get(f)?.rating ?? R0), 0) / FAMILIES.length;
}

/** A level as shown: «12», «13,5». */
function levelText(L: number): string {
  const v = round1(L);
  return Number.isInteger(v) ? String(v) : decimal(v, 1);
}

/** A norm value as shown: «262 мс», «44,0 с», «7». */
function normValue(value: number, unit: NormTable['unit']): string {
  if (unit === 'с') return `${decimal(value, 1)} с`;
  const v = String(whole(value));
  return unit === '' ? v : `${v} ${unit}`;
}

/** «Норма (ориентир), среднее: 262 мс — средний; выше среднего — меньше 234 мс. {note}». */
export function normLine(sample: NormSample): string {
  const table = NORMS[sample.id];
  const grade = gradeByBands(sample.value, table);
  const metric = table.metric === null ? '' : `, ${table.metric}`;
  const next = grade.band === 5 ? '' : `; ${grade.nextLabel} — ${cutText(grade.toNext, table)}`;
  return `Норма (ориентир)${metric}: ${normValue(sample.value, table.unit)} — ${grade.label}${next}. ${table.note}`;
}

/** The key metric as shown: «44,0 с», «+85 мс», «262 мс», «67 %». Rounds by itself. */
export function formatMetric(module: ModuleId, value: number): string {
  const metric = KEY_METRICS[module];
  switch (metric.unit) {
    case 'мс':
      return `${metric.signed ? signedMs(value) : String(whole(value))} мс`;
    case 'с':
      return `${decimal(value, 1)} с`;
    case '%':
      return `${String(whole(value))} %`;
  }
}

/** Norm lines of the block; without any, the hint of its variant (if there is one). */
function normTexts(row: BlockRow, variant: VariantKey | null, kind: SessionKind): string[] {
  const samples = normSamples(row, kind);
  if (samples.length > 0) return samples.map(normLine);
  const hint = variant === null ? undefined : HINTS.get(variant);
  return hint === undefined ? [] : [hint];
}

/** «Ступень 3 из 5+ — формат теста», «Ступень 6 — далеко сверх нормы». */
function stepHead(step: number, name: string): string {
  return step <= STEPS_SHOWN_OF ? `Ступень ${String(step)} из 5+ — ${name}` : `Ступень ${String(step)} — ${name}`;
}

/** «До ступени 4 «сверх нормы»». */
function goalHead(step: number): string {
  return `До ступени ${String(step + 1)} «${stepName(step + 1)}»`;
}

const lowerFirst = (s: string): string => s.charAt(0).toLocaleLowerCase('ru') + s.slice(1);

/** What changes from lAfter to the next step; Горбов needs its task, unreadable → nothing (A-R14). */
function paramChanges(row: BlockRow, next: number): ParamChange[] {
  if (row.module !== 'gorbov') return describeChanges(row.module, row.lAfter, next);
  const task = gorbovTaskOf(row);
  return task === null ? [] : describeChanges(row.module, row.lAfter, next, task);
}

/** The step of a level as shown (A-R7), with the shown level, the test format and «+Δ» to the next step. */
function shownLevelStep(module: ModuleId, level: number): { L: string; Lnorm: string; s: LevelStep; toNext: string } {
  const L = round1(level);
  const s = levelStep(L, L_NORM[module]);
  return { L: levelText(L), Lnorm: levelText(L_NORM[module]), s, toNext: levelText(s.nextStepL - L) };
}

/** The step of the mean family rating rounded as shown (A-R7), with «+Δ» rounded up. */
function shownRatingStep(meanRating: number): { R: string; s: RatingStep; toNext: string } {
  const R = whole(meanRating);
  const s = ratingStep(R);
  return { R: String(R), s, toNext: String(Math.ceil(s.nextStepR - R)) };
}

/**
 * Step and goal by level: lAfter, or lBefore (the played level) for an overload or warm-up block, which has no goal
 * (О4, Р29). Both come from the shown level (A-R7); the parameters come from the level the next block plays.
 */
function levelLines(row: BlockRow): Pick<BlockAssessment, 'step' | 'goal'> {
  const overload = row.flags.includes('overload');
  const played = overload || row.flags.includes('warmup');
  const { L, Lnorm, s, toNext } = shownLevelStep(row.module, played ? row.lBefore : row.lAfter);
  const note = overload ? '; перегрузка' : '';
  const step = `${stepHead(s.step, s.name)} (уровень ${L}; формат теста — ${Lnorm}${note})`;
  if (played) return { step, goal: null };
  const changes = paramChanges(row, s.nextStepL);
  const there = changes.length === 0 ? '' : `. Там: ${changes.map((c) => lowerFirst(changeText(c))).join('; ')}`;
  const goal = `${goalHead(s.step)}: уровень ${levelText(s.nextStepL)} (+${toNext})${there}`;
  return { step, goal };
}

/** Number series: step and goal by the mean family rating. */
function ratingLines(meanRating: number | null): Pick<BlockAssessment, 'step' | 'goal'> {
  if (meanRating === null) return { step: null, goal: null };
  const { R, s, toNext } = shownRatingStep(meanRating);
  return {
    step: `${stepHead(s.step, s.name)} (рейтинг ${R}; формат теста — ${String(R_FORMAT)})`,
    goal: `${goalHead(s.step)}: рейтинг ${String(s.nextStepR)} (+${toNext})`,
  };
}

/** « (ур. 11)», « (ряд 7, ур. 9)»; number series have no level. */
function entryDetail(module: ModuleId, entry: HistoryEntry): string {
  if (module === 'numseries') return '';
  const length = entry.length === null ? '' : `ряд ${String(entry.length)}, `;
  return ` (${length}ур. ${levelText(entry.L)})`;
}

/** The key metric of a block that itself enters the history; null: it does not (no number, overload, …). */
function keptValue(row: BlockRow, kind: SessionKind): number | null {
  return entersHistory(row.flags, kind) ? keyMetric(row) : null;
}

/** Only a block that itself enters the history is marked; values compare as shown (О2). */
function mark(row: BlockRow, kind: SessionKind, stats: HistoryStats): string {
  const value = keptValue(row, kind);
  if (value === null) return '';
  const better = (a: number, b: number): boolean => (KEY_METRICS[row.module].better === 'lower' ? a < b : a > b);
  if (better(value, stats.best)) return NEW_BEST;
  return better(value, stats.last.value) ? BETTER_THAN_LAST : '';
}

function historyLine(row: BlockRow, variant: VariantKey | null, ctx: AssessContext): string | null {
  if (ctx.history === null || variant === null) return null;
  const stats = historyStats(ctx.history.get(variant) ?? [], ctx.now, KEY_METRICS[row.module].better);
  if (stats === null) return keptValue(row, ctx.kind) === null ? FIRST_BLOCK : FIRST_BLOCK_KEPT;
  const f = (v: number): string => formatMetric(row.module, v);
  const mean = stats.mean7d === null ? '' : ` · в среднем за 7 дней ${f(stats.mean7d)}`;
  const last = `прошлый раз ${f(stats.last.value)}${entryDetail(row.module, stats.last)}`;
  return `Раньше в этом блоке: ${last} · лучший ${f(stats.best)}${mean}${mark(row, ctx.kind, stats)}`;
}

export function assessBlock(row: BlockRow, ctx: AssessContext): BlockAssessment {
  const variant = variantOf(row);
  const norms = normTexts(row, variant, ctx.kind);
  if (!isCountedSession(ctx.kind)) return { step: null, goal: null, norms, history: null };
  const { step, goal } = row.module === 'numseries' ? ratingLines(ctx.meanRating) : levelLines(row);
  return { step, goal, norms, history: historyLine(row, variant, ctx) };
}

/** A row of «Оценка по модулям» in «Прогресс» (assessment spec §3.2, Справочник «Оценка по модулям»). */
export interface ModuleAssessment {
  module: ModuleId;
  title: string;
  step: string;
  lastBest: string;
  norm: string;
  goal: string;
}

const DASH = '—';
const UNTRAINED = 'ещё не тренировался';
const VARIANT_TITLES: ReadonlyMap<VariantKey, string> = new Map([
  ['gorbov:alternate', 'чередование'],
  ['memory:digits', 'цифры'],
]);
/** «Красно-чёрные таблицы Горбова — чередование», «Таблицы Шульте — 6×6»; Шульте without a finished grid: the bare title. */
function moduleTitle(module: ModuleId, variant: VariantKey | null): string {
  const title = moduleTitles[module];
  if (variant === null) return title;
  const n = schulteSize(variant);
  if (n !== null) return `${title} — ${String(n)}×${String(n)}`;
  const suffix = VARIANT_TITLES.get(variant);
  return suffix === undefined ? title : `${title} — ${suffix}`;
}

/** Step and goal by the saved level (О12), or by the mean rating for number series. */
function stepGoal(module: ModuleId, state: ModuleState, meanRating: number): Pick<ModuleAssessment, 'step' | 'goal'> {
  if (module === 'numseries') {
    const { R, s, toNext } = shownRatingStep(meanRating);
    return {
      step: `${String(s.step)} — ${s.name} (рейтинг ${R}; формат теста — ${String(R_FORMAT)})`,
      goal: `рейтинг ${String(s.nextStepR)} (+${toNext})`,
    };
  }
  const { L, Lnorm, s, toNext } = shownLevelStep(module, state.lSaved);
  return {
    step: `${String(s.step)} — ${s.name} (ур. ${L}; формат теста — ${Lnorm})`,
    goal: `ур. ${levelText(s.nextStepL)} (+${toNext})`,
  };
}

/**
 * The band of the last result. The memory norm grades the row length, not the % beside it, so it names it: «ряд 7:
 * средний» (FW11); the other norms grade the shown key metric itself.
 */
function bandText(sample: NormSample): string {
  const label = gradeByBands(sample.value, NORMS[sample.id]).label;
  return sample.id === 'memorySpan' ? `ряд ${String(sample.value)}: ${label}` : label;
}

/**
 * One row per module in MODULE_IDS order: the step by the saved level (or the mean rating), the last and the best
 * of 30 days of the main variant, the band of the last result and the next step. A module never trained
 * (lifetimeBlocks = 0) reads «ещё не тренировался»; a trained one without a block of its main variant has dashes.
 */
export function assessModules(o: {
  states: Readonly<Record<ModuleId, ModuleState>>;
  meanRating: number;
  history: BlockHistory;
  now: Date;
}): ModuleAssessment[] {
  return MODULE_IDS.map((module) => {
    const variant = mainVariant(module, o.history);
    const title = moduleTitle(module, variant);
    const state = o.states[module];
    if (state.lifetimeBlocks === 0) return { module, title, step: DASH, lastBest: UNTRAINED, norm: DASH, goal: DASH };
    const stats = variant === null ? null : historyStats(o.history.get(variant) ?? [], o.now, KEY_METRICS[module].better);
    const f = (v: number): string => formatMetric(module, v);
    const lastBest = stats === null ? DASH : `${f(stats.last.value)} / ${stats.best30d === null ? DASH : f(stats.best30d)}`;
    const sample = stats?.last.norms[0];
    return { module, title, ...stepGoal(module, state, o.meanRating), lastBest, norm: sample === undefined ? DASH : bandText(sample) };
  });
}
