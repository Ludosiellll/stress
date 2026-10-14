import { v4 as uuidv4 } from 'uuid';
import type { Repository } from '../data/repository';
import type { LogicItemRow, TrialRow, WellbeingRow } from '../data/rows';
import { detectFatigue, nextLevel, startLevel } from '../engine/adaptive';
import { daysBetween } from '../engine/dates';
import { deriveModuleStates } from '../engine/derive';
import type { DiagnosticResults } from '../engine/diagnostic';
import type { Rating } from '../engine/elo';
import type { ModuleState, Segment, SessionPlan } from '../engine/planner';
import type { BlockTimeline } from '../engine/reaction/types';
import type { BlockFlag, FamilyId, LayoutId, ModuleId } from '../engine/types';
import { describeChanges } from '../modules/describe';
import { moduleTitles, reactionModules } from '../modules/registry';
import type { TableTaskId } from '../modules/tables/gorbov';
import { scoreTableRun, type TableRun } from '../modules/tables/score';
import {
  blockInstruction,
  buildBlock,
  diagnosticBlockSeed,
  diagnosticResults,
  isReaction,
  planBlock,
  scoreReaction,
  scoreSeries,
  trainingBlockSeed,
  updatedRatings,
  type BlockPlan,
  type DiagnosticPart,
  type PlanContext,
} from './blocks';
import { blockRow, errorLogRow, logicItemRows, sessionRow, trialRows, wellbeingRow } from './rowsBuild';
import { SaveQueue, type SaveOutcome, type Write } from './saveQueue';
import {
  reactionLines,
  saveErrorMessage,
  seriesLines,
  stabilityLine,
  tableLines,
  UNRELIABLE_REPLAY_NOTICE,
  type SaveErrorWhat,
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
  /** e2e only (Task 15): budgets and the series total limit × scale, block sizes and item counts max(3, round(n·scale)). */
  scale?: number;
  /** Pause between save attempts; tests inject an instant one. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * focus_lost: the window lost focus; error: a runner or drawing failure; user: the user paused (Escape);
 * timing_unreliable: a diagnostic reaction block with too many dropped frames, replayed once (I1).
 */
export type DiscardReason = 'focus_lost' | 'error' | 'user' | 'timing_unreliable';

/** First 3 blocks of a module ever are calibration blocks (g = 2). */
const CALIBRATION_BLOCKS = 3;

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
  /** Diagnostics: the current block was already replayed once for timingUnreliable (I1). */
  unreliableReplayed: boolean;
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

/** What a submitted block brings to completeBlock. */
interface FinishedBlock {
  module: ModuleId;
  L: number;
  score: number;
  /** Staircase inputs; null for number series (no level). */
  level: { cvRt: number | null; cvMax: number | null; timingUnreliable: boolean } | null;
  hitRts: number[];
  summaryJson: string;
  lines: string[];
  task?: TableTaskId;
  rows: (blockId: string) => { trials: TrialRow[]; items: LogicItemRow[] };
  /** In-memory effects beyond the level (diagnostic metrics, ratings), applied once the block is stored. */
  onCommit?: () => void;
  /** Cache writes after the module state (ratings). */
  extraWrites?: Write[];
}

/** What follows the writes on screen: success, or giving up on them (null: cannot be skipped). */
interface SaveContext {
  what: string;
  /** What `save_error` reports as pending, asked when the writes fail. */
  stage: () => SaveErrorWhat;
  onSaved: () => void | Promise<void>;
  onAbandon: (() => void | Promise<void>) | null;
  error: unknown;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Runs one session plan step by step (instruction → blocks → summary → … → wellbeing → done) and stores
 * every block as soon as it ends. The UI renders `step` and calls back; it never touches levels or the repository.
 *
 * - Levels: a segment starts at startLevel(L_saved, days since last training) (diagnostics: fixedL) and moves
 *   by nextLevel after every block. Diagnostics never change levels, module states or ratings.
 * - After each block: addBlock (with its trials / logic items); then the block's in-memory effects; then for
 *   training and free sessions the module state derived from the module's history (listBlockLevels) and, for
 *   number series, the ratings. Writes are tried 3 times (pauses 100 and 500 ms), then `save_error` keeps
 *   everything in memory until `retrySave` succeeds or `abandonPending` gives up on it.
 * - Training and free segments start a new block only while the budget (from the first instruction ack) is
 *   not used up; diagnostic segments play a fixed number of blocks (`runs`, default 1).
 * - An instruction comes before the first block of a segment, before every Gorbov run, and again whenever
 *   its text or keys change (СЗМР / Go/No-Go / Шульте rules move with the level).
 */
export class SessionController {
  readonly sessionId = uuidv4();

  private readonly repo: Repository;
  private readonly plan: SessionPlan;
  private readonly layout: LayoutId;
  private readonly now: () => Date;
  private readonly scale: number;
  private readonly queue: SaveQueue;
  /** Training and free sessions move levels; diagnostics do not (the one "is diagnostic" predicate). */
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
  private saving: SaveContext | null = null;
  private busy = false;

  private readonly sessionBlocks: SessionBlock[] = [];
  /** Current level of modules played in this session (a module that comes back continues from here). */
  private readonly levels = new Map<ModuleId, number>();
  private readonly fatigueDetected = new Set<ModuleId>();
  private readonly fatiguePrompted = new Set<ModuleId>();
  private readonly fatigueContinued = new Set<ModuleId>();
  private readonly discardLog: Array<{ module: ModuleId; reason: DiscardReason }> = [];

  /** What the stored diagnostic blocks add to DiagnosticResults. */
  private readonly diagParts: DiagnosticPart[] = [];

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
    this.queue = new SaveQueue(o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));
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
    const row = sessionRow(c.sessionId, o.now().toISOString(), o.plan.kind, o.appVersion);
    await c.save(
      { what: 'session start', stage: () => 'session_start', onSaved: () => c.enterSegment(0), onAbandon: null },
      [{ label: 'createSession', run: () => o.repo.createSession(row) }],
    );
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
      const scored = scoreReaction(step.specs, tl);
      if (scored === null) {
        // Nothing scored (cannot happen with real blocks): no write, play it again.
        this.restartBlock(module, 'error');
        return;
      }
      const { results, summary, hitRts } = scored;
      const seg = this.segment();
      if (!this.counted && summary.timingUnreliable && !seg.unreliableReplayed) {
        // A diagnostic value from a block with dropped frames is replayed once; a second one is kept and marked.
        seg.unreliableReplayed = true;
        this.restartBlock(module, 'timing_unreliable', { kind: 'notice', module, text: UNRELIABLE_REPLAY_NOTICE });
        return;
      }
      await this.completeBlock({
        module,
        L,
        score: summary.score,
        level: { cvRt: summary.cvRt, cvMax: reactionModules[module].cvMax(L), timingUnreliable: summary.timingUnreliable },
        hitRts,
        summaryJson: JSON.stringify(summary),
        lines: reactionLines(module, summary),
        rows: (blockId) => ({ trials: trialRows(blockId, step.specs, tl, results), items: [] }),
        onCommit: () => {
          if (!this.counted) this.diagParts.push({ module, summary });
        },
      });
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
      const { module } = step;
      const result = scoreTableRun(run);
      const runIndex = this.segment().blocksDone;
      await this.completeBlock({
        module,
        L: step.L,
        score: result.score,
        level: { cvRt: null, cvMax: null, timingUnreliable: false },
        hitRts: [],
        summaryJson: JSON.stringify({ ...result, task: run.task, startTs: run.startTs, clicks: run.clicks }),
        lines: tableLines(result),
        task: step.task,
        rows: () => ({ trials: [], items: [] }),
        onCommit: () => {
          if (!this.counted && module === 'gorbov') {
            this.diagParts.push({ module, run: runIndex, seconds: result.timeMs === null ? null : result.timeMs / 1000 });
          }
        },
      });
    });
  }

  async submitNumSeries(answers: readonly SeriesAnswer[]): Promise<void> {
    const step = this.take('numseries_block');
    const outcomes = scoreSeries(step, answers);
    await this.exclusive(async () => {
      const successes = outcomes.filter((o) => o.success).length;
      const total = outcomes.length;
      const ratings = this.counted ? updatedRatings(this.ratings, outcomes) : null;
      const at = this.now().toISOString();
      const meanTimeMs = outcomes.reduce((sum, o) => sum + o.answer.timeMs, 0) / total;
      await this.completeBlock({
        module: 'numseries',
        L: 0,
        score: successes / total,
        level: null,
        hitRts: [],
        summaryJson: JSON.stringify({
          correct: successes,
          total,
          items: outcomes.map((o) => ({ itemId: o.item.id, answer: o.item.answer, given: o.answer.given, timeMs: o.answer.timeMs })),
        }),
        lines: seriesLines(successes, total, meanTimeMs),
        rows: (blockId) => ({ trials: [], items: logicItemRows(blockId, outcomes, at) }),
        onCommit: () => {
          if (ratings !== null) this.ratings = ratings;
          else this.diagParts.push({ module: 'numseries', correct: successes, total });
        },
        extraWrites: ratings === null ? [] : [{ label: 'saveRatings', run: () => this.repo.saveRatings(ratings) }],
      });
    });
  }

  /** Starts the replay announced by the `notice` step. */
  ackNotice(): void {
    this.take('notice');
    this.startBlock(this.block().plan);
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
    await this.exclusive(() => this.advance());
  }

  /** stop: skip the rest of the segment; otherwise keep going (while the budget lasts) with later blocks `fatigued`. */
  async answerFatigue(stop: boolean): Promise<void> {
    const step = this.take('fatigue_prompt');
    await this.exclusive(async () => {
      const seg = this.segment();
      if (!stop) this.fatigueContinued.add(step.module);
      if (stop || !this.anotherBlock(seg)) {
        await this.enterSegment(seg.index + 1);
        return;
      }
      this.presentNext();
    });
  }

  /** Repeats the writes that have not succeeded yet (3 attempts again). */
  async retrySave(): Promise<void> {
    this.take('save_error');
    await this.exclusive(async () => {
      await this.settle(await this.queue.flush());
    });
  }

  /**
   * Gives up on the writes behind `save_error` and moves on (Ruling R27). A block that never reached the
   * database leaves no trace: the level stays, the next block or segment follows. If only the cache writes
   * failed, the stored block keeps its effect. The drop goes to the log when the log can be written.
   */
  async abandonPending(): Promise<void> {
    this.take('save_error');
    const ctx = this.saveContext();
    const { onAbandon } = ctx;
    if (onAbandon === null) throw new Error(`SessionController: the ${ctx.what} write cannot be skipped`);
    await this.exclusive(async () => {
      const dropped = this.queue.drop();
      this.saving = null;
      const detail = { sessionId: this.sessionId, dropped, error: errorText(ctx.error) };
      try {
        await this.repo.appendLog(errorLogRow(this.now().toISOString(), `session: unsaved ${ctx.what} skipped`, detail));
      } catch {
        // The database is failing already; the drop simply goes unlogged.
      }
      await onAbandon();
    });
  }

  async submitWellbeing(w: Omit<WellbeingRow, 'id' | 'date'> | null): Promise<void> {
    this.take('wellbeing');
    await this.exclusive(async () => {
      const writes: Write[] = [];
      if (w !== null) {
        const row = wellbeingRow(w, this.now());
        writes.push({ label: 'addWellbeing', run: () => this.repo.addWellbeing(row) });
      }
      writes.push(this.finishWrite());
      const done = (): void => {
        this.done(null);
      };
      await this.save({ what: 'session end', stage: () => 'session_end', onSaved: done, onAbandon: done }, writes);
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
      unreliableReplayed: false,
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

  /** After a block: the next block (fatigue prompt first, if due) or the next segment. */
  private async advance(): Promise<void> {
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
  }

  /** Instruction first if the segment just started, for every Gorbov run, or when the rules changed. */
  private presentNext(): void {
    const seg = this.segment();
    const ctx: PlanContext = { layout: this.layout, scale: this.scale, diagnostic: !this.counted };
    const plan = planBlock(seg.segment, seg.L, seg.blocksDone, ctx);
    const { text, keysHint } = blockInstruction(plan, this.layout);
    if (seg.segment.module === 'gorbov' || text + '\n' + keysHint !== seg.lastInstruction) {
      this.next = plan;
      this.current = { kind: 'instruction', module: seg.segment.module, text, keysHint };
    } else {
      this.startBlock(plan);
    }
  }

  /** Training/free: a block may start while the budget lasts. Diagnostics: a fixed number of blocks (runs, default 1). */
  private anotherBlock(seg: SegmentRun): boolean {
    const { segment } = seg;
    if (!this.counted) return seg.blocksDone < (segment.runs ?? 1);
    const nowMs = this.now().getTime();
    return nowMs - (seg.clockStart ?? nowMs) < segment.budgetMs * this.scale;
  }

  private async finish(): Promise<void> {
    if (this.plan.kind === 'training') {
      this.current = { kind: 'wellbeing' };
      return;
    }
    const writes: Write[] = [];
    let diagnostic: DiagnosticResults | null = null;
    if (!this.counted) {
      const results = diagnosticResults(this.diagParts);
      diagnostic = results;
      const row = {
        id: uuidv4(),
        sessionId: this.sessionId,
        number: this.diagnosticNumber(),
        at: this.now().toISOString(),
        resultsJson: JSON.stringify(results),
      };
      writes.push({ label: 'addDiagnostic', run: () => this.repo.addDiagnostic(row) });
    }
    writes.push(this.finishWrite());
    const done = (): void => {
      this.done(diagnostic);
    };
    await this.save({ what: 'session end', stage: () => 'session_end', onSaved: done, onAbandon: done }, writes);
  }

  private finishWrite(): Write {
    const endedAt = this.now().toISOString();
    return { label: 'finishSession', run: () => this.repo.finishSession(this.sessionId, endedAt) };
  }

  private done(diagnostic: DiagnosticResults | null): void {
    let seriesTotal: number | null = null;
    for (const p of this.diagParts) if (p.module === 'numseries') seriesTotal = p.total;
    this.current = { kind: 'done', sessionId: this.sessionId, diagnostic, seriesTotal };
  }

  // ---------- blocks ----------

  private startBlock(plan: BlockPlan): void {
    const seg = this.segment();
    const seed = this.counted
      ? trainingBlockSeed(this.plan.seed, seg.index, seg.blocksDone, seg.attempt)
      : diagnosticBlockSeed(this.plan.diagnosticSeedIndex ?? this.diagnosticNumber(), seg.segment.module, seg.blocksDone, seg.attempt);
    const { step, paramsJson } = buildBlock(plan, seed, this.layout, this.ratings);
    this.next = null;
    this.active = { plan, startedAt: this.now().toISOString(), paramsJson };
    this.current = step;
  }

  /** The block again from the next attempt's seed; with `notice`, that step comes first (ackNotice starts the block). */
  private restartBlock(module: ModuleId, reason: DiscardReason, notice?: StepOf<'notice'>): void {
    const { plan } = this.block();
    this.discardLog.push({ module, reason });
    this.segment().attempt++;
    if (notice === undefined) this.startBlock(plan);
    else this.current = notice;
  }

  /**
   * Level step, flags, rows and summary of a finished block, then its writes. The block's in-memory effects
   * (level, session history, fatigue, `onCommit`) apply right after addBlock succeeds.
   */
  private async completeBlock(b: FinishedBlock): Promise<void> {
    const seg = this.segment();
    const active = this.block();
    const calibration = b.level !== null && this.isCalibration(b.module);
    const lAfter =
      this.counted && b.level !== null
        ? nextLevel(b.L, { score: b.score, calibration, prevScoreSameSession: this.prevScore(b.module), ...b.level })
        : b.L;
    const lines = [...b.lines];
    const lv = b.level;
    if (this.counted && lv !== null && !lv.timingUnreliable && b.score > 0.8 && lv.cvMax !== null && lv.cvRt !== null && lv.cvRt > lv.cvMax) {
      // nextLevel held the level (stability rule): say so (I3).
      lines.push(stabilityLine(lv.cvRt, lv.cvMax));
    }
    const flags: BlockFlag[] = [];
    if (calibration) flags.push('calibration');
    if (b.level?.timingUnreliable === true) flags.push('timing_unreliable');
    if (this.fatigueContinued.has(b.module)) flags.push('fatigued');

    const id = uuidv4();
    const row = blockRow(id, this.sessionId, { module: b.module, lBefore: b.L, lAfter, score: b.score, flags }, active, b.summaryJson);
    const { trials, items } = b.rows(id);
    const view = {
      module: b.module,
      title: moduleTitles[b.module],
      lBefore: b.L,
      lAfter,
      changes: describeChanges(b.module, b.L, lAfter, b.task),
      score: b.score,
      lines,
      flags,
      showLevel: this.counted && b.level !== null,
    };

    let committed = false;
    const writes: Write[] = [
      { label: 'addBlock', run: () => this.repo.addBlock(row, trials, items) },
      {
        label: 'commit',
        run: () => {
          committed = true;
          this.record({ module: b.module, score: b.score, flags, hitRts: b.hitRts }, lAfter);
          b.onCommit?.();
          return Promise.resolve();
        },
      },
    ];
    if (this.counted) {
      writes.push({
        label: 'saveModuleState',
        run: async () => {
          const [sessions, blocks] = await Promise.all([this.repo.listSessions(), this.repo.listBlockLevels(b.module)]);
          await this.repo.saveModuleState(deriveModuleStates(sessions, blocks)[b.module]);
        },
      });
      writes.push(...(b.extraWrites ?? []));
    }
    await this.save(
      {
        what: `${b.module} block`,
        stage: () => (committed ? 'block_cache' : 'block'),
        onSaved: () => {
          this.current = { kind: 'summary', view };
        },
        onAbandon: () => {
          if (!committed) {
            seg.blocksDone++;
            seg.attempt = 0;
            this.active = null;
          }
          return this.advance();
        },
      },
      writes,
    );
  }

  /** Book-keeping for a stored block; the level of the next block becomes lAfter. */
  private record(b: SessionBlock, lAfter: number): void {
    const seg = this.segment();
    this.sessionBlocks.push(b);
    seg.L = lAfter;
    seg.blocksDone++;
    seg.attempt = 0;
    seg.unreliableReplayed = false;
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

  // ---------- persistence ----------

  private async save(ctx: Omit<SaveContext, 'error'>, writes: readonly Write[]): Promise<void> {
    this.saving = { ...ctx, error: null };
    await this.settle(await this.queue.save(writes));
  }

  /** Success → what follows the writes; failure → `save_error`. */
  private async settle(outcome: SaveOutcome): Promise<void> {
    const ctx = this.saveContext();
    if (outcome.ok) {
      this.saving = null;
      await ctx.onSaved();
      return;
    }
    ctx.error = outcome.error;
    this.current = {
      kind: 'save_error',
      message: saveErrorMessage(outcome.error),
      canAbandon: ctx.onAbandon !== null,
      what: ctx.stage(),
    };
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

  private saveContext(): SaveContext {
    if (this.saving === null) throw new Error('SessionController: no save is pending');
    return this.saving;
  }

  private diagnosticNumber(): number {
    const n = this.plan.diagnosticNumber;
    if (n === undefined) throw new Error('SessionController: diagnostic plan without diagnosticNumber');
    return n;
  }
}
