import type { DiagnosticResults } from '../engine/diagnostic';
import type { Outcome, ReactionSummary, TrialSpec } from '../engine/reaction/types';
import type { BlockFlag, InputKey, LayoutId, ModuleId, ReactionModuleId, TableModuleId } from '../engine/types';
import type { ParamChange } from '../modules/describe';
import type { SeriesItem } from '../modules/numseries/generate';
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
  | { kind: 'numseries_block'; items: SeriesItem[]; perItemLimitMs: number | null; totalLimitMs: number | null }
  | { kind: 'summary'; view: BlockSummaryView }
  | { kind: 'fatigue_prompt'; module: ModuleId }
  | { kind: 'save_error'; message: string }
  | { kind: 'wellbeing' }
  | { kind: 'done'; sessionId: string; diagnostic: DiagnosticResults | null };

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
}

/** One number-series answer; `given` null = no valid answer (time ran out). */
export interface SeriesAnswer {
  itemId: string;
  given: number | null;
  timeMs: number;
}

export const SERIES_INSTRUCTION_TRAINING = 'Найди закономерность и введи следующее число. На каждую задачу — 40 секунд.';
export const SERIES_INSTRUCTION_DIAGNOSTIC = '20 задач, общее время — 10 минут. Найди закономерность и введи следующее число.';
export const TABLE_KEYS_HINT = 'Мышь';
export const SERIES_KEYS_HINT = 'Цифры и Enter';

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
  if (s.sdRt !== null) lines.push(`Разброс (SD): ${String(whole(s.sdRt))} мс`);
  if (s.meanSignedErrorMs !== null) lines.push(timingErrorLine(s.meanSignedErrorMs));
  for (const [label, count] of COUNT_LINES[module]) lines.push(`${label}: ${String(count(s.counts))}`);
  return lines;
}

export function tableLines(r: TableRunResult): string[] {
  const time = r.timeMs === null ? 'Не закончено за лимит' : `Время: ${decimal(r.timeMs / 1000, 1)} с`;
  return [time, `Ошибки: ${String(r.errors)}`];
}

export function seriesLines(correct: number, total: number, meanTimeMs: number): string[] {
  return [`Верно: ${String(correct)} из ${String(total)}`, `Среднее время: ${String(whole(meanTimeMs / 1000))} с`];
}
