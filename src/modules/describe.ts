import type { ModuleId } from '../engine/types';
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
 * Gorbov needs the run task (alternate gets 1.6× time); numseries has no level, so nothing changes.
 */
export function describeChanges(module: ModuleId, lBefore: number, lAfter: number, task?: TableTaskId): ParamChange[] {
  switch (module) {
    case 'pzmr':
    case 'szmr':
    case 'gonogo':
    case 'rdo': {
      const m = reactionModules[module];
      return changed(m.describeParams(m.params(lBefore)), m.describeParams(m.params(lAfter)));
    }
    case 'gorbov': {
      if (task === undefined) throw new RangeError('describeChanges: gorbov needs the run task');
      return changed(describeTableParams(gorbovParams(lBefore, task)), describeTableParams(gorbovParams(lAfter, task)));
    }
    case 'schulte':
      return changed(describeTableParams(schulteParams(lBefore)), describeTableParams(schulteParams(lAfter)));
    case 'numseries':
      return [];
  }
}
