import { v4 as uuidv4 } from 'uuid';
import type { Repository } from '../data/repository';
import type { BlockRow, LogicItemRow, SessionRow, TrialRow, WellbeingRow } from '../data/rows';
import { detectFatigue, nextLevel, startLevel } from '../engine/adaptive';
import { daysBetween } from '../engine/dates';
import { deriveModuleStates } from '../engine/derive';
import { diagnosticSegmentSeed, diagnosticSeriesSchedule, type DiagnosticResults } from '../engine/diagnostic';
import { R0, updateRating, type Rating } from '../engine/elo';
import { keyLabel, layoutKeys } from '../engine/layouts';
import type { ModuleState, Segment, SessionPlan } from '../engine/planner';
import { resolveBlock } from '../engine/reaction/resolve';
import { summarize } from '../engine/reaction/summary';
import type { BlockTimeline, ReactionSummary, TrialResult } from '../engine/reaction/types';
import { createRng, deriveSeed } from '../engine/rng';
import { mean } from '../engine/stats';
import type { BlockFlag, FamilyId, InputKey, LayoutId, ModuleId, ReactionModuleId, TableModuleId } from '../engine/types';
import { describeChanges } from '../modules/describe';
import { generateBlockItems, generateItem, ITEM_TIME_LIMIT_MS, type SeriesItem } from '../modules/numseries/generate';
import type { SzmrParams } from '../modules/reaction/szmr';
import { moduleTitles, reactionModules } from '../modules/registry';
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
import { scoreTableRun, type TableRun } from '../modules/tables/score';
import {
  reactionLines,
  seriesLines,
  SERIES_INSTRUCTION_DIAGNOSTIC,
  SERIES_INSTRUCTION_TRAINING,
  SERIES_KEYS_HINT,
  TABLE_KEYS_HINT,
  tableLines,
  type BlockSummaryView,
  type SeriesAnswer,
  type Step,
  type StepOf,
} from './steps';

export interface SessionStartOptions {
  repo: Repository;
  plan: SessionPlan;
  /** The user's layout; a block that needs more keys than the mouse has switches to the keyboard. */
  layout: LayoutId;
  /** Wall clock: session/block dates and segment budgets (never trial timing). */
  now: () => Date;
  appVersion: string;
  /** e2e only (Task 15): budgets × scale, block sizes and item counts max(3, round(n·scale)). Default 1. */
  scale?: number;
  /** Pause between save attempts; tests inject an instant one. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export type DiscardReason = 'focus_lost' | 'error';

const PHASE = 'w1';
/** Pauses between the 3 save attempts. */
const SAVE_RETRY_DELAYS_MS: readonly number[] = [100, 500];
const SERIES_BLOCK_ITEMS = 10;
/** Floor for scaled block sizes and item counts (e2e). */
const MIN_SCALED = 3;
/** First 3 blocks of a module ever are calibration blocks (g = 2). */
const CALIBRATION_BLOCKS = 3;

/** The next block of the segment, decided before its instruction: level, parameters, task and keys are fixed. */
type BlockPlan =
  | { kind: 'reaction'; module: ReactionModuleId; L: number; params: unknown; keys: InputKey[]; layout: LayoutId }
  | { kind: 'table'; module: TableModuleId; L: number; task: TableTaskId; params: TableParams }
  | { kind: 'numseries' };

/** The block on screen. A discard rebuilds it from the same plan with the next attempt's seed. */
interface ActiveBlock {
  plan: BlockPlan;
  startedAt: string;
  paramsJson: string;
}

interface SegmentRun {
  index: number;
  segment: Segment;
  /** Level of the next block. */
  L: number;
  /** Wall-clock ms of the first instruction ack; null before it. */
  clockStart: number | null;
  blocksDone: number;
  /** Discards of the current block. */
  attempt: number;
  /** Text and key hint of the last instruction shown in the segment. */
  lastInstruction: string | null;
}

/** A finished block of this session, for calibration, the g = 2 rule and fatigue. */
interface SessionBlock {
  module: ModuleId;
  score: number;
  flags: BlockFlag[];
  /** RTs of `press` hits (FatigueBlock.hitRts). */
  hitRts: number[];
}

interface PendingSave {
  writes: Array<{ run: () => Promise<void>; done: boolean }>;
  onSaved: () => void | Promise<void>;
}

const isReaction = (m: ModuleId): m is ReactionModuleId => m === 'pzmr' || m === 'szmr' || m === 'gonogo' || m === 'rdo';
const isTable = (m: ModuleId): m is TableModuleId => m === 'gorbov' || m === 'schulte';

/** Keys a reaction block uses: СЗМР has nKeys, the other modules one. */
function keyCount(module: ReactionModuleId, params: unknown): number {
  return module === 'szmr' ? (params as SzmrParams).nKeys : 1;
}

/** Local calendar date YYYY-MM-DD. */
function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function saveErrorMessage(e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e);
  return `Не удалось сохранить результаты. Они пока в памяти: не закрывай программу и повтори сохранение. Ошибка: ${detail}`;
}

function trialRow(blockId: string, step: StepOf<'reaction_block'>, tl: BlockTimeline, r: TrialResult): TrialRow {
  const onset = tl.onsets[r.idx] ?? null;
  return {
    id: uuidv4(),
    blockId,
    idx: r.idx,
    stimulusJson: JSON.stringify(step.specs[r.idx] ?? null),
    responseJson: JSON.stringify({
      key: r.key,
      rtMs: r.rtMs,
      errorMs: r.errorMs,
      outcome: r.outcome,
      practice: r.practice,
      kind: r.kind,
    }),
    onsetTs: onset,
    responseTs: onset !== null && r.rtMs !== null ? onset + r.rtMs : null,
    rtMs: r.rtMs,
    outcome: r.outcome,
    frameDropped: r.frameDropped,
  };
}

/** Answers paired with the block's items; they must match one to one, in order. */
function pairAnswers(
  items: readonly SeriesItem[],
  answers: readonly SeriesAnswer[],
): Array<{ item: SeriesItem; answer: SeriesAnswer }> {
  if (answers.length !== items.length) {
    throw new RangeError(`submitNumSeries: ${String(answers.length)} answers for ${String(items.length)} items`);
  }
  return items.map((item, i) => {
    const answer = answers[i];
    if (answer?.itemId !== item.id) throw new RangeError(`submitNumSeries: answer ${String(i)} is not for item ${item.id}`);
    return { item, answer };
  });
}

/**
 * Runs one session plan step by step (instruction → blocks → summary → … → wellbeing → done) and stores
 * every block as soon as it ends. The UI renders `step` and calls back; it never touches levels or the repository.
 *
 * - Levels: a segment starts at startLevel(L_saved, days since last training) (diagnostics: fixedL) and moves
 *   by nextLevel after every block. Diagnostics never change levels, module states or ratings.
 * - After each block: addBlock (with its trials / logic items), then for training and free sessions the module
 *   state re-derived from history and, for number series, the ratings. Writes are tried 3 times (pauses
 *   100 and 500 ms); then `save_error` keeps everything in memory until `retrySave` succeeds.
 * - A new block starts only while the segment budget (from the first instruction ack) is not used up;
 *   diagnostic segments (budgetMs 0) have a fixed volume instead.
 * - An instruction comes before the first block of a segment and again whenever its text changes
 *   (every Gorbov run, СЗМР / Go/No-Go / Шульте rule changes as the level moves).
 */
export class SessionController {
  readonly sessionId = uuidv4();

  private readonly repo: Repository;
  private readonly plan: SessionPlan;
  private readonly layout: LayoutId;
  private readonly now: () => Date;
  private readonly scale: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Training and free sessions move levels; diagnostics do not. */
  private readonly counted: boolean;
  /** Module states as of session start (L_saved, last training, lifetime blocks). */
  private readonly states: Record<ModuleId, ModuleState>;
  private ratings: Map<FamilyId, Rating>;

  /** Replaced before start() resolves. */
  private current: Step = { kind: 'wellbeing' };
  private seg: SegmentRun | null = null;
  /** The block the instruction on screen introduces. */
  private next: BlockPlan | null = null;
  private active: ActiveBlock | null = null;
  private pending: PendingSave | null = null;
  private busy = false;

  private readonly sessionBlocks: SessionBlock[] = [];
  /** Current level of modules played in this session (a module that comes back continues from here). */
  private readonly levels = new Map<ModuleId, number>();
  private readonly fatigueDetected = new Set<ModuleId>();
  private readonly fatiguePrompted = new Set<ModuleId>();
  private readonly fatigueContinued = new Set<ModuleId>();
  private readonly discardLog: Array<{ module: ModuleId; reason: DiscardReason }> = [];

  private readonly diag: Omit<DiagnosticResults, 'gorbov'> = {
    pzmrMedianRt: null,
    szmrMedianRt: null,
    gonogoScore: null,
    rdoMeanAbsErrorMs: null,
    numseriesCorrect: null,
  };
  /** Diagnostic Gorbov run times in seconds by run index; null = not finished in time. */
  private readonly gorbovSeconds: Array<number | null> = [];

  private constructor(
    o: SessionStartOptions,
    scale: number,
    states: Record<ModuleId, ModuleState>,
    ratings: Map<FamilyId, Rating>,
  ) {
    this.repo = o.repo;
    this.plan = o.plan;
    this.layout = o.layout;
    this.now = o.now;
    this.scale = scale;
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.counted = o.plan.kind !== 'diagnostic';
    this.states = states;
    this.ratings = ratings;
  }

  /** Creates the session row and shows the first instruction (or `save_error` if the row cannot be written). */
  static async start(o: SessionStartOptions): Promise<SessionController> {
    const scale = o.scale ?? 1;
    if (!(Number.isFinite(scale) && scale > 0)) throw new RangeError(`scale must be a positive number, got ${String(scale)}`);
    if (o.plan.kind === 'diagnostic' && o.plan.diagnosticNumber === undefined) {
      throw new RangeError('a diagnostic plan needs diagnosticNumber');
    }
    const [states, ratings] = await Promise.all([o.repo.getModuleStates(), o.repo.getRatings()]);
    const c = new SessionController(o, scale, states, ratings);
    const row: SessionRow = {
      id: c.sessionId,
      startedAt: o.now().toISOString(),
      endedAt: null,
      kind: o.plan.kind,
      phase: PHASE,
      appVersion: o.appVersion,
    };
    await c.save([() => o.repo.createSession(row)], () => c.enterSegment(0));
    return c;
  }

  get step(): Step {
    return this.current;
  }

  /** Blocks thrown away in this session (focus loss, runner errors), oldest first. */
  get discards(): ReadonlyArray<{ module: ModuleId; reason: DiscardReason }> {
    return [...this.discardLog];
  }

  ackInstruction(): void {
    const step = this.take('instruction');
    const seg = this.segment();
    if (this.next === null) throw new Error('SessionController: instruction without a block');
    seg.clockStart ??= this.now().getTime();
    seg.lastInstruction = step.text + '\n' + step.keysHint;
    this.startBlock(this.next);
  }

  async submitReaction(tl: BlockTimeline): Promise<void> {
    const step = this.take('reaction_block');
    await this.exclusive(async () => {
      const { module, L } = step;
      const results = resolveBlock(step.specs, tl);
      const summary = summarize(results);
      if (summary.n === 0) {
        // Nothing scored (cannot happen with real blocks): no write, play it again.
        this.restartBlock(module, 'error');
        return;
      }
      const calibration = this.isCalibration(module);
      const lAfter = this.counted
        ? nextLevel(L, {
            score: summary.score,
            calibration,
            prevScoreSameSession: this.prevScore(module),
            cvRt: summary.cvRt,
            cvMax: reactionModules[module].cvMax(L),
            timingUnreliable: summary.timingUnreliable,
          })
        : L;
      const flags = this.flagsFor(module, calibration, summary.timingUnreliable);
      const hitRts = results.flatMap((r) =>
        !r.practice && r.kind === 'press' && r.outcome === 'hit' && r.rtMs !== null ? [r.rtMs] : [],
      );
      const active = this.block();
      this.record({ module, score: summary.score, flags, hitRts }, lAfter);
      if (!this.counted) this.collectDiagnostic(module, summary);

      const row = this.blockRow(uuidv4(), module, L, lAfter, summary.score, flags, active, JSON.stringify(summary));
      const trials = results.map((r) => trialRow(row.id, step, tl, r));
      const view = this.view(module, L, lAfter, summary.score, flags, reactionLines(module, summary));
      await this.persist(row, trials, [], view, null);
    });
  }

  async submitTable(run: TableRun): Promise<void> {
    const step = this.take('table_block');
    if (run.task !== step.task) throw new RangeError(`submitTable: run task ${run.task}, block task ${step.task}`);
    if (run.timeLimitMs !== step.params.timeLimitMs) {
      throw new RangeError(
        `submitTable: run time limit ${String(run.timeLimitMs)} ms, block time limit ${String(step.params.timeLimitMs)} ms`,
      );
    }
    await this.exclusive(async () => {
      const { module, L } = step;
      const result = scoreTableRun(run);
      const calibration = this.isCalibration(module);
      const lAfter = this.counted
        ? nextLevel(L, {
            score: result.score,
            calibration,
            prevScoreSameSession: this.prevScore(module),
            cvRt: null,
            cvMax: null,
            timingUnreliable: false,
          })
        : L;
      const flags = this.flagsFor(module, calibration, false);
      const active = this.block();
      if (!this.counted && module === 'gorbov') {
        this.gorbovSeconds[this.segment().blocksDone] = result.timeMs === null ? null : result.timeMs / 1000;
      }
      this.record({ module, score: result.score, flags, hitRts: [] }, lAfter);

      const summaryJson = JSON.stringify({ ...result, task: run.task, startTs: run.startTs, clicks: run.clicks });
      const row = this.blockRow(uuidv4(), module, L, lAfter, result.score, flags, active, summaryJson);
      const view = this.view(module, L, lAfter, result.score, flags, tableLines(result), step.task);
      await this.persist(row, [], [], view, null);
    });
  }

  async submitNumSeries(answers: readonly SeriesAnswer[]): Promise<void> {
    const step = this.take('numseries_block');
    const pairs = pairAnswers(step.items, answers);
    await this.exclusive(async () => {
      const active = this.block();
      const blockId = uuidv4();
      const at = this.now().toISOString();
      const ratings = new Map(this.ratings);
      const items: LogicItemRow[] = [];
      let elapsed = 0;
      let successes = 0;
      for (const { item, answer } of pairs) {
        const correct = answer.given === item.answer;
        elapsed += answer.timeMs;
        const inTime =
          (step.perItemLimitMs === null || answer.timeMs <= step.perItemLimitMs) &&
          (step.totalLimitMs === null || elapsed <= step.totalLimitMs);
        const success = correct && inTime;
        if (success) successes++;
        if (this.counted) {
          ratings.set(item.family, updateRating(ratings.get(item.family) ?? { rating: R0, n: 0 }, item.difficulty, success));
        }
        items.push({
          id: uuidv4(),
          blockId,
          family: item.family,
          seed: item.seed,
          difficulty: item.difficulty,
          answer: item.answer,
          given: answer.given,
          correct,
          timeMs: answer.timeMs,
          at,
        });
      }
      const score = successes / pairs.length;
      this.record({ module: 'numseries', score, flags: [], hitRts: [] }, 0);
      if (this.counted) this.ratings = ratings;
      else this.diag.numseriesCorrect = successes;

      const summaryJson = JSON.stringify({
        correct: successes,
        total: pairs.length,
        items: pairs.map(({ item, answer }) => ({ itemId: item.id, answer: item.answer, given: answer.given, timeMs: answer.timeMs })),
      });
      const row = this.blockRow(blockId, 'numseries', 0, 0, score, [], active, summaryJson);
      const meanTime = mean(pairs.map((p) => p.answer.timeMs));
      const view = this.view('numseries', 0, 0, score, [], seriesLines(successes, pairs.length, meanTime));
      await this.persist(row, [], items, view, this.counted ? ratings : null);
    });
  }

  /** Throws the block on screen away: nothing is written, the level stays, a fresh block of the module follows. */
  discardBlock(reason: DiscardReason): void {
    if (this.busy) throw new Error('SessionController: another action is in progress');
    const s = this.current;
    if (s.kind !== 'reaction_block' && s.kind !== 'table_block' && s.kind !== 'numseries_block') {
      throw new Error(`SessionController: expected a block step, current step is ${s.kind}`);
    }
    this.restartBlock(s.kind === 'numseries_block' ? 'numseries' : s.module, reason);
  }

  async continueAfterSummary(): Promise<void> {
    this.take('summary');
    await this.exclusive(async () => {
      const seg = this.segment();
      if (!this.anotherBlock(seg)) {
        await this.enterSegment(seg.index + 1);
        return;
      }
      const module = seg.segment.module;
      if (this.fatigueDetected.has(module) && !this.fatiguePrompted.has(module)) {
        this.fatiguePrompted.add(module);
        this.current = { kind: 'fatigue_prompt', module };
        return;
      }
      this.presentNext();
    });
  }

  /** stop: skip the rest of the segment; otherwise keep going with later blocks of the module flagged `fatigued`. */
  async answerFatigue(stop: boolean): Promise<void> {
    const step = this.take('fatigue_prompt');
    await this.exclusive(async () => {
      if (stop) {
        await this.enterSegment(this.segment().index + 1);
        return;
      }
      this.fatigueContinued.add(step.module);
      this.presentNext();
    });
  }

  /** Repeats the writes that have not succeeded yet (3 attempts again). */
  async retrySave(): Promise<void> {
    this.take('save_error');
    await this.exclusive(() => this.flush());
  }

  async submitWellbeing(w: Omit<WellbeingRow, 'id' | 'date'> | null): Promise<void> {
    this.take('wellbeing');
    await this.exclusive(async () => {
      const writes: Array<() => Promise<void>> = [];
      if (w !== null) {
        const row: WellbeingRow = {
          id: uuidv4(),
          date: localDate(this.now()),
          sleepH: w.sleepH,
          caffeine: w.caffeine,
          mood: w.mood,
        };
        writes.push(() => this.repo.addWellbeing(row));
      }
      writes.push(this.finishWrite());
      await this.save(writes, () => {
        this.done(null);
      });
    });
  }

  // ---------- flow ----------

  private async enterSegment(index: number): Promise<void> {
    this.next = null;
    this.active = null;
    const segment = this.plan.segments[index];
    if (segment === undefined) {
      this.seg = null;
      await this.finish();
      return;
    }
    this.seg = {
      index,
      segment,
      L: this.segmentLevel(segment),
      clockStart: null,
      blocksDone: 0,
      attempt: 0,
      lastInstruction: null,
    };
    this.presentNext();
  }

  private segmentLevel(segment: Segment): number {
    const { module } = segment;
    if (!this.counted) return segment.fixedL ?? 0;
    if (module === 'numseries') return 0;
    const current = this.levels.get(module);
    if (current !== undefined) return current;
    const st = this.states[module];
    const today = this.now().toISOString();
    return startLevel(st.lSaved, daysBetween(st.lastTrainedAt ?? today, today));
  }

  /** Instruction first if the segment just started, for every Gorbov run, or when the rules changed. */
  private presentNext(): void {
    const seg = this.segment();
    const plan = this.planBlock(seg);
    const { text, keysHint } = this.instructionFor(plan);
    if (seg.segment.module === 'gorbov' || text + '\n' + keysHint !== seg.lastInstruction) {
      this.next = plan;
      this.current = { kind: 'instruction', module: seg.segment.module, text, keysHint };
    } else {
      this.startBlock(plan);
    }
  }

  /** Training/free: a block may start while the budget lasts; diagnostics: fixed number of blocks / runs. */
  private anotherBlock(seg: SegmentRun): boolean {
    const { segment } = seg;
    if (segment.budgetMs === 0) return seg.blocksDone < (isTable(segment.module) ? (segment.runs ?? 1) : 1);
    const nowMs = this.now().getTime();
    return nowMs - (seg.clockStart ?? nowMs) < segment.budgetMs * this.scale;
  }

  private async finish(): Promise<void> {
    if (this.plan.kind === 'training') {
      this.current = { kind: 'wellbeing' };
      return;
    }
    const writes: Array<() => Promise<void>> = [];
    let diagnostic: DiagnosticResults | null = null;
    if (this.plan.kind === 'diagnostic') {
      const results = this.diagnosticResults();
      diagnostic = results;
      const row = {
        id: uuidv4(),
        sessionId: this.sessionId,
        number: this.diagnosticNumber(),
        at: this.now().toISOString(),
        resultsJson: JSON.stringify(results),
      };
      writes.push(() => this.repo.addDiagnostic(row));
    }
    writes.push(this.finishWrite());
    await this.save(writes, () => {
      this.done(diagnostic);
    });
  }

  private finishWrite(): () => Promise<void> {
    const endedAt = this.now().toISOString();
    return () => this.repo.finishSession(this.sessionId, endedAt);
  }

  private done(diagnostic: DiagnosticResults | null): void {
    this.current = { kind: 'done', sessionId: this.sessionId, diagnostic };
  }

  // ---------- blocks ----------

  private planBlock(seg: SegmentRun): BlockPlan {
    const { module } = seg.segment;
    const L = seg.L;
    if (isReaction(module)) {
      const params = reactionModules[module].params(L);
      const { keys, effectiveLayout } = layoutKeys(this.layout, keyCount(module, params));
      return { kind: 'reaction', module, L, params, keys, layout: effectiveLayout };
    }
    if (module === 'gorbov') {
      const task = gorbovTaskForRun(seg.blocksDone);
      return { kind: 'table', module, L, task, params: gorbovParams(L, task) };
    }
    if (module === 'schulte') return { kind: 'table', module, L, task: 'schulte', params: schulteParams(L) };
    return { kind: 'numseries' };
  }

  private instructionFor(plan: BlockPlan): { text: string; keysHint: string } {
    switch (plan.kind) {
      case 'reaction':
        return {
          text: reactionModules[plan.module].instruction(this.layout, plan.params),
          keysHint: plan.keys.map(keyLabel).join(', '),
        };
      case 'table':
        return { text: tableInstruction(plan.task, plan.params.size), keysHint: TABLE_KEYS_HINT };
      case 'numseries':
        return {
          text: this.counted ? SERIES_INSTRUCTION_TRAINING : SERIES_INSTRUCTION_DIAGNOSTIC,
          keysHint: SERIES_KEYS_HINT,
        };
    }
  }

  private startBlock(plan: BlockPlan): void {
    const seg = this.segment();
    const seed = this.blockSeed(seg);
    const startedAt = this.now().toISOString();
    this.next = null;
    switch (plan.kind) {
      case 'reaction': {
        const mod = reactionModules[plan.module];
        const size = this.scaled(seg.segment.trialCount ?? mod.blockSize);
        const practiceCount = this.scaledPractice(seg.segment.practiceTrials ?? 0);
        const practice =
          practiceCount > 0
            ? mod
                .generateBlock(plan.params, createRng(deriveSeed(seed, 'practice')), this.layout, practiceCount)
                .map((t) => ({ ...t, practice: true }))
            : [];
        const specs = [...practice, ...mod.generateBlock(plan.params, createRng(seed), this.layout, size)];
        this.active = { plan, startedAt, paramsJson: JSON.stringify(plan.params) };
        this.current = { kind: 'reaction_block', module: plan.module, L: plan.L, specs, keys: plan.keys, layout: plan.layout };
        return;
      }
      case 'table': {
        const rng = createRng(seed);
        const cells = plan.module === 'gorbov' ? generateGorbovTable(rng) : generateSchulteTable(plan.params.size, rng);
        this.active = { plan, startedAt, paramsJson: JSON.stringify({ task: plan.task, ...plan.params }) };
        this.current = { kind: 'table_block', module: plan.module, L: plan.L, task: plan.task, cells, params: plan.params, seed };
        return;
      }
      case 'numseries': {
        const step = this.seriesStep(seed, seg.segment);
        this.active = {
          plan,
          startedAt,
          paramsJson: JSON.stringify({ items: step.items.length, perItemLimitMs: step.perItemLimitMs, totalLimitMs: step.totalLimitMs }),
        };
        this.current = step;
        return;
      }
    }
  }

  private seriesStep(seed: number, segment: Segment): StepOf<'numseries_block'> {
    if (!this.counted) {
      const schedule = diagnosticSeriesSchedule();
      const items = schedule
        .slice(0, this.scaled(segment.items ?? schedule.length))
        .map((e, i) => generateItem(e.family, e.targetD, deriveSeed(seed, 'item:' + String(i))));
      return { kind: 'numseries_block', items, perItemLimitMs: null, totalLimitMs: segment.totalTimeLimitMs ?? null };
    }
    const ratings = new Map([...this.ratings].map(([family, r]) => [family, r.rating]));
    const items = generateBlockItems(ratings, this.scaled(SERIES_BLOCK_ITEMS), createRng(seed));
    return { kind: 'numseries_block', items, perItemLimitMs: ITEM_TIME_LIMIT_MS, totalLimitMs: null };
  }

  /**
   * Training/free: deriveSeed(plan.seed, `segment:block:attempt`). Diagnostics: the segment seed for the
   * first block (runs 1, 2: derived from it), so diagnostic n always gets the same blocks; a discarded block
   * gets a derived seed.
   */
  private blockSeed(seg: SegmentRun): number {
    if (this.counted) {
      return deriveSeed(this.plan.seed, `${String(seg.index)}:${String(seg.blocksDone)}:${String(seg.attempt)}`);
    }
    const segSeed = diagnosticSegmentSeed(this.diagnosticNumber(), seg.segment.module);
    const base = seg.blocksDone === 0 ? segSeed : deriveSeed(segSeed, 'run:' + String(seg.blocksDone));
    return seg.attempt === 0 ? base : deriveSeed(base, 'retry:' + String(seg.attempt));
  }

  /** Block size or item count under the e2e scale: max(3, round(n·scale)). */
  private scaled(n: number): number {
    return Math.max(MIN_SCALED, Math.round(n * this.scale));
  }

  /** Practice trials stay as planned unless the e2e scale shrinks them: max(1, round(n·scale)). */
  private scaledPractice(n: number): number {
    return n > 0 && this.scale < 1 ? Math.max(1, Math.round(n * this.scale)) : n;
  }

  private restartBlock(module: ModuleId, reason: DiscardReason): void {
    const seg = this.segment();
    const { plan } = this.block();
    this.discardLog.push({ module, reason });
    seg.attempt++;
    this.startBlock(plan);
  }

  /** Book-keeping for a finished block; the level of the next block becomes lAfter. */
  private record(b: SessionBlock, lAfter: number): void {
    const seg = this.segment();
    this.sessionBlocks.push(b);
    seg.L = lAfter;
    seg.blocksDone++;
    seg.attempt = 0;
    this.active = null;
    if (b.module !== 'numseries') this.levels.set(b.module, lAfter);
    if (this.counted && isReaction(b.module)) {
      const clean = this.sessionBlocks.filter(
        (x) => x.module === b.module && !x.flags.includes('fatigued') && !x.flags.includes('timing_unreliable'),
      );
      if (detectFatigue(clean)) this.fatigueDetected.add(b.module);
    }
  }

  private isCalibration(module: ModuleId): boolean {
    if (!this.counted) return false;
    const thisSession = this.sessionBlocks.filter((b) => b.module === module).length;
    return this.states[module].lifetimeBlocks + thisSession < CALIBRATION_BLOCKS;
  }

  /** s of the previous block of the module in this session that was not timing_unreliable. */
  private prevScore(module: ModuleId): number | null {
    for (let i = this.sessionBlocks.length - 1; i >= 0; i--) {
      const b = this.sessionBlocks[i];
      if (b?.module === module && !b.flags.includes('timing_unreliable')) return b.score;
    }
    return null;
  }

  private flagsFor(module: ModuleId, calibration: boolean, timingUnreliable: boolean): BlockFlag[] {
    const flags: BlockFlag[] = [];
    if (calibration) flags.push('calibration');
    if (timingUnreliable) flags.push('timing_unreliable');
    if (this.fatigueContinued.has(module)) flags.push('fatigued');
    return flags;
  }

  private collectDiagnostic(module: ReactionModuleId, s: ReactionSummary): void {
    switch (module) {
      case 'pzmr':
        this.diag.pzmrMedianRt = s.medianRt;
        break;
      case 'szmr':
        this.diag.szmrMedianRt = s.medianRt;
        break;
      case 'gonogo':
        this.diag.gonogoScore = s.score * 100; // percent (Ruling R18)
        break;
      case 'rdo':
        this.diag.rdoMeanAbsErrorMs = s.meanAbsErrorMs;
        break;
    }
  }

  private diagnosticResults(): DiagnosticResults {
    const [t1, t2, t3] = this.gorbovSeconds;
    const finished = (t: number | null | undefined): t is number => typeof t === 'number';
    const gorbov = finished(t1) && finished(t2) && finished(t3) ? gorbovMetrics(t1, t2, t3) : null;
    return {
      pzmrMedianRt: this.diag.pzmrMedianRt,
      szmrMedianRt: this.diag.szmrMedianRt,
      gonogoScore: this.diag.gonogoScore,
      rdoMeanAbsErrorMs: this.diag.rdoMeanAbsErrorMs,
      gorbov,
      numseriesCorrect: this.diag.numseriesCorrect,
    };
  }

  private blockRow(
    id: string,
    module: ModuleId,
    lBefore: number,
    lAfter: number,
    score: number,
    flags: BlockFlag[],
    active: ActiveBlock,
    summaryJson: string,
  ): BlockRow {
    return {
      id,
      sessionId: this.sessionId,
      module,
      lBefore,
      lAfter,
      paramsJson: active.paramsJson,
      score,
      flags,
      startedAt: active.startedAt,
      summaryJson,
    };
  }

  private view(
    module: ModuleId,
    lBefore: number,
    lAfter: number,
    score: number,
    flags: BlockFlag[],
    lines: string[],
    task?: TableTaskId,
  ): BlockSummaryView {
    return {
      module,
      title: moduleTitles[module],
      lBefore,
      lAfter,
      changes: describeChanges(module, lBefore, lAfter, task),
      score,
      lines,
      flags,
    };
  }

  // ---------- persistence ----------

  /** addBlock, then (training/free) the module state from history and the ratings; then the summary. */
  private async persist(
    row: BlockRow,
    trials: readonly TrialRow[],
    items: readonly LogicItemRow[],
    view: BlockSummaryView,
    ratings: ReadonlyMap<FamilyId, Rating> | null,
  ): Promise<void> {
    const writes: Array<() => Promise<void>> = [() => this.repo.addBlock(row, trials, items)];
    if (this.counted) {
      writes.push(async () => {
        const states = deriveModuleStates(await this.repo.listSessions(), await this.repo.listBlocks());
        await this.repo.saveModuleState(states[row.module]);
      });
      if (ratings !== null) writes.push(() => this.repo.saveRatings(ratings));
    }
    await this.save(writes, () => {
      this.current = { kind: 'summary', view };
    });
  }

  private async save(writes: ReadonlyArray<() => Promise<void>>, onSaved: () => void | Promise<void>): Promise<void> {
    this.pending = { writes: writes.map((run) => ({ run, done: false })), onSaved };
    await this.flush();
  }

  /** Up to 3 attempts at the writes not done yet; success → onSaved, failure → `save_error`. */
  private async flush(): Promise<void> {
    const pending = this.pending;
    if (pending === null) throw new Error('SessionController: nothing to save');
    let error: unknown = null;
    for (let attempt = 0; attempt <= SAVE_RETRY_DELAYS_MS.length; attempt++) {
      const delay = SAVE_RETRY_DELAYS_MS[attempt - 1];
      if (delay !== undefined) await this.sleep(delay);
      try {
        for (const w of pending.writes) {
          if (w.done) continue;
          await w.run();
          w.done = true;
        }
      } catch (e) {
        error = e;
        continue;
      }
      this.pending = null;
      await pending.onSaved();
      return;
    }
    this.current = { kind: 'save_error', message: saveErrorMessage(error) };
  }

  // ---------- guards ----------

  /** The current step if it is `kind` and nothing else is running; throws otherwise (a UI bug). */
  private take<K extends Step['kind']>(kind: K): StepOf<K> {
    if (this.busy) throw new Error('SessionController: another action is in progress');
    const s = this.current;
    if (s.kind !== kind) throw new Error(`SessionController: expected step ${kind}, current step is ${s.kind}`);
    return s as StepOf<K>;
  }

  private async exclusive(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await fn();
    } finally {
      this.busy = false;
    }
  }

  private segment(): SegmentRun {
    if (this.seg === null) throw new Error('SessionController: no segment is running');
    return this.seg;
  }

  private block(): ActiveBlock {
    if (this.active === null) throw new Error('SessionController: no block is running');
    return this.active;
  }

  private diagnosticNumber(): number {
    const n = this.plan.diagnosticNumber;
    if (n === undefined) throw new Error('SessionController: diagnostic plan without diagnosticNumber');
    return n;
  }
}
