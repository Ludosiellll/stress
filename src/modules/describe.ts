import { isReactionModule, type ModuleId, type ReactionModuleId } from '../engine/types';
import { describeMemoryParams, memoryParams } from './memory/params';
import { reactionModules } from './registry';
import { gorbovParams, type TableTaskId } from './tables/gorbov';
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

/**
 * What changed in the module's parameters between two levels, for the block summary.
 * Reaction modules (any id of the catalogue) describe their own parameters. Gorbov needs the run task
 * (alternate gets 1.6× time); memory parameters do not depend on the mode; numseries has no level, so nothing changes.
 */
export function describeChanges(module: ModuleId, lBefore: number, lAfter: number, task?: TableTaskId): ParamChange[] {
  if (isReactionModule(module)) {
    const m = reactionModules[module];
    return describeParamChanges(module, m.params(lBefore), m.params(lAfter));
  }
  switch (module) {
    case 'gorbov': {
      if (task === undefined) throw new RangeError('describeChanges: gorbov needs the run task');
      return changed(describeTableParams(gorbovParams(lBefore, task)), describeTableParams(gorbovParams(lAfter, task)));
    }
    case 'schulte':
      return changed(describeTableParams(schulteParams(lBefore)), describeTableParams(schulteParams(lAfter)));
    case 'memory':
      return changed(describeMemoryParams(memoryParams(lBefore)), describeMemoryParams(memoryParams(lAfter)));
    case 'numseries':
      return [];
  }
}

/**
 * What changed between two parameter sets of a reaction module, as its own parameter list names them: a block's
 * modifiers (the swapped Go/No-Go colours, F8) show as the block played them (T-R41).
 */
export function describeParamChanges(module: ReactionModuleId, before: unknown, after: unknown): ParamChange[] {
  const m = reactionModules[module];
  return changed(m.describeParams(before), m.describeParams(after));
}
