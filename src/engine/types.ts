/**
 * The module catalogue: every other list of modules (free training, progress charts, caches, dispatch) reads
 * these. New modules are inserted before 'numseries' in MODULE_IDS; reaction modules are also appended to
 * REACTION_MODULE_IDS.
 */
export const REACTION_MODULE_IDS = ['pzmr', 'szmr', 'gonogo', 'rdo', 'stroop', 'taskswitch', 'pomeh'] as const;
export type ReactionModuleId = (typeof REACTION_MODULE_IDS)[number];
export const MODULE_IDS = [
  'pzmr',
  'szmr',
  'gonogo',
  'rdo',
  'gorbov',
  'schulte',
  'stroop',
  'taskswitch',
  'pomeh',
  'memory',
  'numseries',
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

const REACTION_SET: ReadonlySet<ModuleId> = new Set<ModuleId>(REACTION_MODULE_IDS);

/** Modules played by ReactionModule + ReactionBlockRunner ('memory' is not one: it has its own presentation and answers). */
export function isReactionModule(m: ModuleId): m is ReactionModuleId {
  return REACTION_SET.has(m);
}

export type TableModuleId = 'gorbov' | 'schulte';
export type LayoutId = 'keyboard' | 'mouse' | 'pult';
export type InputKey = string;
export type BlockFlag = 'fatigued' | 'timing_unreliable' | 'calibration';
export type SessionKind = 'training' | 'diagnostic' | 'free';
export type FamilyId = 'arith' | 'geom' | 'second' | 'alt' | 'fib' | 'linrec' | 'powers' | 'opcycle';
