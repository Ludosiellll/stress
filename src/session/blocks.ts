import type { BlockLevelRow } from '../data/rows';
import { isCountedSession, storedBand } from '../engine/derive';
import { EMPTY_METRICS, diagnosticSegmentSeed, diagnosticSeriesSchedule, type DiagnosticResults } from '../engine/diagnostic';
import { R0, updateRating, type Rating } from '../engine/elo';
import { itemEffectiveDifficulty } from '../engine/itemLimit';
import { keyLabel, layoutKeys } from '../engine/layouts';
import { FINISHER_AUDIO, mergeAudio } from '../engine/audio/stressors';
import { OVERLOAD_LEVEL_STEP, type FeedbackRate, type Segment } from '../engine/planner';
import { COND_PAIRS, MIN_COND_RTS, condCost, conditionStats, type CondPair, type ConditionStats } from '../engine/reaction/conditions';
import { resolveBlock } from '../engine/reaction/resolve';
import { isCleanHitRt, summarize } from '../engine/reaction/summary';
import type { BlockTimeline, ReactionSummary, TrialResult, TrialSpec } from '../engine/reaction/types';
import { createRng, deriveSeed } from '../engine/rng';
import { quantile, sdTrimmed } from '../engine/stats';
import {
  isBandModule,
  isReactionModule,
  type BandModuleId,
  type FamilyId,
  type InputKey,
  type LayoutId,
  type ModuleId,
  type ReactionModuleId,
  type SessionKind,
  type TableModuleId,
} from '../engine/types';
import { bandFloors } from '../engine/windowFloor';
import { generateMemoryTrials, SPAN_PROTOCOL_PARAMS, SPAN_PROTOCOL_TRIALS, spanProtocolTrials } from '../modules/memory/generate';
import { spanProtocolStops, type MemoryAnswer } from '../modules/memory/score';
import {
  CARD_AUDIO,
  MEMORY_TRIALS,
  memoryInstruction,
  memoryKeysHint,
  memoryModeForBlock,
  memoryParams,
  type MemoryMode,
  type MemoryParams,
} from '../modules/memory/params';
import { describeChanges, describeParamChanges, describeTableChanges, type ParamChange } from '../modules/describe';
import { diagnosticSeriesItems, generateBlockItems, type TimedSeriesItem } from '../modules/numseries/generate';
import { bandIndex, stressorsOf, withFloor, type BandFields, type BlockStressors, type ReactionModule } from '../modules/reaction/common';
import { DIAGNOSTIC_PARAMS } from '../modules/reaction/diagnosticParams';
import { gonogo, isSwappedSegment, swapColours } from '../modules/reaction/gonogo';
import { rdo, rdoCyclePeriod, rdoPeriod, type RdoParams } from '../modules/reaction/rdo';
import { bandModules, reactionModules } from '../modules/registry';
import {
  generateGorbovTable,
  gorbovMetrics,
  gorbovParams,
  gorbovTaskForRun,
  SAME_TABLE_NOTE,
  tableInstruction,
  type TableParams,
  type TableTaskId,
} from '../modules/tables/gorbov';
import { generateSchulteTable, schulteParams } from '../modules/tables/schulte';
import {
  MEMORY_SPAN_INSTRUCTION,
  OVERLOAD_PREFIX,
  OVERLOAD_SOUND_PREFIX,
  overloadBandPrefix,
  rdoSpeedNote,
  SERIES_INSTRUCTION_TRAINING,
  SERIES_KEYS_HINT,
  seriesDiagnosticInstruction,
  TABLE_KEYS_HINT,
  type SeriesAnswer,
  type StepOf,
} from './steps';
import { parseObject } from './blockHistory';
import { cleanHitsByBand, type PastBlocks } from './pastBlocks';
import { testFormatInstruction } from './testFormat';

/** Pure parts of a session block: what to play, its seed, its step, and scoring. No state, no I/O. */

const SERIES_BLOCK_ITEMS = 10;
/** Floor for block sizes and item counts under the e2e scale. */
const MIN_SCALED = 3;
/** Floor for blocks of modules with trial conditions (COND_PAIRS) under the e2e scale. */
const MIN_SCALED_COND = 12;
/**
 * Under the e2e scale every condition keeps this many trials beyond MIN_COND_RTS (W2-R30): a dropped onset frame
 * or two on a CI runner still leaves its median.
 */
export const E2E_COND_MARGIN = 2;
/** A floor search that gets this far means the module's conditions never reach the margin. */
const MAX_COND_FLOOR = 1000;

/** Block size or item count under the e2e scale: max(min, round(n·scale)), min 3 by default. */
export function scaledCount(n: number, scale: number, min: number = MIN_SCALED): number {
  return Math.max(min, Math.round(n * scale));
}

/**
 * The fewest trials (at least MIN_SCALED_COND) that give each condition of a block at `params`
 * MIN_COND_RTS + E2E_COND_MARGIN trials, whatever the seed.
 */
export function e2eCondFloor<P>(mod: Pick<ReactionModule<P>, 'id' | 'minCondTrials'>, params: P): number {
  const need = MIN_COND_RTS + E2E_COND_MARGIN;
  for (let n = MIN_SCALED_COND; n <= MAX_COND_FLOOR; n++) {
    if ((mod.minCondTrials?.(params, n) ?? 0) >= need) return n;
  }
  throw new RangeError(`${mod.id}: no block up to ${String(MAX_COND_FLOOR)} trials gives each condition ${String(need)}`);
}

/**
 * A reaction block's size: scaledCount, and under the e2e scale (scale < 1) a module with trial conditions keeps
 * e2eCondFloor trials. At scale ≥ 1 the planned count stands (it is above every floor).
 */
function reactionBlockSize<P>(mod: ReactionModule<P>, params: P, n: number, scale: number): number {
  if (mod.minCondTrials === undefined) return scaledCount(n, scale);
  return scaledCount(n, scale, scale < 1 ? e2eCondFloor(mod, params) : MIN_SCALED_COND);
}

/** Practice trials stay as planned unless the e2e scale shrinks them: max(1, round(n·scale)). */
export function scaledPractice(n: number, scale: number): number {
  return n > 0 && scale < 1 ? Math.max(1, Math.round(n * scale)) : n;
}

/** The personal window floor of a module's load band (F3); null: the band has none (band 0 without history, РДО). */
export type WindowFloors = (module: ReactionModuleId, band: number) => number | null;

/**
 * The floors of the history read at start and of the blocks of the session stored since (F3): bandFloors over
 * cleanHitsByBand with the module's ladder; null for a module without bands. Each module's history is read when it
 * is first asked for, so a WindowFloors is made for the block about to be planned.
 */
export function floorsFrom(past: PastBlocks): WindowFloors {
  const byModule = new Map<BandModuleId, (band: number) => number | null>();
  return (module, band) => {
    if (!isBandModule(module)) return null;
    let floorOf = byModule.get(module);
    if (floorOf === undefined) {
      floorOf = bandFloors(cleanHitsByBand(past, module), bandModules[module].bands ?? []);
      byModule.set(module, floorOf);
    }
    return floorOf(band);
  };
}

/** paramsJson.windowMs, the window a stored block played: a positive finite number; null otherwise. */
function storedWindowMs(paramsJson: string): number | null {
  const w = parseObject(paramsJson)?.['windowMs'];
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : null;
}

/**
 * The window floors of a training or free session whose block history could not be read (Р18, T-R78), from the light
 * rows of listBlockLevels: on a band, the window (paramsJson.windowMs) of the module's latest block on it in a training
 * or free session, a test-format run left out (it plays the frozen parameters, F4); without one, that of the nearest
 * band below that has one, the direction of the floor chain; without any below, of the nearest band above, so that a
 * band module never plays the nominal window of a high level. Each stored window was already at least its band's floor
 * then. `rows` in listBlockLevels order (by startedAt); null: the module has no such window, or no bands.
 */
export function levelFloors(
  sessions: readonly { id: string; kind: SessionKind }[],
  rows: readonly Pick<BlockLevelRow, 'sessionId' | 'module' | 'flags' | 'paramsJson'>[],
): WindowFloors {
  const counted = new Set(sessions.flatMap((s) => (isCountedSession(s.kind) ? [s.id] : [])));
  const windows = new Map<ModuleId, Map<number, number>>();
  for (const row of rows) {
    if (!isBandModule(row.module) || !counted.has(row.sessionId) || row.flags.includes('test_format')) continue;
    const band = storedBand(row.paramsJson);
    const windowMs = storedWindowMs(row.paramsJson);
    if (band === null || windowMs === null) continue;
    const byBand = windows.get(row.module) ?? new Map<number, number>();
    // Later rows replace earlier ones: the latest block of the band.
    byBand.set(band, windowMs);
    windows.set(row.module, byBand);
  }
  return (module, band) => {
    const byBand = windows.get(module);
    if (byBand === undefined) return null;
    const bands = [...byBand.keys()];
    const below = bands.filter((b) => b <= band);
    return byBand.get(below.length > 0 ? Math.max(...below) : Math.min(...bands)) ?? null;
  };
}

/**
 * The load of a band module's training or free block (F3): the band b of L, the band whose load it plays (an overload
 * block: the next one, at the window of b), the nominal window of L and the floor of b (round(floor); null: none).
 */
export interface BlockLoad {
  band: number;
  bandLabel: string;
  /** An overload block: the band whose load it plays (b + 1, the last band at the ladder's end); null otherwise. */
  loadBand: number | null;
  /** The label of loadBand (T-R25); null when loadBand is. */
  loadBandLabel: string | null;
  nominalWindowMs: number;
  floorMs: number | null;
}

/**
 * The next block of a segment, decided before its instruction: level, parameters, task, keys and volume.
 * `overload`: an overload block (isOverloadBlock); number series never are.
 */
export type BlockPlan =
  | {
      kind: 'reaction';
      module: ReactionModuleId;
      L: number;
      /** With the window the block plays (F3: the floor of its band when that is larger). */
      params: unknown;
      keys: InputKey[];
      /** Effective layout ('keyboard' when the mouse cannot serve the keys). */
      layout: LayoutId;
      size: number;
      practice: number;
      overload: boolean;
      /** A band module's training or free block; null for РДО, diagnostics and test-format runs (F3). */
      load: BlockLoad | null;
      /** A test-format run (F4): the frozen diagnostic parameters, its own instruction. */
      testFormat: boolean;
      /**
       * A diagnostic block or a test-format run: DIAGNOSTIC_PARAMS as they are, with none of the training rules (spec
       * §2.0); its instruction is that of 0.2.0 (an РДО one names no speed, T-R61).
       */
      frozen: boolean;
      /**
       * The mark rate of its trials (F15): the plan's in a training or free block of FEEDBACK_MODULES; 'none' in a
       * warm-up, a test-format run, a diagnostic and РДО.
       */
      feedback: FeedbackRate;
      /** The jitter of its trials (F9): the module's in a training or free block; 'none' otherwise. */
      jitter: JitterKind;
    }
  /**
   * `table` (F10): blocks 0–2 of a Горбов segment are a series on one table, dealt from the seed of block 0's counted
   * attempt (buildBlock's tableSeed); later Горбов blocks and every Шульте block deal a table of their own.
   */
  | { kind: 'table'; module: TableModuleId; L: number; task: TableTaskId; params: TableParams; overload: boolean; table: 'series' | 'own' }
  /**
   * Memory blocks cycle their mode by block index (by pairs of blocks in a plateau mix), at the one level of the module
   * (F13); `count` trials. A diagnostic plays the span protocol instead: digits, its first `count` trials, ending early
   * when it stops.
   */
  | { kind: 'memory'; protocol: 'fixed' | 'span'; L: number; mode: MemoryMode; params: MemoryParams; count: number; overload: boolean }
  /** Training items carry their own limits (R36); `totalLimitMs` is the diagnostic's block limit. */
  | { kind: 'numseries'; diagnostic: boolean; count: number; totalLimitMs: number | null };

export type BlockStep = StepOf<'reaction_block'> | StepOf<'table_block'> | StepOf<'numseries_block'> | StepOf<'memory_block'>;

export interface PlanContext {
  /** The user's layout. */
  layout: LayoutId;
  scale: number;
  /** A diagnostic block: reaction modules play DIAGNOSTIC_PARAMS, memory the span protocol, number series the schedule. */
  diagnostic: boolean;
  /** The plan's seed and the segment's index in it: what a segment draws once (the Go/No-Go colour swap, F8). */
  planSeed: number;
  segmentIndex: number;
  /**
   * The personal window floors (F3), or levelFloors when the history could not be read (Р18, T-R78); null: a diagnostic
   * or a test-format run.
   */
  floors: WindowFloors | null;
  /** The plan's mark rate (F15); planBlock keeps it to the blocks that have marks. */
  feedback: FeedbackRate;
  /**
   * The counted РДО blocks stored before this block (rdoCycleCount, T-R61): a training or free РДО block plays the
   * next speed of the cycle. null: the history could not be read (Р18), or a diagnostic; then the segment's own order
   * (rdoPeriod).
   */
  rdoCount: number | null;
}

/** The modules whose training and free blocks mark a trial after it (F15); not РДО: its dial shows the error. */
export const FEEDBACK_MODULES: readonly ReactionModuleId[] = ['pzmr', 'szmr', 'gonogo', 'stroop', 'taskswitch', 'pomeh'];

/** Blocks 0–2 of a Горбов segment: the three tasks of the test on one table (F10). */
export const GORBOV_SERIES_BLOCKS = 3;

/**
 * How a block's stimulus is jittered (F9): `position` moves it and changes its size, `size` changes the size only;
 * `none` leaves it centred and as is.
 */
export type JitterKind = 'position' | 'size' | 'none';

/**
 * The jitter of each module's training and free blocks (Справочник F9): Помехоустойчивость only the size, its figures
 * stand around the centre; РДО none. Warm-ups, test-format runs and diagnostics have none.
 */
const JITTER: Readonly<Record<ReactionModuleId, JitterKind>> = {
  pzmr: 'position',
  szmr: 'position',
  gonogo: 'position',
  stroop: 'position',
  taskswitch: 'position',
  pomeh: 'size',
  rdo: 'none',
};

/** The most a stimulus moves from the centre on either axis, and the most its size changes, in shares (F9). */
const JITTER_SHIFT = 0.15;
const JITTER_SCALE = 0.1;

/** The seed of a segment's key mapping (F9): deriveSeed(planSeed, 'map:' + segmentIndex). */
function segmentMappingSeed(ctx: Pick<PlanContext, 'planSeed' | 'segmentIndex'>): number {
  return deriveSeed(ctx.planSeed, 'map:' + String(ctx.segmentIndex));
}

/** Every block of a finisher; the odd blocks (1, 3, …) of a plateau mix. */
export function isOverloadBlock(segment: Segment, blockIndex: number): boolean {
  return segment.overload === 'finisher' || (segment.overload === 'mix' && blockIndex % 2 === 1);
}

/**
 * Block `blockIndex` of the segment whose level is `segmentL` (Gorbov runs cycle their tasks, memory blocks
 * their mode, by index). An overload block of a band module plays the segment level with the next band's load (F3);
 * one of РДО, the tables or memory in a mix plays OVERLOAD_LEVEL_STEP above the segment level, and a finisher's
 * segment level already includes the step.
 */
export function planBlock(segment: Segment, segmentL: number, blockIndex: number, ctx: PlanContext): BlockPlan {
  const { module } = segment;
  const overload = isOverloadBlock(segment, blockIndex);
  const L = overload && segment.overload === 'mix' && !isBandModule(module) ? segmentL + OVERLOAD_LEVEL_STEP : segmentL;
  if (isReactionModule(module)) {
    const mod = reactionModules[module];
    const testFormat = segment.purpose === 'test_format';
    const frozen = ctx.diagnostic || testFormat;
    // A training or free block, not a warm-up: the key mapping and the jitter (F9), the marks (F15).
    const trained = !frozen && segment.purpose !== 'warmup';
    const block = reactionBlock(module, L, blockIndex, overload, frozen, ctx);
    const { load } = block;
    // One mapping for the whole segment (F9): its overload blocks and a new band inside it draw from the same seed.
    const params = trained ? (mod.withMapping?.(block.params, segmentMappingSeed(ctx)) ?? block.params) : block.params;
    const marked = trained && FEEDBACK_MODULES.includes(module);
    const { keys, effectiveLayout } = layoutKeys(ctx.layout, mod.keyCount(params));
    return {
      kind: 'reaction',
      module,
      L,
      params,
      keys,
      layout: effectiveLayout,
      size: reactionBlockSize(mod, params, segment.trialCount ?? mod.trials(params), ctx.scale),
      practice: scaledPractice(segment.practiceTrials ?? 0, ctx.scale),
      overload,
      load,
      testFormat,
      frozen,
      feedback: marked ? ctx.feedback : 'none',
      jitter: trained ? JITTER[module] : 'none',
    };
  }
  if (module === 'gorbov') return gorbovPlan(L, blockIndex, overload);
  if (module === 'schulte') return { kind: 'table', module, L, task: 'schulte', params: schulteParams(L), overload, table: 'own' };
  if (module === 'memory') {
    if (ctx.diagnostic) {
      const count = scaledCount(SPAN_PROTOCOL_TRIALS, ctx.scale);
      return { kind: 'memory', protocol: 'span', L, mode: 'digits', params: { ...SPAN_PROTOCOL_PARAMS }, count, overload };
    }
    const count = scaledCount(MEMORY_TRIALS, ctx.scale);
    // A mix alternates normal and overload blocks, so its modes advance every two blocks: each mode gets both (W2-R27).
    const mode = memoryModeForBlock(segment.overload === 'mix' ? Math.floor(blockIndex / 2) : blockIndex);
    return { kind: 'memory', protocol: 'fixed', L, mode, params: memoryParams(L, mode), count, overload };
  }
  if (ctx.diagnostic) {
    const scheduled = diagnosticSeriesSchedule().length;
    const total = segment.totalTimeLimitMs;
    return {
      kind: 'numseries',
      diagnostic: true,
      count: Math.min(scheduled, scaledCount(segment.items ?? scheduled, ctx.scale)),
      totalLimitMs: total === undefined ? null : Math.round(total * ctx.scale),
    };
  }
  return { kind: 'numseries', diagnostic: false, count: scaledCount(SERIES_BLOCK_ITEMS, ctx.scale), totalLimitMs: null };
}

/**
 * The parameters and the load of a reaction block at L. A diagnostic and a test-format run (`frozen`) play the frozen
 * 0.2.0 parameters, whatever params(L) becomes (training-fixes spec §2.0, F4): no floor, no Go/No-Go colour swap
 * (T-R42), no РДО speed rotation and none of the training rules that come with the bands. An РДО block plays the
 * tolerance of its L (an overload block's L is already 3 higher) at the next speed of the cycle (rdoBlockPeriod).
 */
function reactionBlock(
  module: ReactionModuleId,
  L: number,
  blockIndex: number,
  overload: boolean,
  frozen: boolean,
  ctx: PlanContext,
): { params: unknown; load: BlockLoad | null } {
  if (frozen) return { params: DIAGNOSTIC_PARAMS[module], load: null };
  if (module === 'rdo') return { params: { ...rdo.params(L), periodMs: rdoBlockPeriod(blockIndex, ctx) }, load: null };
  return bandBlock(module, L, overload, ctx);
}

/**
 * The speed of a training or free РДО block: the next of the cycle, counted over the history and this session
 * (rdoCyclePeriod, T-R61); without the history (Р18), the order of its segment (rdoPeriod, F14).
 */
function rdoBlockPeriod(blockIndex: number, ctx: PlanContext): number {
  return ctx.rdoCount === null ? rdoPeriod(ctx.planSeed, ctx.segmentIndex, blockIndex) : rdoCyclePeriod(ctx.rdoCount);
}

/**
 * A band module's block at L (F3): the load of its band b, or for an overload block of the next band, at the window of
 * b — the nominal window of L or round(floor(b)), whichever is larger.
 */
function bandBlock(module: BandModuleId, L: number, overload: boolean, ctx: PlanContext): { params: BandFields; load: BlockLoad } {
  const band = bandIndex(bandModules[module], L);
  const own = bandParams(module, L, band, ctx);
  const played = overload ? bandParams(module, L, band + 1, ctx) : own;
  const floor = ctx.floors?.(module, band) ?? null;
  return {
    params: withFloor(played, floor),
    load: {
      band,
      bandLabel: own.bandLabel,
      loadBand: overload ? played.band : null,
      loadBandLabel: overload ? played.bandLabel : null,
      nominalWindowMs: own.windowMs,
      floorMs: floor === null ? null : Math.round(floor),
    },
  };
}

/**
 * «What changed» between two levels for the block summary, named as the block's segment plays them: a reaction module
 * describes its training parameters at both levels, so a swapped Go/No-Go segment names its swapped colours (T-R41),
 * and a band module's window is the one its blocks play (the floor of the band when that is larger, F3): at lBefore
 * the window the block played (ctx.floors), at lAfter the one the next block plays, on `floorsAfter`, the floors with
 * the block just played (T-R50). `played` is the block's plan: a table's task, a memory block's mode (F13), and a normal
 * block of a Горбов series never reshuffles (F10, T-R62); after the last one the next block is an own table (T-R65).
 */
export function levelChanges(
  module: ModuleId,
  lBefore: number,
  lAfter: number,
  played: BlockPlan,
  ctx: PlanContext,
  floorsAfter: WindowFloors | null,
): ParamChange[] {
  if (played.kind === 'table' && played.module === 'gorbov' && played.table === 'series' && !played.overload) {
    const series = (L: number): TableParams => ({ ...gorbovParams(L, played.task), reshuffleEvery: null });
    // After the last block of the series the next one deals its own table, which may reshuffle (T-R65).
    const last = played.task === gorbovTaskForRun(GORBOV_SERIES_BLOCKS - 1);
    return describeTableChanges(series(lBefore), last ? gorbovParams(lAfter, played.task) : series(lAfter));
  }
  if (!isBandModule(module)) {
    const task = played.kind === 'table' ? played.task : played.kind === 'memory' ? played.mode : undefined;
    return describeChanges(module, lBefore, lAfter, task);
  }
  const at = (L: number, floors: WindowFloors | null): BandFields => bandBlock(module, L, false, { ...ctx, floors }).params;
  return describeParamChanges(module, at(lBefore, ctx.floors), at(lAfter, floorsAfter));
}

/** A band module's training and free parameters at L with the load of `loadBand`; a Go/No-Go segment may swap its colours (F8). */
function bandParams(module: BandModuleId, L: number, loadBand: number, ctx: PlanContext): BandFields {
  if (module === 'gonogo') {
    const p = gonogo.params(L, loadBand);
    return isSwappedSegment(ctx.planSeed, ctx.segmentIndex) ? swapColours(p) : p;
  }
  return bandModules[module].params(L, loadBand);
}

/**
 * A Горбов block (F10): blocks 0–2 are the series of the test on one table, a normal one never reshuffles, an overload
 * one plays gorbovParams(L) at its raised level and reshuffles from 15; later blocks have a table of their own and
 * gorbovParams(L). The time limits are gorbovParams(L)'s.
 */
function gorbovPlan(L: number, blockIndex: number, overload: boolean): BlockPlan {
  const task = gorbovTaskForRun(blockIndex);
  const params = gorbovParams(L, task);
  if (blockIndex >= GORBOV_SERIES_BLOCKS) return { kind: 'table', module: 'gorbov', L, task, params, overload, table: 'own' };
  return { kind: 'table', module: 'gorbov', L, task, params: overload ? params : { ...params, reshuffleEvery: null }, overload, table: 'series' };
}

/**
 * The instruction before a block. A band module's block ends with its load line (F3). An overload block's text starts
 * with OVERLOAD_PREFIX, or in a reaction block, which plays the finisher sound (overloadStressors), with
 * OVERLOAD_SOUND_PREFIX; a band module's with overloadBandPrefix, naming the next band's load (Р16). A test-format run
 * opens with testFormatInstruction for its size (F4).
 */
export function blockInstruction(plan: BlockPlan, layout: LayoutId): { text: string; keysHint: string } {
  const { text, keysHint } = plainInstruction(plan, layout);
  if (plan.kind === 'reaction' && plan.testFormat) return { text: testFormatInstruction(plan.size) + text, keysHint };
  if (plan.kind === 'reaction' && plan.load !== null) {
    const { loadBandLabel, bandLabel } = plan.load;
    const played = loadBandLabel ?? bandLabel;
    const prefix = plan.overload ? overloadBandPrefix(played) : '';
    return { text: `${prefix}${text} Нагрузка: ${played}.`, keysHint };
  }
  if (plan.kind === 'numseries' || !plan.overload) return { text, keysHint };
  return { text: (plan.kind === 'reaction' ? OVERLOAD_SOUND_PREFIX : OVERLOAD_PREFIX) + text, keysHint };
}

function plainInstruction(plan: BlockPlan, layout: LayoutId): { text: string; keysHint: string } {
  switch (plan.kind) {
    case 'reaction': {
      const text = reactionModules[plan.module].instruction(layout, plan.params, plan.overload);
      // A training or free РДО block names the speed it plays (T-R61).
      const speed = plan.module === 'rdo' && !plan.frozen ? ` ${rdoSpeedNote((plan.params as RdoParams).periodMs)}` : '';
      return { text: text + speed, keysHint: plan.keys.map(keyLabel).join(', ') };
    }
    case 'table': {
      // Tasks 2–3 of a series (every series task but the first) play the table of task 1 (F10).
      const same = plan.table === 'series' && plan.task !== gorbovTaskForRun(0);
      return { text: tableInstruction(plan.task, plan.params.size) + (same ? SAME_TABLE_NOTE : ''), keysHint: TABLE_KEYS_HINT };
    }
    case 'memory':
      return {
        text: plan.protocol === 'span' ? MEMORY_SPAN_INSTRUCTION : memoryInstruction(plan.mode, plan.params),
        keysHint: memoryKeysHint(plan.mode),
      };
    case 'numseries':
      return {
        text: plan.diagnostic ? seriesDiagnosticInstruction(plan.count, plan.totalLimitMs) : SERIES_INSTRUCTION_TRAINING,
        keysHint: SERIES_KEYS_HINT,
      };
  }
}

/** Training and free blocks: deriveSeed(plan.seed, `segment:block:attempt`). */
export function trainingBlockSeed(planSeed: number, segmentIndex: number, blockIndex: number, attempt: number): number {
  return deriveSeed(planSeed, `${String(segmentIndex)}:${String(blockIndex)}:${String(attempt)}`);
}

/**
 * Diagnostic n: the first block of a segment uses diagnosticSegmentSeed(n, module) itself, later blocks
 * (Gorbov runs 2, 3) deriveSeed(segSeed, 'run:i'); a discarded block gets deriveSeed(base, 'retry:k').
 */
export function diagnosticBlockSeed(n: number, module: ModuleId, blockIndex: number, attempt: number): number {
  const segSeed = diagnosticSegmentSeed(n, module);
  const base = blockIndex === 0 ? segSeed : deriveSeed(segSeed, 'run:' + String(blockIndex));
  return attempt === 0 ? base : deriveSeed(base, 'retry:' + String(attempt));
}

/** What a block takes from outside its own seed. */
export interface SharedSeeds {
  /** A Горбов series block: the seed of block 0's counted attempt (F10). */
  tableSeed?: number;
  /** A diagnostic number-series block: the form (0–5) it plays (F12; the controller picks it, nextSeriesForm, T-R73). */
  seriesForm?: number;
}

/**
 * The block step for `plan` from `seed` (and the ratings, for training number series), plus its params JSON. A Горбов
 * series block deals its cells from `tableSeed` (the seed of block 0's counted attempt; its own seed without one) and
 * stores `table` and `tableSeed` (F10); reshuffles still follow the block's own seed. A diagnostic number-series block
 * plays the items of form `seriesForm` (F12), whatever its own seed.
 */
export function buildBlock(
  plan: BlockPlan,
  seed: number,
  layout: LayoutId,
  ratings: ReadonlyMap<FamilyId, Rating>,
  { tableSeed, seriesForm }: SharedSeeds = {},
): { step: BlockStep; paramsJson: string } {
  switch (plan.kind) {
    case 'reaction': {
      const mod = reactionModules[plan.module];
      const practice =
        plan.practice > 0
          ? mod
              .generateBlock(plan.params, createRng(deriveSeed(seed, 'practice')), layout, plan.practice)
              .map((t) => ({ ...t, practice: true }))
          : [];
      const trials = [...practice, ...mod.generateBlock(plan.params, createRng(seed), layout, plan.size)];
      const specs = withJitter(withFeedback(trials, plan.feedback, seed), plan.jitter, seed);
      const stressors = stressorsOf(mod, plan.params);
      return {
        step: {
          kind: 'reaction_block',
          module: plan.module,
          L: plan.L,
          specs,
          keys: plan.keys,
          layout: plan.layout,
          legend: mod.legend?.(layout, plan.params) ?? null,
          layers: { ...(plan.overload ? overloadStressors(stressors) : stressors), seed: deriveSeed(seed, 'layers') },
        },
        paramsJson: JSON.stringify(reactionParamsJson(plan)),
      };
    }
    case 'table': {
      const step = { kind: 'table_block', module: plan.module, L: plan.L, task: plan.task, params: plan.params, seed } as const;
      if (plan.module === 'schulte') {
        const cells = generateSchulteTable(plan.params.size, createRng(seed));
        return { step: { ...step, cells }, paramsJson: JSON.stringify({ task: plan.task, ...plan.params }) };
      }
      const dealt = plan.table === 'series' ? (tableSeed ?? seed) : seed;
      return {
        step: { ...step, cells: generateGorbovTable(createRng(dealt)) },
        paramsJson: JSON.stringify({ task: plan.task, ...plan.params, table: plan.table, tableSeed: dealt }),
      };
    }
    case 'memory': {
      const { L, mode, params, count, protocol } = plan;
      if (protocol === 'span') {
        return {
          step: { kind: 'memory_block', L, mode, params, trials: spanProtocolTrials(createRng(seed)).slice(0, count), protocol, audio: null },
          paramsJson: JSON.stringify({ protocol, mode, ...params, trials: count }),
        };
      }
      // A 3×3 card with sound plays CARD_AUDIO while it is on screen (F13).
      const trials = generateMemoryTrials(params, mode, count, createRng(seed));
      return {
        step: { kind: 'memory_block', L, mode, params, trials, protocol, audio: params.sound ? CARD_AUDIO : null },
        paramsJson: JSON.stringify({ mode, ...params, trials: count }),
      };
    }
    case 'numseries': {
      // Diagnostic items have no per-item limit: the total limit applies, as in 0.1.0 (R19, R36).
      const items: TimedSeriesItem[] = plan.diagnostic
        ? diagnosticFormItems(plan.count, seriesForm)
        : generateBlockItems(new Map([...ratings].map(([f, r]) => [f, r.rating])), plan.count, createRng(seed));
      const { totalLimitMs } = plan;
      return {
        step: { kind: 'numseries_block', items, totalLimitMs },
        paramsJson: JSON.stringify({ items: items.length, itemLimitsMs: items.map((it) => it.timeLimitMs), totalLimitMs }),
      };
    }
  }
}

/** The first `count` items of form `form` of the diagnostic number series (F12): fixed, whatever else. */
function diagnosticFormItems(count: number, form: number | undefined): TimedSeriesItem[] {
  if (form === undefined) throw new Error('buildBlock: a diagnostic number-series block needs its seriesForm');
  // Seed index form + 1 plays form `form` (seriesFormOf).
  return diagnosticSeriesItems(form + 1, count).map((it) => ({ ...it, timeLimitMs: null }));
}

/**
 * The mark flags of a block's trials (F15): 'every' marks each, 'half' trial i by the i-th draw of
 * createRng(deriveSeed(seed, 'feedback')) (< 0.5), practice trials included; 'none' leaves the trials as they are.
 */
function withFeedback(specs: TrialSpec[], rate: FeedbackRate, seed: number): TrialSpec[] {
  if (rate === 'none') return specs;
  const rng = createRng(deriveSeed(seed, 'feedback'));
  return specs.map((t) => ({ ...t, feedback: rate === 'every' || rng.next() < 0.5 }));
}

/**
 * The jitter of a block's trials (F9, Справочник): from createRng(deriveSeed(seed, 'jitter')), trial by trial, practice
 * included, dx = (2·next − 1)·0.15, dy the same, scale = 0.9 + 0.2·next. 'size' draws all three and keeps dx = dy = 0;
 * 'none' leaves the trials as they are.
 */
function withJitter(specs: TrialSpec[], kind: JitterKind, seed: number): TrialSpec[] {
  if (kind === 'none') return specs;
  const rng = createRng(deriveSeed(seed, 'jitter'));
  return specs.map((t) => {
    const dx = (2 * rng.next() - 1) * JITTER_SHIFT;
    const dy = (2 * rng.next() - 1) * JITTER_SHIFT;
    const scale = 1 - JITTER_SCALE + 2 * JITTER_SCALE * rng.next();
    return { ...t, jitter: kind === 'size' ? { dx: 0, dy: 0, scale } : { dx, dy, scale } };
  });
}

/**
 * What a reaction block stores as paramsJson: its parameters (the key mapping among them, F9) with `trials` the size
 * it played (practice left out: a diagnostic ПЗМР plays 50 on parameters that say 15, the e2e scale shrinks every
 * block, T-R48) and `layout` the layout it played (the keyboard when the mouse has too few keys, F9); for a band
 * module the nominal window and the floor (F3); an overload block names its own band b and the band whose load it
 * played (T-R25).
 */
function reactionParamsJson(plan: Extract<BlockPlan, { kind: 'reaction' }>): unknown {
  const { load } = plan;
  const params = { ...(plan.params as object), trials: plan.size, layout: plan.layout };
  if (load === null) return params;
  const floor = { nominalWindowMs: load.nominalWindowMs, floorMs: load.floorMs };
  if (load.loadBand === null) return { ...params, ...floor };
  const { band, bandLabel, loadBand, loadBandLabel } = load;
  return { ...params, band, bandLabel, loadBand, loadBandLabel, ...floor };
}

/** An overload block adds the finisher sound to the module's own on every trial; the noise keeps its trials (W2-R10). */
function overloadStressors(s: BlockStressors): BlockStressors {
  return { noise: s.noise, audio: mergeAudio(s.audio, FINISHER_AUDIO), gate: 'all', noiseGate: s.noiseGate };
}

export interface ScoredReaction {
  results: TrialResult[];
  summary: ReactionSummary;
  /** Clean hit RTs (isCleanHitRt): `press` hits outside practice whose onset frame was not dropped (FatigueBlock.hitRts). */
  hitRts: number[];
  /** Per trial condition ({} for modules without conditions). */
  conditions: ConditionStats;
}

/** Outcomes and summary of a reaction block; null when no trial counts (nothing to score). */
export function scoreReaction(specs: readonly TrialSpec[], tl: BlockTimeline): ScoredReaction | null {
  const results = resolveBlock(specs, tl);
  const summary = summarize(results);
  if (summary.n === 0) return null;
  const hitRts = results.flatMap((r) => (isCleanHitRt(r) ? [r.rtMs] : []));
  return { results, summary, hitRts, conditions: conditionStats(specs, results) };
}

export interface SeriesOutcome {
  item: TimedSeriesItem;
  answer: SeriesAnswer;
  /** given === answer. */
  correct: boolean;
  /** Correct inside the item's own limit and the total limit (Elo success, diagnostic count). */
  success: boolean;
}

/**
 * Answers matched to the block's items one to one, in order, and scored; a skipped item is wrong (F11). RangeError for a
 * step with both kinds of limit.
 */
export function scoreSeries(step: StepOf<'numseries_block'>, answers: readonly SeriesAnswer[]): SeriesOutcome[] {
  const { items, totalLimitMs } = step;
  if (totalLimitMs !== null && items.some((it) => it.timeLimitMs !== null)) {
    throw new RangeError('submitNumSeries: a block has item limits (training) or a total limit (diagnostic), not both');
  }
  if (answers.length !== items.length) {
    throw new RangeError(`submitNumSeries: ${String(answers.length)} answers for ${String(items.length)} items`);
  }
  let elapsed = 0;
  return items.map((item, i) => {
    const answer = answers[i];
    if (answer?.itemId !== item.id) throw new RangeError(`submitNumSeries: answer ${String(i)} is not for item ${item.id}`);
    elapsed += answer.timeMs;
    const correct = answer.skipped !== true && answer.given === item.answer;
    const limitMs = item.timeLimitMs;
    const inTime = (limitMs === null || answer.timeMs <= limitMs) && (totalLimitMs === null || elapsed <= totalLimitMs);
    return { item, answer, correct, success: correct && inTime };
  });
}

/** Elo per family after the block's items, in order, at each item's effective difficulty (as deriveRatings, R36). */
export function updatedRatings(
  ratings: ReadonlyMap<FamilyId, Rating>,
  outcomes: readonly SeriesOutcome[],
): Map<FamilyId, Rating> {
  const next = new Map(ratings);
  for (const o of outcomes) {
    const current = next.get(o.item.family) ?? { rating: R0, n: 0 };
    next.set(o.item.family, updateRating(current, itemEffectiveDifficulty(o.item), o.success));
  }
  return next;
}

/**
 * The answers of a memory block: one per trial, or for the span protocol fewer when it stopped exactly on the last
 * one (spanProtocolStops) and on no answer before it. RangeError otherwise.
 */
export function checkMemoryAnswers(step: StepOf<'memory_block'>, answers: readonly MemoryAnswer[]): void {
  const { trials, protocol } = step;
  const n = answers.length;
  if (n > trials.length) throw new RangeError(`submitMemory: ${String(n)} answers for ${String(trials.length)} trials`);
  if (protocol === 'span') {
    for (let k = 1; k < n; k++) {
      if (spanProtocolStops(trials, answers.slice(0, k))) {
        throw new RangeError(`submitMemory: the span protocol stopped after answer ${String(k)}, got ${String(n)} answers`);
      }
    }
    if (n === trials.length || spanProtocolStops(trials, answers)) return;
  } else if (n === trials.length) {
    return;
  }
  throw new RangeError(`submitMemory: ${String(n)} answers for ${String(trials.length)} trials`);
}

/** What one diagnostic block adds to DiagnosticResults. */
export type DiagnosticPart =
  | {
      module: ReactionModuleId;
      summary: ReactionSummary;
      conditions: ConditionStats;
      /** Clean hit RTs of the block (ScoredReaction.hitRts): the spread of ПЗМР and СЗМР (F7). */
      hitRts: number[];
    }
  | { module: 'gorbov'; run: number; seconds: number | null }
  /** `form`: the form (0–5) the series played (T-R73). */
  | { module: 'numseries'; correct: number; total: number; form: number }
  | { module: 'memory'; span: number };

/** The fast and slow condition medians of a block and their difference; null where a median is missing. */
function condMetrics(conditions: ConditionStats, { slow, fast }: CondPair): [fast: number | null, slow: number | null, cost: number | null] {
  return [conditions[fast]?.medianRt ?? null, conditions[slow]?.medianRt ?? null, condCost(conditions, slow, fast)];
}

/** SD (sdTrimmed) and IQR of clean hit RTs; null below 2 of them (one RT has no spread, F7). */
function spreadOf(hitRts: readonly number[]): [sd: number | null, iqr: number | null] {
  if (hitRts.length < 2) return [null, null];
  return [sdTrimmed(hitRts), quantile(hitRts, 0.75) - quantile(hitRts, 0.25)];
}

/**
 * pzmr/szmr medianRt and meanRt, gonogo score × 100 (percent, Ruling R18; the share of successes, never the penalised s,
 * so it stays comparable with 0.2.0, F1), rdo meanAbsErrorMs, Gorbov metrics only when all three runs were completed,
 * number series correct within the total limit; the condition medians and their difference of pomeh, stroop and
 * taskswitch, the memory span. F7: the SD and IQR of ПЗМР and СЗМР clean hits, their false starts, wrong keys of
 * СЗМР, presses on no-go and misses + late answers of Go/No-Go, `early`, `timing_late` and the signed bias of РДО.
 * Missing parts stay null.
 * Reaction blocks stored with timingUnreliable (after their replay) list their module in `unreliable`; `restarts` are the
 * restarts of each module's tasks (F11), copied; `gorbovOneTable` is true: the three Горбов tasks share one table (F10);
 * `seriesForm` is 'v2': the number series play the six fixed forms (F12), and `seriesFormIndex` the form it played (T-R73).
 */
export function diagnosticResults(parts: readonly DiagnosticPart[], restarts: DiagnosticResults['restarts'] = {}): DiagnosticResults {
  const copied = Object.fromEntries(Object.entries(restarts).map(([m, r]) => [m, { ...r }])) as DiagnosticResults['restarts'];
  const unreliable: ReactionModuleId[] = [];
  // Горбов's three tasks play one table (F10); the number series, the forms v2 (F12).
  const r: DiagnosticResults = { ...EMPTY_METRICS, unreliable, restarts: copied, gorbovOneTable: true, seriesForm: 'v2', seriesFormIndex: null };
  const seconds: Array<number | null> = [];
  for (const p of parts) {
    if ('summary' in p && p.summary.timingUnreliable) unreliable.push(p.module);
    switch (p.module) {
      case 'pzmr':
        r.pzmrMedianRt = p.summary.medianRt;
        r.pzmrMeanRt = p.summary.meanRt;
        [r.pzmrSdRt, r.pzmrIqrRt] = spreadOf(p.hitRts);
        r.pzmrFalseStarts = p.summary.counts.false_start;
        break;
      case 'szmr':
        r.szmrMedianRt = p.summary.medianRt;
        r.szmrMeanRt = p.summary.meanRt;
        [r.szmrSdRt, r.szmrIqrRt] = spreadOf(p.hitRts);
        r.szmrFalseStarts = p.summary.counts.false_start;
        r.szmrWrong = p.summary.counts.wrong;
        break;
      case 'gonogo':
        r.gonogoScore = p.summary.score * 100;
        r.gonogoCommissions = p.summary.counts.commission;
        r.gonogoOmissions = p.summary.counts.miss + p.summary.counts.late;
        break;
      case 'rdo':
        r.rdoMeanAbsErrorMs = p.summary.meanAbsErrorMs;
        r.rdoEarly = p.summary.counts.early;
        r.rdoLate = p.summary.counts.timing_late;
        r.rdoSignedBiasMs = p.summary.meanSignedErrorMs;
        break;
      case 'gorbov':
        seconds[p.run] = p.seconds;
        break;
      case 'numseries':
        r.numseriesCorrect = p.correct;
        r.seriesFormIndex = p.form;
        break;
      case 'pomeh':
        [r.pomehQuietRt, r.pomehNoisyRt, r.pomehDeltaMs] = condMetrics(p.conditions, COND_PAIRS.pomeh);
        break;
      case 'stroop':
        [r.stroopCongruentRt, r.stroopIncongruentRt, r.stroopInterferenceMs] = condMetrics(p.conditions, COND_PAIRS.stroop);
        break;
      case 'taskswitch':
        [r.switchRepeatRt, r.switchSwitchRt, r.switchCostMs] = condMetrics(p.conditions, COND_PAIRS.taskswitch);
        break;
      case 'memory':
        r.memorySpan = p.span;
        break;
    }
  }
  const [t1, t2, t3] = seconds;
  const finished = (t: number | null | undefined): t is number => typeof t === 'number';
  if (finished(t1) && finished(t2) && finished(t3)) r.gorbov = gorbovMetrics(t1, t2, t3);
  return r;
}
