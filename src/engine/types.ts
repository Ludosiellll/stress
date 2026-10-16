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

/** The reaction modules whose level is a load band every 4 levels (F3); their ladders live in the modules. */
export const BAND_MODULES = ['pzmr', 'szmr', 'gonogo', 'pomeh', 'stroop', 'taskswitch'] as const satisfies readonly ReactionModuleId[];
export type BandModuleId = (typeof BAND_MODULES)[number];

const BAND_SET: ReadonlySet<ModuleId> = new Set<ModuleId>(BAND_MODULES);

/** One of BAND_MODULES. */
export function isBandModule(m: ModuleId): m is BandModuleId {
  return BAND_SET.has(m);
}

export type TableModuleId = 'gorbov' | 'schulte';
export type LayoutId = 'keyboard' | 'mouse' | 'pult';
export type InputKey = string;
/**
 * discarded (F11): Esc after 30 % of a training or free block counted it as s = 0. It moves the level like any block
 * (deriveModuleStates), and nothing else: fatigue, the previous score of g = 2, the window floor, the history and the
 * personal bests leave it out (T-R10).
 */
export type BlockFlag = 'fatigued' | 'timing_unreliable' | 'calibration' | 'overload' | 'warmup' | 'test_format' | 'discarded';
export type SessionKind = 'training' | 'diagnostic' | 'free';
/** Number-series families: the 8 of 0.1.0 and the 6 of F12 (letters, addsub and primes train; the last 3 are held out). */
export type FamilyId =
  | 'arith'
  | 'geom'
  | 'second'
  | 'alt'
  | 'fib'
  | 'linrec'
  | 'powers'
  | 'opcycle'
  | 'letters'
  | 'addsub'
  | 'primes'
  | 'powstep'
  | 'twostep'
  | 'digitsum';
