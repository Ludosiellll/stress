import { isBandModule, isReactionModule, type ModuleId, type ReactionModuleId } from '../engine/types';
import { describeMemoryParams, isMemoryMode, memoryParams, type MemoryMode } from './memory/params';
import { withFloor } from './reaction/common';
import { bandModules, reactionModules } from './registry';
import { gorbovParams, type TableParams, type TableTaskId } from './tables/gorbov';
import { schulteParams } from './tables/schulte';
import { describeTableParams } from './tables/score';

/** One parameter that differs between two levels, e.g. «Окно ответа»: «387 мс» → «358 мс». */
export interface ParamChange {
  label: string;
  from: string;
  to: string;
}

/** A number and its unit: «387 мс», «50 %», «1,5 с». */
const VALUE_UNIT = /^(\d+(?:,\d+)?) (\S+)$/;

/**
 * «387 мс» → { amount: '387', unit: 'мс' }; null: not a number with a unit («нет», «5×5», a band label such as
 * «2 цвета на 2 клавиши», whose last word is no unit).
 */
function splitUnit(value: string): { amount: string; unit: string } | null {
  const m = VALUE_UNIT.exec(value);
  // Both groups are mandatory, so a match always has them.
  return m === null ? null : { amount: m[1] as string, unit: m[2] as string };
}

/** «Окно ответа: 387 → 358 мс»: a unit shared by both values is written once. */
export function changeText({ label, from, to }: ParamChange): string {
  const a = splitUnit(from);
  const b = splitUnit(to);
  if (a !== null && b !== null && a.unit === b.unit) return `${label}: ${a.amount} → ${b.amount} ${b.unit}`;
  return `${label}: ${from} → ${to}`;
}

type Described = ReadonlyArray<{ label: string; value: string }>;

/** Entries of `after` whose value differs from the entry with the same label in `before`, in `after` order. */
function changed(before: Described, after: Described): ParamChange[] {
  const old = new Map(before.map((e) => [e.label, e.value]));
  return after.flatMap((e) => {
    const from = old.get(e.label);
    return from !== undefined && from !== e.value ? [{ label: e.label, from, to: e.value }] : [];
  });
}

/** The personal window floor of each load band of the module (F3); null: the band has none. */
export interface DescribeContext {
  floors: (band: number) => number | null;
}

/**
 * What changed in the module's parameters between two levels, for the block summary.
 * Reaction modules (any id of the catalogue) describe their own parameters; with `ctx` a band module's window is the
 * one a block plays (the nominal window or the floor of its band, whichever is larger), so a window resting on one
 * floor at both levels is no change (F3). Gorbov needs the run task (alternate gets 1.6× time) and memory the mode the
 * block played (its row length and showing depend on it, F13); numseries has no level, so nothing changes.
 */
export function describeChanges(
  module: ModuleId,
  lBefore: number,
  lAfter: number,
  task?: TableTaskId | MemoryMode,
  ctx?: DescribeContext,
): ParamChange[] {
  if (isBandModule(module) && ctx !== undefined) {
    const m = bandModules[module];
    const at = (L: number): unknown => {
      const p = m.params(L);
      return withFloor(p, ctx.floors(p.band));
    };
    return describeParamChanges(module, at(lBefore), at(lAfter));
  }
  if (isReactionModule(module)) {
    const m = reactionModules[module];
    return describeParamChanges(module, m.params(lBefore), m.params(lAfter));
  }
  switch (module) {
    case 'gorbov': {
      if (task === undefined || isMemoryMode(task)) throw new RangeError('describeChanges: gorbov needs the run task');
      return describeTableChanges(gorbovParams(lBefore, task), gorbovParams(lAfter, task));
    }
    case 'schulte':
      return describeTableChanges(schulteParams(lBefore), schulteParams(lAfter));
    case 'memory': {
      if (task === undefined || !isMemoryMode(task)) throw new RangeError('describeChanges: memory needs the mode');
      return describeMemoryChanges(task, lBefore, task, lAfter);
    }
    case 'numseries':
      return [];
  }
}

/**
 * What changes from a memory block in `fromMode` at lBefore to the next one in `toMode` at lAfter (F13, T-R78): «Режим»
 * when the modes differ, then the row length and how it is shown.
 */
export function describeMemoryChanges(fromMode: MemoryMode, lBefore: number, toMode: MemoryMode, lAfter: number): ParamChange[] {
  return changed(describeMemoryParams(fromMode, memoryParams(lBefore, fromMode)), describeMemoryParams(toMode, memoryParams(lAfter, toMode)));
}

/** What changed between two parameter sets of a table. */
export function describeTableChanges(before: TableParams, after: TableParams): ParamChange[] {
  return changed(describeTableParams(before), describeTableParams(after));
}

/**
 * What changed between two parameter sets of a reaction module, as its own parameter list names them: a block's
 * modifiers (the swapped Go/No-Go colours, F8) show as the block played them (T-R41).
 */
export function describeParamChanges(module: ReactionModuleId, before: unknown, after: unknown): ParamChange[] {
  const m = reactionModules[module];
  return changed(m.describeParams(before), m.describeParams(after));
}
