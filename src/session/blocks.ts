import { EMPTY_METRICS, diagnosticSegmentSeed, diagnosticSeriesSchedule, type DiagnosticResults } from '../engine/diagnostic';
import { R0, updateRating, type Rating } from '../engine/elo';
import { itemEffectiveDifficulty } from '../engine/itemLimit';
import { keyLabel, layoutKeys } from '../engine/layouts';
import { FINISHER_AUDIO, mergeAudio } from '../engine/audio/stressors';
import { OVERLOAD_LEVEL_STEP, type Segment } from '../engine/planner';
import { COND_PAIRS, MIN_COND_RTS, condCost, conditionStats, type CondPair, type ConditionStats } from '../engine/reaction/conditions';
import { resolveBlock } from '../engine/reaction/resolve';
import { summarize } from '../engine/reaction/summary';
import type { BlockTimeline, ReactionSummary, TrialResult, TrialSpec } from '../engine/reaction/types';
import { createRng, deriveSeed } from '../engine/rng';
import {
  isReactionModule,
  type FamilyId,
  type InputKey,
  type LayoutId,
  type ModuleId,
  type ReactionModuleId,
  type TableModuleId,
} from '../engine/types';
import { generateMemoryTrials, SPAN_PROTOCOL_PARAMS, SPAN_PROTOCOL_TRIALS, spanProtocolTrials } from '../modules/memory/generate';
import { spanProtocolStops, type MemoryAnswer } from '../modules/memory/score';
import {
  MEMORY_TRIALS,
  memoryInstruction,
  memoryKeysHint,
  memoryModeForBlock,
  memoryParams,
  type MemoryMode,
  type MemoryParams,
} from '../modules/memory/params';
import { generateBlockItems, generateItem, type TimedSeriesItem } from '../modules/numseries/generate';
import { stressorsOf, type BlockStressors, type ReactionModule } from '../modules/reaction/common';
import { reactionModules } from '../modules/registry';
import {
  generateGorbovTable,
  gorbovMetrics,
  gorbovParams,
  gorbovTaskForRun,
  tableInstruction,
  type TableParams,
  type TableTaskId,
} from '../modules/tables/gorbov';
import { generateSchulteTable, schulteParams } from '../modules/tables/schulte';
import {
  MEMORY_SPAN_INSTRUCTION,
  OVERLOAD_PREFIX,
  SERIES_INSTRUCTION_TRAINING,
  SERIES_KEYS_HINT,
  seriesDiagnosticInstruction,
  TABLE_KEYS_HINT,
  type SeriesAnswer,
  type StepOf,
} from './steps';

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

/**
 * The next block of a segment, decided before its instruction: level, parameters, task, keys and volume.
 * `overload`: an overload block (isOverloadBlock); number series never are.
 */
export type BlockPlan =
  | {
      kind: 'reaction';
      module: ReactionModuleId;
      L: number;
      params: unknown;
      keys: InputKey[];
      /** Effective layout ('keyboard' when the mouse cannot serve the keys). */
      layout: LayoutId;
      size: number;
      practice: number;
      overload: boolean;
    }
  | { kind: 'table'; module: TableModuleId; L: number; task: TableTaskId; params: TableParams; overload: boolean }
  /**
   * Memory blocks cycle their mode by block index; `count` trials. A diagnostic plays the span protocol instead:
   * digits, its first `count` trials, ending early when it stops.
   */
  | { kind: 'memory'; protocol: 'fixed' | 'span'; L: number; mode: MemoryMode; params: MemoryParams; count: number; overload: boolean }
  /** Training items carry their own limits (R36); `totalLimitMs` is the diagnostic's block limit. */
  | { kind: 'numseries'; diagnostic: boolean; count: number; totalLimitMs: number | null };

export type BlockStep = StepOf<'reaction_block'> | StepOf<'table_block'> | StepOf<'numseries_block'> | StepOf<'memory_block'>;

export interface PlanContext {
  /** The user's layout. */
  layout: LayoutId;
  scale: number;
  diagnostic: boolean;
}

/** Every block of a finisher; the odd blocks (1, 3, …) of a plateau mix. */
export function isOverloadBlock(segment: Segment, blockIndex: number): boolean {
  return segment.overload === 'finisher' || (segment.overload === 'mix' && blockIndex % 2 === 1);
}

/**
 * Block `blockIndex` of the segment whose level is `segmentL` (Gorbov runs cycle their tasks, memory blocks
 * their mode, by index). An overload block of a mix plays OVERLOAD_LEVEL_STEP above the segment level; a
 * finisher's segment level already includes the step.
 */
export function planBlock(segment: Segment, segmentL: number, blockIndex: number, ctx: PlanContext): BlockPlan {
  const { module } = segment;
  const overload = isOverloadBlock(segment, blockIndex);
  const L = overload && segment.overload === 'mix' ? segmentL + OVERLOAD_LEVEL_STEP : segmentL;
  if (isReactionModule(module)) {
    const mod = reactionModules[module];
    const params = mod.params(L);
    const { keys, effectiveLayout } = layoutKeys(ctx.layout, mod.keyCount(params));
    return {
      kind: 'reaction',
      module,
      L,
      params,
      keys,
      layout: effectiveLayout,
      size: reactionBlockSize(mod, params, segment.trialCount ?? mod.blockSize, ctx.scale),
      practice: scaledPractice(segment.practiceTrials ?? 0, ctx.scale),
      overload,
    };
  }
  if (module === 'gorbov') {
    const task = gorbovTaskForRun(blockIndex);
    return { kind: 'table', module, L, task, params: gorbovParams(L, task), overload };
  }
  if (module === 'schulte') return { kind: 'table', module, L, task: 'schulte', params: schulteParams(L), overload };
  if (module === 'memory') {
    if (ctx.diagnostic) {
      const count = scaledCount(SPAN_PROTOCOL_TRIALS, ctx.scale);
      return { kind: 'memory', protocol: 'span', L, mode: 'digits', params: { ...SPAN_PROTOCOL_PARAMS }, count, overload };
    }
    const count = scaledCount(MEMORY_TRIALS, ctx.scale);
    return { kind: 'memory', protocol: 'fixed', L, mode: memoryModeForBlock(blockIndex), params: memoryParams(L), count, overload };
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

/** The instruction before a block; an overload block's text starts with OVERLOAD_PREFIX. */
export function blockInstruction(plan: BlockPlan, layout: LayoutId): { text: string; keysHint: string } {
  const { text, keysHint } = plainInstruction(plan, layout);
  return { text: plan.kind !== 'numseries' && plan.overload ? OVERLOAD_PREFIX + text : text, keysHint };
}

function plainInstruction(plan: BlockPlan, layout: LayoutId): { text: string; keysHint: string } {
  switch (plan.kind) {
    case 'reaction':
      return {
        text: reactionModules[plan.module].instruction(layout, plan.params),
        keysHint: plan.keys.map(keyLabel).join(', '),
      };
    case 'table':
      return { text: tableInstruction(plan.task, plan.params.size), keysHint: TABLE_KEYS_HINT };
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

/** The block step for `plan` from `seed` (and the ratings, for training number series), plus its params JSON. */
export function buildBlock(
  plan: BlockPlan,
  seed: number,
  layout: LayoutId,
  ratings: ReadonlyMap<FamilyId, Rating>,
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
      const specs = [...practice, ...mod.generateBlock(plan.params, createRng(seed), layout, plan.size)];
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
        paramsJson: JSON.stringify(plan.params),
      };
    }
    case 'table': {
      const rng = createRng(seed);
      const cells = plan.module === 'gorbov' ? generateGorbovTable(rng) : generateSchulteTable(plan.params.size, rng);
      return {
        step: { kind: 'table_block', module: plan.module, L: plan.L, task: plan.task, cells, params: plan.params, seed },
        paramsJson: JSON.stringify({ task: plan.task, ...plan.params }),
      };
    }
    case 'memory': {
      const { L, mode, params, count, protocol } = plan;
      if (protocol === 'span') {
        return {
          step: { kind: 'memory_block', L, mode, params, trials: spanProtocolTrials(createRng(seed)).slice(0, count), protocol },
          paramsJson: JSON.stringify({ protocol, mode, ...params, trials: count }),
        };
      }
      return {
        step: { kind: 'memory_block', L, mode, params, trials: generateMemoryTrials(params, mode, count, createRng(seed)), protocol },
        paramsJson: JSON.stringify({ mode, ...params, trials: count }),
      };
    }
    case 'numseries': {
      // Diagnostic items have no per-item limit: the total limit applies, as in 0.1.0 (R19, R36).
      const items: TimedSeriesItem[] = plan.diagnostic
        ? diagnosticSeriesSchedule()
            .slice(0, plan.count)
            .map((e, i) => ({ ...generateItem(e.family, e.targetD, deriveSeed(seed, 'item:' + String(i))), timeLimitMs: null }))
        : generateBlockItems(new Map([...ratings].map(([f, r]) => [f, r.rating])), plan.count, createRng(seed));
      const { totalLimitMs } = plan;
      return {
        step: { kind: 'numseries_block', items, totalLimitMs },
        paramsJson: JSON.stringify({ items: items.length, itemLimitsMs: items.map((it) => it.timeLimitMs), totalLimitMs }),
      };
    }
  }
}

/** An overload block adds the finisher sound to the module's own on every trial; the noise keeps its trials (W2-R10). */
function overloadStressors(s: BlockStressors): BlockStressors {
  return { noise: s.noise, audio: mergeAudio(s.audio, FINISHER_AUDIO), gate: 'all' };
}

export interface ScoredReaction {
  results: TrialResult[];
  summary: ReactionSummary;
  /** RTs of `press` hits outside practice whose onset frame was not dropped (FatigueBlock.hitRts). */
  hitRts: number[];
  /** Per trial condition ({} for modules without conditions). */
  conditions: ConditionStats;
}

/** Outcomes and summary of a reaction block; null when no trial counts (nothing to score). */
export function scoreReaction(specs: readonly TrialSpec[], tl: BlockTimeline): ScoredReaction | null {
  const results = resolveBlock(specs, tl);
  const summary = summarize(results);
  if (summary.n === 0) return null;
  const hitRts = results.flatMap((r) =>
    !r.practice && !r.frameDropped && r.kind === 'press' && r.outcome === 'hit' && r.rtMs !== null ? [r.rtMs] : [],
  );
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

/** Answers matched to the block's items one to one, in order, and scored. */
export function scoreSeries(step: StepOf<'numseries_block'>, answers: readonly SeriesAnswer[]): SeriesOutcome[] {
  const { items, totalLimitMs } = step;
  if (answers.length !== items.length) {
    throw new RangeError(`submitNumSeries: ${String(answers.length)} answers for ${String(items.length)} items`);
  }
  let elapsed = 0;
  return items.map((item, i) => {
    const answer = answers[i];
    if (answer?.itemId !== item.id) throw new RangeError(`submitNumSeries: answer ${String(i)} is not for item ${item.id}`);
    elapsed += answer.timeMs;
    const correct = answer.given === item.answer;
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
  | { module: ReactionModuleId; summary: ReactionSummary; conditions: ConditionStats }
  | { module: 'gorbov'; run: number; seconds: number | null }
  | { module: 'numseries'; correct: number; total: number }
  | { module: 'memory'; span: number };

/** The fast and slow condition medians of a block and their difference; null where a median is missing. */
function condMetrics(conditions: ConditionStats, { slow, fast }: CondPair): [fast: number | null, slow: number | null, cost: number | null] {
  return [conditions[fast]?.medianRt ?? null, conditions[slow]?.medianRt ?? null, condCost(conditions, slow, fast)];
}

/**
 * pzmr/szmr medianRt, gonogo score × 100 (percent, Ruling R18), rdo meanAbsErrorMs, Gorbov metrics only when
 * all three runs were completed, number series correct within the total limit; the condition medians and their
 * difference of pomeh, stroop and taskswitch, the memory span. Missing parts stay null.
 * Reaction blocks stored with timingUnreliable (after their replay) list their module in `unreliable`.
 */
export function diagnosticResults(parts: readonly DiagnosticPart[]): DiagnosticResults {
  const r: DiagnosticResults = { ...EMPTY_METRICS, unreliable: [] };
  const seconds: Array<number | null> = [];
  for (const p of parts) {
    if ('summary' in p && p.summary.timingUnreliable) r.unreliable.push(p.module);
    switch (p.module) {
      case 'pzmr':
        r.pzmrMedianRt = p.summary.medianRt;
        break;
      case 'szmr':
        r.szmrMedianRt = p.summary.medianRt;
        break;
      case 'gonogo':
        r.gonogoScore = p.summary.score * 100;
        break;
      case 'rdo':
        r.rdoMeanAbsErrorMs = p.summary.meanAbsErrorMs;
        break;
      case 'gorbov':
        seconds[p.run] = p.seconds;
        break;
      case 'numseries':
        r.numseriesCorrect = p.correct;
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
