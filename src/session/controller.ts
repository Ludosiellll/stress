import { v4 as uuidv4 } from 'uuid';
import type { Repository } from '../data/repository';
import type { BlockRow, LogicItemRow, TrialRow, WellbeingRow } from '../data/rows';
import { detectFatigue, nextLevel, stabilityHold, startLevel, type DeltaInput } from '../engine/adaptive';
import { daysBetween, localDayIso } from '../engine/dates';
import { dayForm } from '../engine/dayForm';
import { deriveModuleStates, isCleanBlock, isCountedSession, movesLevel } from '../engine/derive';
import { parseResults, type DiagnosticResults } from '../engine/diagnostic';
import type { Rating } from '../engine/elo';
import { OVERLOAD_LEVEL_STEP, warmupLevel, type ModuleState, type Segment, type SessionPlan } from '../engine/planner';
import { stabilityOf } from '../engine/reaction/stability';
import type { BlockTimeline } from '../engine/reaction/types';
import { readinessOfLatest } from '../engine/readiness';
import { isReactionModule, type BlockFlag, type FamilyId, type LayoutId, type ModuleId } from '../engine/types';
import type { MemoryTrial } from '../modules/memory/generate';
import { memorySpan, scoreMemoryTrial, type MemoryAnswer } from '../modules/memory/score';
import { moduleTitles, reactionModules } from '../modules/registry';
import type { TableTaskId } from '../modules/tables/gorbov';
import { scoreTableRun, type TableRun } from '../modules/tables/score';
import { assessBlock, meanFamilyRating, type BlockAssessment } from './assessment';
import { appendBlock, type BlockHistory } from './blockHistory';
import {
  blockInstruction,
  buildBlock,
  checkMemoryAnswers,
  diagnosticBlockSeed,
  diagnosticResults,
  levelChanges,
  planBlock,
  scoreReaction,
  scoreSeries,
  trainingBlockSeed,
  updatedRatings,
  type BlockPlan,
  type DiagnosticPart,
  type PlanContext,
} from './blocks';
import { appendPast, pastBlocks, warmupDays, type PastBlocks } from './pastBlocks';
import { blockRow, errorLogRow, logicItemRows, sessionRow, trialRows, wellbeingRow } from './rowsBuild';
import { SaveQueue, type SaveOutcome, type Write } from './saveQueue';
import {
  AUDIO_NOT_PLAYED,
  conditionLines,
  dayFormLine,
  memoryLines,
  reactionLines,
  saveErrorMessage,
  seriesLines,
  spanLines,
  stabilityLine,
  tableLines,
  UNRELIABLE_REPLAY_NOTICE,
  WARMUP_LEVEL_NOTE,
  type BlockSummaryView,
  type DiagnosticComparison,
  type PastDiagnostic,
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
  /**
   * e2e only (Task 15): budgets and the series total limit × scale, block sizes and item counts max(3, round(n·scale))
   * (for the modules with trial conditions at least 12 and enough for MIN_COND_RTS + 2 trials per condition, W2-R30).
   */
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

/** The staircase inputs of a block beyond its score, calibration and the previous score (DeltaInput). */
type LevelInput = Pick<DeltaInput, 'cvAll' | 'lapses' | 'lapseLimit' | 'cvMax' | 'timingUnreliable'>;
/** Tables and memory: no RTs, so no stability rule. */
const NO_STABILITY_RULE: LevelInput = Object.freeze({ cvAll: null, lapses: 0, lapseLimit: 0, cvMax: null, timingUnreliable: false });

/** The block on screen. A discard rebuilds it from the same plan with the next attempt's seed. */
interface ActiveBlock {
  plan: BlockPlan;
  startedAt: string;
  paramsJson: string;
}

interface SegmentRun {
  index: number;
  segment: Segment;
  /** Segment level: the next block plays at it (a mix overload block above it, planBlock). */
  L: number;
  /**
   * The segment started at startLevel (the drop after the break): only then does its first block get the first-block
   * boost (F6, T-R36). A module that comes back later in the session starts from its level here, without a drop.
   */
  startDrop: boolean;
  /** Wall-clock ms of the first instruction ack; null before it. */
  clockStart: number | null;
  blocksDone: number;
  /**
   * A level-moving block of the segment is stored: the next one is not the first (F6). Overload and warm-up blocks do
   * not move the level, and a timing_unreliable one measured nothing (T-R35): none of them counts.
   */
  levelBlockStored: boolean;
  /** Discards of the current block. */
  attempt: number;
  /** Diagnostics: the current block was already replayed once for timingUnreliable (I1). */
  unreliableReplayed: boolean;
  /** Text and key hint of the last instruction shown in the segment. */
  lastInstruction: string | null;
}

/** What the start pass read: the block history in its two forms and the level-moving blocks per module. */
interface HistoryRead {
  history: BlockHistory;
  past: PastBlocks;
  levelBlocks: ReadonlyMap<ModuleId, number>;
}

/** RTs as summaryJson.cleanHitRts keeps them: 0.1 ms (Справочник F3). */
const tenthMs = (x: number): number => Math.round(10 * x) / 10;

/** A finished block of this session, for calibration, the g = 2 rule and fatigue. */
interface SessionBlock {
  module: ModuleId;
  /** The staircase score s (reaction blocks: with the error penalty, F1). */
  score: number;
  flags: BlockFlag[];
  /** RTs of `press` hits (FatigueBlock.hitRts). */
  hitRts: number[];
}

/** What a submitted block brings to completeBlock. */
interface FinishedBlock {
  module: ModuleId;
  L: number;
  /** s: the level step, fatigue, the g = 2 rule and `blocks.score` (reaction blocks: with the error penalty, F1). */
  score: number;
  /** «Успешно» of the summary when it is not s: the share of successes of a reaction block (Р4). Default: score. */
  viewScore?: number;
  /**
   * Staircase inputs; null for number series (no level). With a cvMax (the reaction modules except РДО), summaryJson gets
   * `stability` (Справочник F2) with what the rule did to the level step.
   */
  level: LevelInput | null;
  hitRts: number[];
  /** Stored as summaryJson. */
  summary: object;
  lines: string[];
  task?: TableTaskId;
  /** Number series in training and free sessions: meanFamilyRating after the block (the step by rating). */
  meanRating?: number;
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
 * The comparison of the done step: the previous diagnostic is the last earlier one by date (W2-R33), and its index is
 * what readinessOfLatest gave it after the ones before it.
 */
function compareWithPrevious(earlier: readonly PastDiagnostic[], readiness: number | null, number: number): DiagnosticComparison {
  const previous = earlier.at(-1) ?? null;
  const readinessPrevious =
    previous === null ? null : readinessOfLatest(earlier.slice(0, -1).map((e) => e.metrics), previous.metrics).overall;
  return { previous, readiness, readinessPrevious, earlierUnreadable: previous === null && number > 1 };
}

/**
 * Runs one session plan step by step (instruction → blocks → summary → … → wellbeing → done) and stores
 * every block as soon as it ends. The UI renders `step` and calls back; it never touches levels or the repository.
 *
 * - Levels: a segment starts at startLevel(L_saved, days since last training) (diagnostics: fixedL) and moves
 *   by nextLevel after every block; its first stored level-moving block gets g = 2 at s ≥ 0.9 (F6). Diagnostics
 *   never change levels, module states or ratings.
 * - Overload blocks (Segment.overload): a finisher starts at L_saved + 3 and moves only its own level; a mix
 *   overload block's lAfter goes to history only. Their flag keeps them out of L_saved, fatigue and g = 2 (an overload
 *   block is never a segment's first block).
 * - The warm-up (F5) plays every block at warmupLevel(L_saved) and moves no level; its flag keeps it out of L_saved,
 *   lastTrainedAt, fatigue, calibration and g = 2. Its summary says so and shows «Форма дня» from the warm-ups of the
 *   history read at start, those of this session and the block itself.
 * - After each block: addBlock (with its trials / logic items); then the block's in-memory effects; then for
 *   training and free sessions the module state derived from the module's history (listBlockLevels) and, for
 *   number series, the ratings. Writes are tried 3 times (pauses 100 and 500 ms), then `save_error` keeps
 *   everything in memory until `retrySave` succeeds or `abandonPending` gives up on it.
 * - Assessment (the «Оценка» of a block summary) and «Форма дня»: training and free sessions read the whole block
 *   history once at start (О11) and append each block once it is stored, so a dropped block never enters it.
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
  /**
   * A diagnostic: the stored ones before it, in listDiagnostics order (by `at`, W2-R33), for the readiness note
   * (W2-R31) and the comparison of the done step. null: they could not be read; the done step then says nothing
   * about deferred parts and compares with nothing.
   */
  private readonly earlierDiagnostics: PastDiagnostic[] | null;
  /**
   * Training and free sessions: the block history read at start, with every block of this session appended once it
   * is stored. null: a diagnostic, or the read failed (no history line then, О10).
   */
  private readonly history: BlockHistory | null;
  /** The same history as stored rows, for «Форма дня» (F5); null exactly when `history` is (Р18). */
  private readonly past: PastBlocks | null;
  /**
   * Level-moving blocks (movesLevel) of each module in the training and free sessions read at start, for calibration
   * (T-R38); null exactly when `history` is.
   */
  private readonly levelBlocks: ReadonlyMap<ModuleId, number> | null;

  private constructor(
    o: SessionStartOptions,
    scale: number,
    states: Record<ModuleId, ModuleState>,
    ratings: Map<FamilyId, Rating>,
    earlierDiagnostics: PastDiagnostic[] | null,
    read: HistoryRead | null,
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
    this.earlierDiagnostics = earlierDiagnostics;
    this.history = read?.history ?? null;
    this.past = read?.past ?? null;
    this.levelBlocks = read?.levelBlocks ?? null;
  }

  /** Creates the session row and shows the first instruction (or `save_error` if the row cannot be written). */
  static async start(o: SessionStartOptions): Promise<SessionController> {
    const scale = o.scale ?? 1;
    if (!(Number.isFinite(scale) && scale > 0)) throw new RangeError(`scale must be a positive number, got ${String(scale)}`);
    if (o.plan.kind === 'diagnostic' && o.plan.diagnosticNumber === undefined) {
      throw new RangeError('a diagnostic plan needs diagnosticNumber');
    }
    const diagnostic = o.plan.kind === 'diagnostic';
    const [states, ratings, earlier, read] = await Promise.all([
      o.repo.getModuleStates(),
      o.repo.getRatings(),
      diagnostic ? SessionController.readOrLog(o, 'earlier diagnostics', () => SessionController.earlierDiagnostics(o.repo)) : [],
      diagnostic ? null : SessionController.readOrLog(o, 'block history', () => SessionController.blockHistory(o.repo)),
    ]);
    const c = new SessionController(o, scale, states, ratings, earlier, read);
    const row = sessionRow(c.sessionId, o.now().toISOString(), o.plan.kind, o.appVersion, o.plan.phase ?? 'none');
    await c.save(
      { what: 'session start', stage: () => 'session_start', onSaved: () => c.enterSegment(0), onAbandon: null },
      [{ label: 'createSession', run: () => o.repo.createSession(row) }],
    );
    return c;
  }

  /**
   * A read at session start that must not stop the session: a failure is logged (when the log can be written) and
   * reads as null, so what depends on it is left out (the deferred-parts note, the history line).
   */
  private static async readOrLog<T>(o: SessionStartOptions, what: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (e) {
      try {
        await o.repo.appendLog(errorLogRow(o.now().toISOString(), `session: ${what} could not be read`, { error: errorText(e) }));
      } catch {
        // The database is failing already; the read failure simply goes unlogged.
      }
      return null;
    }
  }

  /** The stored diagnostics that parseResults reads, for the done step (deferred parts, comparison). */
  private static async earlierDiagnostics(repo: Repository): Promise<PastDiagnostic[]> {
    return (await repo.listDiagnostics()).flatMap((d) => {
      const metrics = parseResults(d);
      return metrics === null ? [] : [{ number: d.number, at: d.at, metrics }];
    });
  }

  /**
   * The whole block history, read once per training or free session (О11); state writes read only listBlockLevels.
   * One pass fills the assessment history and the past blocks, as the commit of a block does (T-R19), and counts the
   * level-moving blocks of each module (T-R38).
   */
  private static async blockHistory(repo: Repository): Promise<HistoryRead> {
    const [blocks, sessions] = await Promise.all([repo.listBlocks(), repo.listSessions()]);
    const past = pastBlocks([], sessions);
    const history: BlockHistory = new Map();
    const levelBlocks = new Map<ModuleId, number>();
    for (const row of blocks) {
      const kind = past.kinds.get(row.sessionId);
      if (kind === undefined) continue;
      appendBlock(history, row, kind);
      appendPast(past, row, kind);
      if (isCountedSession(kind) && movesLevel(row.flags)) levelBlocks.set(row.module, (levelBlocks.get(row.module) ?? 0) + 1);
    }
    return { history, past, levelBlocks };
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
      const { results, summary, hitRts, conditions } = scored;
      const { plan } = this.block();
      const seg = this.segment();
      if (!this.counted && summary.timingUnreliable && !seg.unreliableReplayed) {
        // A diagnostic value from a block with dropped frames is replayed once; a second one is kept and marked.
        seg.unreliableReplayed = true;
        this.restartBlock(module, 'timing_unreliable', { kind: 'notice', module, text: UNRELIABLE_REPLAY_NOTICE });
        return;
      }
      const stability = stabilityOf(step.specs, results);
      await this.completeBlock({
        module,
        L,
        score: summary.penalizedScore,
        viewScore: summary.score,
        level: {
          cvAll: stability.cvAll,
          lapses: stability.lapses,
          lapseLimit: stability.lapseLimit,
          cvMax: reactionModules[module].cvMax,
          timingUnreliable: summary.timingUnreliable,
        },
        hitRts,
        summary: {
          ...summary,
          cleanHitRts: hitRts.map(tenthMs),
          frameMs: tl.frameMs ?? null,
          conditions,
          ...(tl.audioPlayed === undefined ? {} : { audioPlayed: tl.audioPlayed }),
        },
        lines: [
          ...reactionLines(module, summary, stability),
          ...conditionLines(module, conditions, plan.kind === 'reaction' && plan.overload),
          ...(tl.audioPlayed === false ? [AUDIO_NOT_PLAYED] : []),
        ],
        rows: (blockId) => ({ trials: trialRows(blockId, step.specs, tl, results), items: [] }),
        onCommit: () => {
          if (!this.counted) this.diagParts.push({ module, summary, conditions });
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
        level: NO_STABILITY_RULE,
        hitRts: [],
        summary: { ...result, task: run.task, startTs: run.startTs, clicks: run.clicks },
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
      const limits = outcomes.flatMap((o) => (o.item.timeLimitMs === null ? [] : [o.item.timeLimitMs]));
      const shortestLimitMs = limits.length > 0 ? Math.min(...limits) : null;
      await this.completeBlock({
        module: 'numseries',
        L: 0,
        score: successes / total,
        level: null,
        hitRts: [],
        summary: {
          correct: successes,
          total,
          items: outcomes.map((o) => ({ itemId: o.item.id, answer: o.item.answer, given: o.answer.given, timeMs: o.answer.timeMs })),
        },
        lines: seriesLines(successes, total, meanTimeMs, shortestLimitMs),
        ...(ratings === null ? {} : { meanRating: meanFamilyRating(ratings) }),
        rows: (blockId) => ({ trials: [], items: logicItemRows(blockId, outcomes, at) }),
        onCommit: () => {
          if (ratings !== null) this.ratings = ratings;
          else this.diagParts.push({ module: 'numseries', correct: successes, total });
        },
        extraWrites: ratings === null ? [] : [{ label: 'saveRatings', run: () => this.repo.saveRatings(ratings) }],
      });
    });
  }

  /**
   * One answer per trial, in order; the span protocol (diagnostics) ends early when it stops (checkMemoryAnswers).
   * s = exact rows / rows answered: all the trials of a fixed block (W2-R9), the ones shown of the span protocol.
   * The level moves by nextLevel with no stability rule (no RTs). The summary keeps every answer; the span goes
   * to the diagnostic results.
   */
  async submitMemory(answers: readonly MemoryAnswer[]): Promise<void> {
    const step = this.take('memory_block');
    checkMemoryAnswers(step, answers);
    const { trials, params, mode, protocol } = step;
    await this.exclusive(async () => {
      const scored = answers.map((a, i) => scoreMemoryTrial(trials[i] as MemoryTrial, a));
      const exact = scored.filter((r) => r.exact).length;
      const n = answers.length;
      const span = protocol === 'span' ? memorySpan(trials, answers) : null;
      const positionsCorrect = scored.reduce((sum, r) => sum + r.positionsCorrect, 0);
      await this.completeBlock({
        module: 'memory',
        L: step.L,
        score: exact / n,
        level: NO_STABILITY_RULE,
        hitRts: [],
        summary: span === null ? { mode, length: params.length, exact, positionsCorrect, answers } : { protocol, mode, exact, span, answers },
        lines: span === null ? memoryLines(exact, n, positionsCorrect, params.length) : spanLines(exact, n, span),
        rows: () => ({ trials: [], items: [] }),
        onCommit: () => {
          if (!this.counted && span !== null) this.diagParts.push({ module: 'memory', span });
        },
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
    switch (s.kind) {
      case 'reaction_block':
      case 'table_block':
        this.restartBlock(s.module, reason);
        return;
      case 'numseries_block':
        this.restartBlock('numseries', reason);
        return;
      case 'memory_block':
        this.restartBlock('memory', reason);
        return;
      default:
        throw new Error(`SessionController: expected a block step, current step is ${s.kind}`);
    }
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
    const { L, startDrop } = this.segmentLevel(segment);
    this.seg = {
      index,
      segment,
      L,
      startDrop,
      clockStart: null,
      blocksDone: 0,
      levelBlockStored: false,
      attempt: 0,
      unreliableReplayed: false,
      lastInstruction: null,
    };
    this.presentNext();
  }

  /** The level the segment starts at, and whether it is the start drop of startLevel (T-R36). */
  private segmentLevel(segment: Segment): { L: number; startDrop: boolean } {
    const { module } = segment;
    const at = (L: number): { L: number; startDrop: boolean } => ({ L, startDrop: false });
    if (!this.counted) return at(segment.fixedL ?? 0);
    if (module === 'numseries') return at(0);
    // The finisher takes a module that is not in the plan: no level in this session yet (§6.3).
    if (segment.overload === 'finisher') return at(this.states[module].lSaved + OVERLOAD_LEVEL_STEP);
    // The warm-up plays one fixed level and leaves the module's level in the session alone (F5).
    if (segment.purpose === 'warmup') return at(warmupLevel(this.states[module].lSaved));
    const current = this.levels.get(module);
    if (current !== undefined) return at(current);
    const st = this.states[module];
    const today = this.now().toISOString();
    return { L: startLevel(st.lSaved, daysBetween(st.lastTrainedAt ?? today, today)), startDrop: true };
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

  /** What planBlock needs to know about the session and the segment. */
  private planContext(seg: SegmentRun): PlanContext {
    return { layout: this.layout, scale: this.scale, diagnostic: !this.counted, planSeed: this.plan.seed, segmentIndex: seg.index };
  }

  /** Instruction first if the segment just started, for every Gorbov run, or when the rules changed. */
  private presentNext(): void {
    const seg = this.segment();
    const plan = planBlock(seg.segment, seg.L, seg.blocksDone, this.planContext(seg));
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
    const earlier = this.earlierDiagnostics;
    let indexDeferred = false;
    let comparison: DiagnosticComparison | null = null;
    if (diagnostic !== null && earlier !== null) {
      const latest = readinessOfLatest(earlier.map((e) => e.metrics), diagnostic);
      indexDeferred = latest.deferred;
      comparison = compareWithPrevious(earlier, latest.overall, this.diagnosticNumber());
    }
    this.current = { kind: 'done', sessionId: this.sessionId, diagnostic, seriesTotal, indexDeferred, comparison };
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
    const overload = active.plan.kind !== 'numseries' && active.plan.overload;
    // A training warm-up block (F5): lAfter = lBefore, no stability rule, no calibration and no g = 2 (T-R11).
    const warmup = this.counted && seg.segment.purpose === 'warmup';
    const calibration = b.level !== null && !warmup && this.isCalibration(b.module);
    const firstOfSegment = !overload && !warmup && seg.startDrop && !seg.levelBlockStored;
    const input: DeltaInput | null =
      this.counted && b.level !== null && !warmup
        ? { score: b.score, calibration, prevScoreSameSession: this.prevScore(b.module), firstOfSegment, ...b.level }
        : null;
    const lAfter = input === null ? b.L : nextLevel(b.L, input);
    const lines = [...b.lines];
    if (warmup) {
      // «Форма дня» right after the error line; left out when the history could not be read (Р18) or without a hit.
      const form = this.dayFormOf(active.startedAt, b.L, b.hitRts);
      if (form !== null) lines.splice(1, 0, form);
    }
    let summary = b.summary;
    if (b.level !== null && b.level.cvMax !== null) {
      // The stability rule (F2): what it saw and what it did to the step nextLevel took. A diagnostic moves no level.
      const { cvAll, lapses, lapseLimit, cvMax } = b.level;
      const hold = input === null ? null : stabilityHold(input);
      summary = { ...summary, stability: { cvAll, lapses, lapseLimit, cvMax, held: hold?.held ?? false, cap: hold?.cap ?? null } };
      // When it lowered the step, the line says so right after the error line (Р8).
      if (hold?.held === true) lines.splice(1, 0, stabilityLine({ cvAll, lapses, lapseLimit, cvMax, cap: hold.cap }));
    }
    const flags: BlockFlag[] = [];
    if (calibration) flags.push('calibration');
    if (b.level?.timingUnreliable === true) flags.push('timing_unreliable');
    if (this.fatigueContinued.has(b.module)) flags.push('fatigued');
    if (overload) flags.push('overload');
    if (warmup) flags.push('warmup');

    const id = uuidv4();
    const row = blockRow(id, this.sessionId, { module: b.module, lBefore: b.L, lAfter, score: b.score, flags }, active, JSON.stringify(summary));
    const { trials, items } = b.rows(id);
    const assessment = this.assessOrLog(row, b.meanRating ?? null);
    const view: BlockSummaryView = {
      module: b.module,
      title: moduleTitles[b.module],
      lBefore: b.L,
      lAfter,
      changes: levelChanges(b.module, b.L, lAfter, b.task, this.planContext(seg)),
      score: b.viewScore ?? b.score,
      lines,
      flags,
      showLevel: this.counted && b.level !== null && !warmup,
      levelNote: warmup ? WARMUP_LEVEL_NOTE : null,
    };
    if (assessment !== undefined) view.assessment = assessment;

    let committed = false;
    let addTried = false;
    const writes: Write[] = [
      {
        label: 'addBlock',
        run: async () => {
          // A failed reply may come after the commit: a retry first checks whether the block is already there (M8).
          if (addTried && (await this.repo.hasBlock(id))) return;
          addTried = true;
          await this.repo.addBlock(row, trials, items);
        },
      },
      {
        label: 'commit',
        run: () => {
          // Once only: a throw after record() must not count the block twice when the queue runs this write again.
          if (committed) return Promise.resolve();
          committed = true;
          try {
            this.record({ module: b.module, score: b.score, flags, hitRts: b.hitRts }, lAfter);
            if (this.history !== null) appendBlock(this.history, row, this.plan.kind);
            if (this.past !== null) appendPast(this.past, row, this.plan.kind);
            b.onCommit?.();
          } catch (e) {
            // The run again skips the rest of the commit, so the failure would leave no trace without this line.
            this.logLater('session: block commit failed', { sessionId: this.sessionId, module: b.module, error: errorText(e) });
            throw e;
          }
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

  /**
   * «Форма дня» of a warm-up block (F5): the warm-ups of the history and of this session stored so far, and this block
   * (not stored yet, so it counts once, T-R12), on the block's local day and band. null: no history (Р18) or no RT today.
   */
  private dayFormOf(startedAt: string, L: number, hitRts: readonly number[]): string | null {
    if (this.past === null) return null;
    const day = localDayIso(startedAt);
    const band = Math.floor(L / 4);
    const form = dayForm([...warmupDays(this.past), { day, band, rts: hitRts.map(tenthMs) }], day, band);
    return form === null ? null : dayFormLine(form);
  }

  /**
   * The «Оценка» of a block; a failure leaves the summary without the section (the block is stored all the same) and
   * goes to the log when the log can be written, without waiting for it.
   */
  private assessOrLog(row: BlockRow, meanRating: number | null): BlockAssessment | undefined {
    try {
      return assessBlock(row, { kind: this.plan.kind, history: this.history, now: this.now(), meanRating });
    } catch (e) {
      this.logLater('session: block assessment failed', { sessionId: this.sessionId, module: row.module, error: errorText(e) });
      return undefined;
    }
  }

  /** An error line for the log, best effort and without waiting for it. */
  private logLater(message: string, detail: Record<string, unknown>): void {
    this.repo.appendLog(errorLogRow(this.now().toISOString(), message, detail)).catch(() => {
      // The database is failing already; the error simply goes unlogged.
    });
  }

  /**
   * Book-keeping for a stored block; the segment level becomes lAfter. An overload block leaves the module's
   * level in the session alone, and in a mix the segment level too (only the finisher moves its own level).
   * A warm-up block touches neither (F5).
   */
  private record(b: SessionBlock, lAfter: number): void {
    const seg = this.segment();
    const moving = movesLevel(b.flags);
    this.sessionBlocks.push(b);
    if (moving || seg.segment.overload === 'finisher') seg.L = lAfter;
    if (moving && !b.flags.includes('timing_unreliable')) seg.levelBlockStored = true;
    seg.blocksDone++;
    seg.attempt = 0;
    seg.unreliableReplayed = false;
    this.active = null;
    if (b.module !== 'numseries' && moving) this.levels.set(b.module, lAfter);
    if (this.counted && isReactionModule(b.module)) {
      const clean = this.sessionBlocks.filter((x) => x.module === b.module && isCleanBlock(x.flags));
      if (detectFatigue(clean)) this.fatigueDetected.add(b.module);
    }
  }

  /**
   * One of the first CALIBRATION_BLOCKS level-moving blocks of the module: those stored before the session plus those
   * of this session, so warm-ups never use up a new module's calibration (T-R11, T-R38). Without the history read at
   * start, lifetimeBlocks (every stored block) stands in for the stored ones.
   */
  private isCalibration(module: ModuleId): boolean {
    if (!this.counted) return false;
    const stored = this.levelBlocks === null ? this.states[module].lifetimeBlocks : (this.levelBlocks.get(module) ?? 0);
    const thisSession = this.sessionBlocks.filter((b) => b.module === module && movesLevel(b.flags)).length;
    return stored + thisSession < CALIBRATION_BLOCKS;
  }

  /** s of the previous level-moving block of the module in this session that was not timing_unreliable. */
  private prevScore(module: ModuleId): number | null {
    for (let i = this.sessionBlocks.length - 1; i >= 0; i--) {
      const b = this.sessionBlocks[i];
      if (b?.module === module && !b.flags.includes('timing_unreliable') && movesLevel(b.flags)) return b.score;
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
