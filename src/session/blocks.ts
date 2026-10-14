import { diagnosticSegmentSeed, diagnosticSeriesSchedule, type DiagnosticResults } from '../engine/diagnostic';
import { R0, updateRating, type Rating } from '../engine/elo';
import { keyLabel, layoutKeys } from '../engine/layouts';
import type { Segment } from '../engine/planner';
import { resolveBlock } from '../engine/reaction/resolve';
import { summarize } from '../engine/reaction/summary';
import type { BlockTimeline, ReactionSummary, TrialResult, TrialSpec } from '../engine/reaction/types';
import { createRng, deriveSeed } from '../engine/rng';
import type { FamilyId, InputKey, LayoutId, ModuleId, ReactionModuleId, TableModuleId } from '../engine/types';
import { generateBlockItems, generateItem, ITEM_TIME_LIMIT_MS, type SeriesItem } from '../modules/numseries/generate';
import type { SzmrParams } from '../modules/reaction/szmr';
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

export const isReaction = (m: ModuleId): m is ReactionModuleId =>
  m === 'pzmr' || m === 'szmr' || m === 'gonogo' || m === 'rdo';

/** Block size or item count under the e2e scale: max(3, round(n·scale)). */
export function scaledCount(n: number, scale: number): number {
  return Math.max(MIN_SCALED, Math.round(n * scale));
}

/** Practice trials stay as planned unless the e2e scale shrinks them: max(1, round(n·scale)). */
export function scaledPractice(n: number, scale: number): number {
  return n > 0 && scale < 1 ? Math.max(1, Math.round(n * scale)) : n;
}

/** The next block of a segment, decided before its instruction: level, parameters, task, keys and volume. */
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
    }
  | { kind: 'table'; module: TableModuleId; L: number; task: TableTaskId; params: TableParams }
  | { kind: 'numseries'; diagnostic: boolean; count: number; perItemLimitMs: number | null; totalLimitMs: number | null };

export type BlockStep = StepOf<'reaction_block'> | StepOf<'table_block'> | StepOf<'numseries_block'>;

export interface PlanContext {
  /** The user's layout. */
  layout: LayoutId;
  scale: number;
  diagnostic: boolean;
}

/** Keys a reaction block uses: СЗМР has nKeys, the other modules one. */
function keyCount(module: ReactionModuleId, params: unknown): number {
  return module === 'szmr' ? (params as SzmrParams).nKeys : 1;
}

/** Block `blockIndex` of the segment at level L (Gorbov runs cycle their tasks by index). */
export function planBlock(segment: Segment, L: number, blockIndex: number, ctx: PlanContext): BlockPlan {
  const { module } = segment;
  if (isReaction(module)) {
    const mod = reactionModules[module];
    const params = mod.params(L);
    const { keys, effectiveLayout } = layoutKeys(ctx.layout, keyCount(module, params));
    return {
      kind: 'reaction',
      module,
      L,
      params,
      keys,
      layout: effectiveLayout,
      size: scaledCount(segment.trialCount ?? mod.blockSize, ctx.scale),
      practice: scaledPractice(segment.practiceTrials ?? 0, ctx.scale),
    };
  }
  if (module === 'gorbov') {
    const task = gorbovTaskForRun(blockIndex);
    return { kind: 'table', module, L, task, params: gorbovParams(L, task) };
  }
  if (module === 'schulte') return { kind: 'table', module, L, task: 'schulte', params: schulteParams(L) };
  if (ctx.diagnostic) {
    const scheduled = diagnosticSeriesSchedule().length;
    const total = segment.totalTimeLimitMs;
    return {
      kind: 'numseries',
      diagnostic: true,
      count: Math.min(scheduled, scaledCount(segment.items ?? scheduled, ctx.scale)),
      perItemLimitMs: null,
      totalLimitMs: total === undefined ? null : Math.round(total * ctx.scale),
    };
  }
  return {
    kind: 'numseries',
    diagnostic: false,
    count: scaledCount(SERIES_BLOCK_ITEMS, ctx.scale),
    perItemLimitMs: ITEM_TIME_LIMIT_MS,
    totalLimitMs: null,
  };
}

export function blockInstruction(plan: BlockPlan, layout: LayoutId): { text: string; keysHint: string } {
  switch (plan.kind) {
    case 'reaction':
      return {
        text: reactionModules[plan.module].instruction(layout, plan.params),
        keysHint: plan.keys.map(keyLabel).join(', '),
      };
    case 'table':
      return { text: tableInstruction(plan.task, plan.params.size), keysHint: TABLE_KEYS_HINT };
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
      return {
        step: { kind: 'reaction_block', module: plan.module, L: plan.L, specs, keys: plan.keys, layout: plan.layout },
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
    case 'numseries': {
      const items = plan.diagnostic
        ? diagnosticSeriesSchedule()
            .slice(0, plan.count)
            .map((e, i) => generateItem(e.family, e.targetD, deriveSeed(seed, 'item:' + String(i))))
        : generateBlockItems(new Map([...ratings].map(([f, r]) => [f, r.rating])), plan.count, createRng(seed));
      const { perItemLimitMs, totalLimitMs } = plan;
      return {
        step: { kind: 'numseries_block', items, perItemLimitMs, totalLimitMs },
        paramsJson: JSON.stringify({ items: items.length, perItemLimitMs, totalLimitMs }),
      };
    }
  }
}

export interface ScoredReaction {
  results: TrialResult[];
  summary: ReactionSummary;
  /** RTs of `press` hits outside practice (FatigueBlock.hitRts). */
  hitRts: number[];
}

/** Outcomes and summary of a reaction block; null when no trial counts (nothing to score). */
export function scoreReaction(specs: readonly TrialSpec[], tl: BlockTimeline): ScoredReaction | null {
  const results = resolveBlock(specs, tl);
  const summary = summarize(results);
  if (summary.n === 0) return null;
  const hitRts = results.flatMap((r) =>
    !r.practice && r.kind === 'press' && r.outcome === 'hit' && r.rtMs !== null ? [r.rtMs] : [],
  );
  return { results, summary, hitRts };
}

export interface SeriesOutcome {
  item: SeriesItem;
  answer: SeriesAnswer;
  /** given === answer. */
  correct: boolean;
  /** Correct inside the per-item limit and the total limit (Elo success, diagnostic count). */
  success: boolean;
}

/** Answers matched to the block's items one to one, in order, and scored. */
export function scoreSeries(step: StepOf<'numseries_block'>, answers: readonly SeriesAnswer[]): SeriesOutcome[] {
  const { items, perItemLimitMs, totalLimitMs } = step;
  if (answers.length !== items.length) {
    throw new RangeError(`submitNumSeries: ${String(answers.length)} answers for ${String(items.length)} items`);
  }
  let elapsed = 0;
  return items.map((item, i) => {
    const answer = answers[i];
    if (answer?.itemId !== item.id) throw new RangeError(`submitNumSeries: answer ${String(i)} is not for item ${item.id}`);
    elapsed += answer.timeMs;
    const correct = answer.given === item.answer;
    const inTime =
      (perItemLimitMs === null || answer.timeMs <= perItemLimitMs) && (totalLimitMs === null || elapsed <= totalLimitMs);
    return { item, answer, correct, success: correct && inTime };
  });
}

/** Elo per family after the block's items, in order. */
export function updatedRatings(
  ratings: ReadonlyMap<FamilyId, Rating>,
  outcomes: readonly SeriesOutcome[],
): Map<FamilyId, Rating> {
  const next = new Map(ratings);
  for (const o of outcomes) {
    const current = next.get(o.item.family) ?? { rating: R0, n: 0 };
    next.set(o.item.family, updateRating(current, o.item.difficulty, o.success));
  }
  return next;
}

/** What one diagnostic block adds to DiagnosticResults. */
export type DiagnosticPart =
  | { module: ReactionModuleId; summary: ReactionSummary }
  | { module: 'gorbov'; run: number; seconds: number | null }
  | { module: 'numseries'; correct: number };

/**
 * pzmr/szmr medianRt, gonogo score × 100 (percent, Ruling R18), rdo meanAbsErrorMs, Gorbov metrics only when
 * all three runs were completed, number series correct within the total limit. Missing parts stay null.
 */
export function diagnosticResults(parts: readonly DiagnosticPart[]): DiagnosticResults {
  const r: DiagnosticResults = {
    pzmrMedianRt: null,
    szmrMedianRt: null,
    gonogoScore: null,
    rdoMeanAbsErrorMs: null,
    gorbov: null,
    numseriesCorrect: null,
  };
  const seconds: Array<number | null> = [];
  for (const p of parts) {
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
    }
  }
  const [t1, t2, t3] = seconds;
  const finished = (t: number | null | undefined): t is number => typeof t === 'number';
  if (finished(t1) && finished(t2) && finished(t3)) r.gorbov = gorbovMetrics(t1, t2, t3);
  return r;
}
