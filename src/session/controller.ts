import { v4 as uuidv4 } from 'uuid';
import type { Repository } from '../data/repository';
import type { BlockRow, LogicItemRow, TrialRow, WellbeingRow } from '../data/rows';
import { detectFatigue, nextLevel, stabilityHold, startLevel, type DeltaInput } from '../engine/adaptive';
import { daysBetween, localDayIso } from '../engine/dates';
import { dayForm } from '../engine/dayForm';
import { deriveModuleStates, isCleanBlock, isCountedSession, movesLevel } from '../engine/derive';
import { SERIES_FORMS, nextSeriesForm, parseResults, type DiagnosticResults, type ModuleRestarts } from '../engine/diagnostic';
import type { Rating } from '../engine/elo';
import { CALIBRATION_BLOCKS } from '../engine/phases';
import { OVERLOAD_LEVEL_STEP, isTestFormat, warmupLevel, type ModuleState, type Segment, type SessionPlan } from '../engine/planner';
import { stabilityOf } from '../engine/reaction/stability';
import type { BlockTimeline, TrialResult } from '../engine/reaction/types';
import { readinessOfLatest } from '../engine/readiness';
import { isBandModule, isReactionModule, type BlockFlag, type FamilyId, type LayoutId, type ModuleId } from '../engine/types';
import { CARD_LESSON } from '../modules/memory/params';
import { memorySpan, scoreMemoryBlock, type MemoryAnswer } from '../modules/memory/score';
import { bandIndex } from '../modules/reaction/common';
import type { RdoParams } from '../modules/reaction/rdo';
import { moduleTitles, reactionModules } from '../modules/registry';
import { scoreTableRun, type TableRun } from '../modules/tables/score';
import { assessBlock, meanFamilyRating, type BlockAssessment } from './assessment';
import { appendBlock, type BlockHistory } from './blockHistory';
import {
  blockInstruction,
  buildBlock,
  checkMemoryAnswers,
  diagnosticBlockSeed,
  diagnosticResults,
  floorsFrom,
  levelChanges,
  planBlock,
  scoreReaction,
  scoreSeries,
  trainingBlockSeed,
  updatedRatings,
  type BlockPlan,
  type BlockStep,
  type DiagnosticPart,
  type PlanContext,
  type SeriesOutcome,
  type WindowFloors,
} from './blocks';
import {
  appendPast,
  hasPlayedMode,
  lastSetup,
  pastBlocks,
  rdoCycleCount,
  sameSetup,
  setupOf,
  testFormatRuns,
  warmupDays,
  withBlock,
  type PastBlocks,
  type SegmentSetup,
} from './pastBlocks';
import { blockRow, errorLogRow, logicItemRows, sessionRow, trialRows, wellbeingRow } from './rowsBuild';
import { SaveQueue, type SaveOutcome, type Write } from './saveQueue';
import { TEST_FORMAT_NAMES, testFormatBest, testFormatLines, testFormatMetrics, type TestFormatMetrics } from './testFormat';
import {
  AUDIO_NOT_PLAYED,
  conditionLines,
  dayFormLine,
  dayLayoutLine,
  DIAGNOSTIC_RESTART_NOTICE,
  floorLine,
  memoryLine,
  reactionLines,
  saveErrorMessage,
  seriesLine,
  spanLines,
  stabilityLine,
  tableLines,
  UNRELIABLE_REPLAY_NOTICE,
  WARMUP_LEVEL_NOTE,
  type BlockSummaryView,
  type DiagnosticComparison,
  type DiscardOutcome,
  type PastDiagnostic,
  type SaveErrorWhat,
  type SeriesAnswer,
  type Step,
  type StepOf,
} from './steps';

export interface SessionStartOptions {
  repo: Repository;
  plan: SessionPlan;
  /**
   * The user's own layout (the primary): diagnostics and test-format runs play it, the other blocks the plan's layout of
   * the day when it has one (F9). A block that needs more keys than the mouse has switches to the keyboard.
   */
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

/** Why the block on screen is given up: focus_lost — the window lost focus; error — a runner or drawing failure; user — Escape. */
export type DiscardReason = 'focus_lost' | 'error' | 'user';
/** A restart of the block on screen: a DiscardReason, or timing_unreliable — a diagnostic reaction block replayed once (I1). */
export type RestartReason = DiscardReason | 'timing_unreliable';
export type { DiscardOutcome } from './steps';

/**
 * Esc in a training or free block at this share done or less restarts it for free; later the block counts as s = 0
 * (F11). A focus loss or a drawing error always restarts for free.
 */
export const DISCARD_FREE_SHARE = 0.3;
/** A share is k/n with n ≤ 100: float noise is far below any real difference. */
const SHARE_EPS = 1e-9;

/** A restart recorded in the next stored block of the segment (summaryJson.restarts, F11). */
interface RestartEntry {
  reason: DiscardReason;
  progress: number;
}

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
  /**
   * The re-adaptation mark (F9) is still to come: no level-moving block of the segment that measured something (not
   * counted as 0 after Esc, no dropped frames) is stored yet (T-R63).
   */
  readaptPending: boolean;
  /**
   * The setup of the module's last segment before this one (lastSetup at the segment's start, Р26); null: none, not a
   * reaction module, or no history. The segment's own blocks never stand in for it.
   */
  setupBefore: SegmentSetup | null;
  /** Discards of the current block. */
  attempt: number;
  /** Diagnostics: the current block was already replayed once for timingUnreliable (I1). */
  unreliableReplayed: boolean;
  /** Text and key hint of the last instruction shown in the segment. */
  lastInstruction: string | null;
  /** Restarts since the segment's last stored block: the next stored block keeps them (summaryJson.restarts, F11). */
  restarts: RestartEntry[];
  /** Diagnostics: the current task was restarted by Esc; another Esc is refused (F11). */
  escUsed: boolean;
  /**
   * The seed of the Горбов series table (F10): block 0's seed, renewed by each restart of block 0, so the table of its
   * counted attempt; blocks 1–2 deal from it. null before block 0 starts.
   */
  tableSeed: number | null;
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
  /** The summary's heading; default: the module's title. */
  title?: string;
  /** Number series in training and free sessions: meanFamilyRating after the block (the step by rating). */
  meanRating?: number;
  rows: (blockId: string) => { trials: TrialRow[]; items: LogicItemRow[] };
  /**
   * Counted as s = 0 after Esc at this share done (F11): flag `discarded`, summaryJson.discarded, no summary step (the
   * next block follows).
   */
  discardedAt?: number;
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

/** A test-format run's metrics, heading and summary lines (F4). */
interface RunSummary {
  metrics: TestFormatMetrics;
  title: string;
  lines: string[];
}

/** The floor line of a reaction block whose window rested on the personal floor (F3); none otherwise. */
function floorLines(plan: BlockPlan): string[] {
  if (plan.kind !== 'reaction' || plan.load === null) return [];
  const { floorMs, nominalWindowMs, loadBand } = plan.load;
  return floorMs !== null && floorMs > nominalWindowMs ? [floorLine(floorMs, nominalWindowMs, loadBand !== null)] : [];
}

/** The period an РДО block played (F14), for its speed line; null for the other blocks. */
function rdoPeriodOf(plan: BlockPlan): number | null {
  return plan.kind === 'reaction' && plan.module === 'rdo' ? (plan.params as RdoParams).periodMs : null;
}

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
 * - Overload blocks (Segment.overload): a band module's play the next band's load at the window of their own band and
 *   keep their level (lAfter = lBefore), a finisher of one starts at L_saved (F3). РДО, the tables and memory play
 *   OVERLOAD_LEVEL_STEP higher: their finisher starts at L_saved + 3 and moves only its own level, a mix overload
 *   block's lAfter goes to history only. Their flag keeps them out of L_saved, fatigue, g = 2 and the window floor
 *   (an overload block is never a segment's first block).
 * - The window of a band module's block rests on the personal floor of its band (F3): the history read at start and
 *   the blocks of this session as they are stored; diagnostics have none.
 * - The warm-up (F5) plays every block at warmupLevel(L_saved) and moves no level; its flag keeps it out of L_saved,
 *   lastTrainedAt, fatigue, calibration and g = 2. Its summary says so and shows «Форма дня» from the warm-ups of the
 *   history read at start, those of this session and the block itself.
 * - A test-format run (F4) is one block of DIAGNOSTIC_PARAMS at L_saved, whatever its budget, without a window floor;
 *   lAfter = lBefore and its flag keeps it out of everything the warm-up stays out of, and out of the window floor.
 *   Its summary is the run's metrics against the best of the earlier runs of its format (none shown when the history
 *   could not be read, Р18), stored as summaryJson.testFormat.
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
  /** The block the instruction on screen introduces, and that instruction without the day line. */
  private next: { plan: BlockPlan; instruction: string } | null = null;
  /** The day line (dayLayoutLine) still opens the next instruction of a block on the layout of the day (F9). */
  private dayLineDue: boolean;
  /** The strategy lesson (F13) was shown in this session: never again, even if its card block was not stored. */
  private lessonShown = false;
  /** The instruction the lesson on screen comes before. */
  private afterLesson: StepOf<'instruction'> | null = null;
  private active: ActiveBlock | null = null;
  private saving: SaveContext | null = null;
  private busy = false;

  private readonly sessionBlocks: SessionBlock[] = [];
  /** Current level of modules played in this session (a module that comes back continues from here). */
  private readonly levels = new Map<ModuleId, number>();
  private readonly fatigueDetected = new Set<ModuleId>();
  private readonly fatiguePrompted = new Set<ModuleId>();
  private readonly fatigueContinued = new Set<ModuleId>();
  private readonly discardLog: Array<{ module: ModuleId; reason: RestartReason }> = [];
  /** Diagnostics: the restarts of each module's tasks, for resultsJson.restarts (F11). */
  private readonly diagRestarts: Partial<Record<ModuleId, ModuleRestarts>> = {};

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
    this.dayLineDue = o.plan.layout !== undefined && o.plan.layout !== o.layout;
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

  /** Blocks thrown away and played again in this session (Esc, focus loss, runner errors, I1 replays), oldest first. */
  get discards(): ReadonlyArray<{ module: ModuleId; reason: RestartReason }> {
    return [...this.discardLog];
  }

  /** Escape may stop the block on screen: always in training and free sessions; in a diagnostic until the task's restart is used (F11). */
  get escAllowed(): boolean {
    return this.counted || this.seg === null || !this.seg.escUsed;
  }

  ackInstruction(): void {
    this.take('instruction');
    const seg = this.segment();
    if (this.next === null) throw new Error('SessionController: instruction without a block');
    seg.clockStart ??= this.now().getTime();
    seg.lastInstruction = this.next.instruction;
    this.startBlock(this.next.plan);
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
      const run = this.runSummary(module, results);
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
          ...(run === null ? {} : { testFormat: run.metrics }),
        },
        lines: run?.lines ?? [
          ...reactionLines(module, summary, stability, rdoPeriodOf(plan)),
          ...floorLines(plan),
          ...conditionLines(module, conditions, plan.kind === 'reaction' && plan.overload),
          ...(tl.audioPlayed === false ? [AUDIO_NOT_PLAYED] : []),
        ],
        ...(run === null ? {} : { title: run.title }),
        rows: (blockId) => ({ trials: trialRows(blockId, step.specs, tl, results), items: [] }),
        onCommit: () => {
          if (!this.counted) this.diagParts.push({ module, summary, conditions, hitRts });
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
    await this.exclusive(() => this.completeSeries(outcomes));
  }

  /**
   * A number-series block from its scored items: the ratings move by every item (a skipped one is a failure), the
   * summary keeps each item (`skipped: true` on the skipped ones, F11). `discardedAt`: counted after Esc (F11).
   */
  private async completeSeries(outcomes: readonly SeriesOutcome[], discardedAt?: number): Promise<void> {
    const successes = outcomes.filter((o) => o.success).length;
    const total = outcomes.length;
    const ratings = this.counted ? updatedRatings(this.ratings, outcomes) : null;
    const at = this.now().toISOString();
    const meanTimeMs = outcomes.reduce((sum, o) => sum + o.answer.timeMs, 0) / total;
    const limits = outcomes.flatMap((o) => (o.item.timeLimitMs === null ? [] : [o.item.timeLimitMs]));
    const shortestLimitMs = limits.length > 0 ? Math.min(...limits) : null;
    const skipped = outcomes.filter((o) => o.answer.skipped === true).length;
    // The form a diagnostic played (T-R73), taken before the block is stored: storing it resets the attempt.
    const form = this.counted ? null : this.seriesFormAt(this.segment().attempt);
    const items = outcomes.map((o) => ({
      itemId: o.item.id,
      answer: o.item.answer,
      given: o.answer.given,
      timeMs: o.answer.timeMs,
      ...(o.answer.skipped === true ? { skipped: true } : {}),
    }));
    await this.completeBlock({
      module: 'numseries',
      L: 0,
      score: successes / total,
      level: null,
      hitRts: [],
      summary: { correct: successes, total, items },
      lines: [seriesLine({ correct: successes, total, skipped, meanTimeMs, shortestLimitMs })],
      ...(ratings === null ? {} : { meanRating: meanFamilyRating(ratings) }),
      rows: (blockId) => ({ trials: [], items: logicItemRows(blockId, outcomes, at) }),
      ...(discardedAt === undefined ? {} : { discardedAt }),
      onCommit: () => {
        if (ratings !== null) this.ratings = ratings;
        else if (form !== null) this.diagParts.push({ module: 'numseries', correct: successes, total, form });
      },
      extraWrites: ratings === null ? [] : [{ label: 'saveRatings', run: () => this.repo.saveRatings(ratings) }],
    });
  }

  /**
   * One answer per trial, in order; the span protocol (diagnostics) ends early when it stops (checkMemoryAnswers).
   * A fixed block's s is its partial score, the positions right over the positions of all its rows (F13), and its summary
   * keeps the mode, the row length, the card's showing and sound, the exact rows, the positions right, s and every
   * answer. A card with sound that never played (`audioPlayed` false: no unlock, a blocked device) is stored and shown
   * as a card without sound, with the AUDIO_NOT_PLAYED line reaction blocks get (T-R67). The span protocol is that of
   * 0.2.0: s = exact rows / rows shown, and its span goes to the diagnostic results. The level moves by nextLevel with no
   * stability rule (no RTs).
   */
  async submitMemory(answers: readonly MemoryAnswer[], audioPlayed?: boolean): Promise<void> {
    const step = this.take('memory_block');
    checkMemoryAnswers(step, answers);
    const { trials, params, mode, protocol } = step;
    await this.exclusive(async () => {
      const { exact, positionsCorrect, partial } = scoreMemoryBlock(trials, answers);
      const n = answers.length;
      if (protocol === 'span') {
        const span = memorySpan(trials, answers);
        await this.completeBlock({
          module: 'memory',
          L: step.L,
          score: exact / n,
          level: NO_STABILITY_RULE,
          hitRts: [],
          summary: { protocol, mode, exact, span, answers },
          lines: spanLines(exact, n, span),
          rows: () => ({ trials: [], items: [] }),
          onCommit: () => {
            if (!this.counted) this.diagParts.push({ module: 'memory', span });
          },
        });
        return;
      }
      const { length, exposureMs } = params;
      const silent = params.sound && audioPlayed === false;
      const sound = params.sound && !silent;
      await this.completeBlock({
        module: 'memory',
        L: step.L,
        score: partial,
        level: NO_STABILITY_RULE,
        hitRts: [],
        summary: { mode, length, exposureMs, sound, exact, positionsCorrect, partial, answers },
        lines: [memoryLine({ partial, exact, trials: n, length, mode, exposureMs, sound }), ...(silent ? [AUDIO_NOT_PLAYED] : [])],
        rows: () => ({ trials: [], items: [] }),
      });
    });
  }

  /** Leaves the lesson (F13) for the instruction it came before. */
  ackLesson(): void {
    this.take('lesson');
    const next = this.afterLesson;
    if (next === null) throw new Error('SessionController: a lesson without an instruction after it');
    this.afterLesson = null;
    this.current = next;
  }

  /** Starts the replay announced by the `notice` step. */
  ackNotice(): void {
    this.take('notice');
    this.startBlock(this.block().plan);
  }

  /**
   * Stops the block on screen, `progress` of it done (the share its screen reports, F11):
   * - training and free sessions: Esc after DISCARD_FREE_SHARE stores the block as s = 0 (countDiscard) and the next
   *   block follows; an earlier Esc, a focus loss or a drawing error restarts it for free, and the next stored block of
   *   the segment records the restart (summaryJson.restarts);
   * - diagnostics: restartDiagnostic.
   * `answered`: number series, the answers given so far (the first items of the block, in order).
   */
  async discardBlock(reason: DiscardReason, progress: number, answered: readonly SeriesAnswer[] = []): Promise<DiscardOutcome> {
    if (this.busy) throw new Error('SessionController: another action is in progress');
    const step = this.current;
    if (!isBlockStep(step)) throw new Error(`SessionController: expected a block step, current step is ${step.kind}`);
    if (!(progress >= 0 && progress <= 1)) throw new RangeError(`discardBlock: progress must be within [0, 1], got ${String(progress)}`);
    const module = moduleOfBlock(step);
    if (!this.counted) return this.restartDiagnostic(module, reason, progress);
    if (reason !== 'user' || progress <= DISCARD_FREE_SHARE + SHARE_EPS) {
      this.segment().restarts.push({ reason, progress });
      this.restartBlock(module, reason);
      return { kind: 'restarted' };
    }
    return this.countDiscard(step, progress, answered);
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

  /**
   * A training or free block counted as s = 0 after Esc (F11): its level moves by nextLevel(L, s = 0) when the block
   * moves the level at all, and it is stored without trials; number series keep the answered items and record the
   * rest as skipped (RangeError, before anything changes, for answers that are not the block's first items).
   */
  private async countDiscard(step: BlockStep, progress: number, answered: readonly SeriesAnswer[]): Promise<DiscardOutcome> {
    if (step.kind === 'numseries_block') {
      const skipped = step.items.slice(answered.length).map((it): SeriesAnswer => ({ itemId: it.id, given: null, timeMs: 0, skipped: true }));
      const outcomes = scoreSeries(step, [...answered, ...skipped]);
      await this.exclusive(() => this.completeSeries(outcomes, progress));
      return { kind: 'counted', progress, lBefore: 0, lAfter: 0, levelMoves: false, series: true };
    }
    const lBefore = step.L;
    let lAfter = lBefore;
    await this.exclusive(async () => {
      lAfter = await this.completeBlock({
        module: moduleOfBlock(step),
        L: lBefore,
        score: 0,
        level: NO_STABILITY_RULE,
        hitRts: [],
        summary: {},
        lines: [],
        rows: () => ({ trials: [], items: [] }),
        discardedAt: progress,
      });
    });
    return { kind: 'counted', progress, lBefore, lAfter, levelMoves: lAfter !== lBefore, series: false };
  }

  /**
   * A diagnostic (F11): the first Esc of a task restarts it after the notice and uses up its restart, a second one is
   * refused (nothing changes); a focus loss or a drawing error restarts it without using it up. Restarts by Esc and
   * after a focus loss are counted for resultsJson.restarts; every restart is also recorded in the next stored block.
   */
  private restartDiagnostic(module: ModuleId, reason: DiscardReason, progress: number): DiscardOutcome {
    const seg = this.segment();
    if (reason === 'user' && seg.escUsed) return { kind: 'refused' };
    seg.restarts.push({ reason, progress });
    if (reason !== 'error') {
      const counts = (this.diagRestarts[module] ??= { user: 0, focus: 0 });
      if (reason === 'user') counts.user++;
      else counts.focus++;
    }
    if (reason !== 'user') {
      this.restartBlock(module, reason);
      return { kind: 'restarted' };
    }
    seg.escUsed = true;
    this.restartBlock(module, reason, { kind: 'notice', module, text: DIAGNOSTIC_RESTART_NOTICE });
    return { kind: 'restarted' };
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
      readaptPending: true,
      setupBefore: this.counted && this.past !== null && isReactionModule(segment.module) ? lastSetup(this.past, segment.module) : null,
      attempt: 0,
      unreliableReplayed: false,
      lastInstruction: null,
      restarts: [],
      escUsed: false,
      tableSeed: null,
    };
    this.presentNext();
  }

  /** The level the segment starts at, and whether it is the start drop of startLevel (T-R36). */
  private segmentLevel(segment: Segment): { L: number; startDrop: boolean } {
    const { module } = segment;
    const at = (L: number): { L: number; startDrop: boolean } => ({ L, startDrop: false });
    if (!this.counted) return at(segment.fixedL ?? 0);
    if (module === 'numseries') return at(0);
    // The finisher takes a module that is not in the plan: no level in this session yet (§6.3). A band module's plays
    // L_saved with the next band's load (F3); РДО, the tables and memory play L_saved + OVERLOAD_LEVEL_STEP.
    if (segment.overload === 'finisher') {
      const { lSaved } = this.states[module];
      return at(isBandModule(module) ? lSaved : lSaved + OVERLOAD_LEVEL_STEP);
    }
    // The warm-up plays one fixed level and leaves the module's level in the session alone (F5); a test-format run
    // plays L_saved, which it stores as both levels of its block (F4).
    if (segment.purpose === 'warmup') return at(warmupLevel(this.states[module].lSaved));
    if (segment.purpose === 'test_format') return at(this.states[module].lSaved);
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

  /**
   * What planBlock needs to know about the session and the segment. The window floors come from the history read at
   * start and the blocks stored since (F3); a diagnostic has none, nor a test-format run (F4), nor a session whose
   * history could not be read (Р18). The mark rate is the plan's (F15); planBlock keeps it to the blocks with marks.
   * The РДО speed cycle goes on from the same history (T-R61); without it a segment plays its own order.
   */
  private planContext(seg: SegmentRun): PlanContext {
    const floored = this.counted && seg.segment.purpose !== 'test_format';
    return {
      layout: this.blockLayout(seg.segment),
      scale: this.scale,
      diagnostic: !this.counted,
      planSeed: this.plan.seed,
      segmentIndex: seg.index,
      floors: floored && this.past !== null ? floorsFrom(this.past) : null,
      feedback: this.plan.feedback ?? 'none',
      rdoCount: this.counted && this.past !== null ? rdoCycleCount(this.past) : null,
    };
  }

  /**
   * The layout a block of `segment` plays (F9): the user's own in a diagnostic, a test-format run and a warm-up (the
   * form of the day compares warm-ups day to day, T-R65), else the plan's layout of the day (the user's own when the
   * plan names none).
   */
  private blockLayout(segment: Segment): LayoutId {
    if (!this.counted || segment.purpose === 'test_format' || segment.purpose === 'warmup') return this.layout;
    return this.plan.layout ?? this.layout;
  }

  /**
   * Instruction first if the segment just started, for every Gorbov run, or when the rules changed. The first one of a
   * reaction block on the layout of the day, when that is not the user's own, opens with dayLayoutLine (F9); tables,
   * memory and number series do not use the layout (T-R65). The day line is no change of rules. Before the first 3×3 card ever the strategy lesson comes, then the card's instruction (F13).
   */
  private presentNext(): void {
    const seg = this.segment();
    const layout = this.blockLayout(seg.segment);
    const plan = planBlock(seg.segment, seg.L, seg.blocksDone, this.planContext(seg));
    const { text, keysHint } = blockInstruction(plan, layout);
    const instruction = text + '\n' + keysHint;
    const lesson = this.lessonDue(plan);
    if (lesson || seg.segment.module === 'gorbov' || instruction !== seg.lastInstruction) {
      this.next = { plan, instruction };
      let shown = text;
      if (this.dayLineDue && plan.kind === 'reaction' && layout !== this.layout) {
        shown = `${dayLayoutLine(layout, this.layout)} ${text}`;
        this.dayLineDue = false;
      }
      const step: StepOf<'instruction'> = { kind: 'instruction', module: seg.segment.module, text: shown, keysHint };
      if (lesson) {
        this.lessonShown = true;
        this.afterLesson = step;
        this.current = { kind: 'lesson', lines: CARD_LESSON };
      } else {
        this.current = step;
      }
    } else {
      this.startBlock(plan);
    }
  }

  /**
   * The strategy lesson comes before a training or free 3×3 card block when the history has none (hasPlayedMode, F13)
   * and the lesson was not shown in this session; never without the history (Р18).
   */
  private lessonDue(plan: BlockPlan): boolean {
    if (plan.kind !== 'memory' || plan.mode !== 'card3x3' || this.lessonShown) return false;
    return this.past !== null && !hasPlayedMode(this.past, 'card3x3');
  }

  /**
   * Training/free: a block may start while the budget lasts. Diagnostics: a fixed number of blocks (runs, default 1);
   * a test-format run is one block (F4).
   */
  private anotherBlock(seg: SegmentRun): boolean {
    const { segment } = seg;
    if (!this.counted) return seg.blocksDone < (segment.runs ?? 1);
    if (segment.purpose === 'test_format') return seg.blocksDone < 1;
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
      const results = diagnosticResults(this.diagParts, this.diagRestarts);
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
    this.current = { kind: 'done', sessionId: this.sessionId, diagnostic, seriesTotal, indexDeferred, comparison, layout: this.layout };
  }

  // ---------- blocks ----------

  /**
   * Builds the block from its seed. A Горбов series block deals the table of block 0's counted attempt (F10). A
   * diagnostic's number series plays the form after the one the latest stored diagnostic played (nextSeriesForm), and
   * each restart of the task the form after the one it abandons (T-R73): no form comes twice in a row, within a
   * diagnostic or into the next one.
   */
  private startBlock(plan: BlockPlan): void {
    const seg = this.segment();
    const seedIndex = this.counted ? null : this.diagnosticSeedIndex();
    const seed =
      seedIndex === null
        ? trainingBlockSeed(this.plan.seed, seg.index, seg.blocksDone, seg.attempt)
        : diagnosticBlockSeed(seedIndex, seg.segment.module, seg.blocksDone, seg.attempt);
    const series = plan.kind === 'table' && plan.table === 'series';
    if (series && seg.blocksDone === 0) seg.tableSeed = seed;
    const { step, paramsJson } = buildBlock(plan, seed, this.blockLayout(seg.segment), this.ratings, {
      ...(series ? { tableSeed: seg.tableSeed ?? seed } : {}),
      ...(seedIndex === null ? {} : { seriesForm: this.seriesFormAt(seg.attempt) }),
    });
    this.next = null;
    this.active = { plan, startedAt: this.now().toISOString(), paramsJson };
    this.current = step;
  }

  /** The block again from the next attempt's seed; with `notice`, that step comes first (ackNotice starts the block). */
  private restartBlock(module: ModuleId, reason: RestartReason, notice?: StepOf<'notice'>): void {
    const { plan } = this.block();
    this.discardLog.push({ module, reason });
    this.segment().attempt++;
    if (notice === undefined) this.startBlock(plan);
    else this.current = notice;
  }

  /**
   * Level step, flags, rows and summary of a finished block, then its writes; returns lAfter. The block's in-memory
   * effects (level, session history, fatigue, `onCommit`) apply right after addBlock succeeds. Then the summary step
   * comes, or for a block counted as 0 after Esc (`discardedAt`, F11) the next block.
   */
  private async completeBlock(b: FinishedBlock): Promise<number> {
    const seg = this.segment();
    const active = this.block();
    const discarded = b.discardedAt !== undefined;
    const overload = active.plan.kind !== 'numseries' && active.plan.overload;
    // A training warm-up block (F5) and a test-format run (F4): lAfter = lBefore, no stability rule, no calibration and
    // no g = 2 (T-R11).
    const warmup = this.counted && seg.segment.purpose === 'warmup';
    const testFormat = this.counted && seg.segment.purpose === 'test_format';
    // An overload block of a band module plays the next band's load at its own level and keeps it (F3); counted as 0
    // after Esc, an overload block of РДО, the tables or memory keeps its level too (F11).
    const fixedLevel = warmup || testFormat || (overload && (isBandModule(b.module) || discarded));
    const calibration = b.level !== null && !fixedLevel && this.isCalibration(b.module);
    const firstOfSegment = !overload && !fixedLevel && seg.startDrop && !seg.levelBlockStored;
    const input: DeltaInput | null =
      this.counted && b.level !== null && !fixedLevel
        ? { score: b.score, calibration, prevScoreSameSession: this.prevScore(b.module), firstOfSegment, ...b.level }
        : null;
    const lAfter = input === null ? b.L : nextLevel(b.L, input);
    const lines = [...b.lines];
    if (warmup && !discarded) {
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
    if (b.discardedAt !== undefined) summary = { ...summary, discarded: { reason: 'user', progress: b.discardedAt } };
    // The free restarts since the segment's last stored block (F11).
    if (seg.restarts.length > 0) summary = { ...summary, restarts: [...seg.restarts] };
    // The segment's first level-moving block that measured something, after a change of keys, layout or Go/No-Go colours
    // (F9, T-R63).
    const measured = !discarded && b.level?.timingUnreliable !== true;
    if (this.isReadapt(active.paramsJson, !overload && !fixedLevel && measured && seg.readaptPending)) summary = { ...summary, readapt: true };
    const flags: BlockFlag[] = [];
    if (calibration) flags.push('calibration');
    if (b.level?.timingUnreliable === true) flags.push('timing_unreliable');
    if (this.fatigueContinued.has(b.module)) flags.push('fatigued');
    if (overload) flags.push('overload');
    if (warmup) flags.push('warmup');
    if (testFormat) flags.push('test_format');
    if (discarded) flags.push('discarded');

    const id = uuidv4();
    const row = blockRow(id, this.sessionId, { module: b.module, lBefore: b.L, lAfter, score: b.score, flags }, active, JSON.stringify(summary));
    const { trials, items } = b.rows(id);
    // A block counted as 0 after Esc has no summary step: the pause says what happened (F11).
    const view = discarded ? null : this.summaryView(b, row, lAfter, lines, warmup || testFormat, warmup);

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
        onSaved: async () => {
          if (view === null) await this.advance();
          else this.current = { kind: 'summary', view };
        },
        onAbandon: () => {
          if (!committed) {
            // The block never reached the database: the next one is a new task; the restarts wait for it.
            seg.blocksDone++;
            seg.attempt = 0;
            seg.escUsed = false;
            this.active = null;
          }
          return this.advance();
        },
      },
      writes,
    );
    return lAfter;
  }

  /**
   * The summary of a stored block: its level and what changed (none for a warm-up or a test-format run, `noLevel`), the
   * lines, the flags and the «Оценка». The window of the next block rests on the floors with this block's hits (T-R50):
   * «what changed» and the goal name that window, not the one before the block.
   */
  private summaryView(b: FinishedBlock, row: BlockRow, lAfter: number, lines: string[], noLevel: boolean, warmup: boolean): BlockSummaryView {
    const context = this.planContext(this.segment());
    const floorsAfter = context.floors === null || this.past === null ? null : floorsFrom(withBlock(this.past, row, this.plan.kind));
    const assessment = this.assessOrLog(row, b.meanRating ?? null, floorsAfter);
    const view: BlockSummaryView = {
      module: b.module,
      title: b.title ?? moduleTitles[b.module],
      lBefore: b.L,
      lAfter,
      changes: levelChanges(b.module, b.L, lAfter, this.block().plan, context, floorsAfter),
      score: b.viewScore ?? b.score,
      lines,
      flags: row.flags,
      showLevel: this.counted && b.level !== null && !noLevel,
      levelNote: warmup ? WARMUP_LEVEL_NOTE : null,
    };
    if (assessment !== undefined) view.assessment = assessment;
    return view;
  }

  /**
   * The metrics and summary of a test-format run (F4); null for any other block. The best is that of the runs of the
   * format in the history read at start and in this session; without that history (Р18) the line has no best and the
   * run does not call itself the first.
   */
  private runSummary(module: ModuleId, results: readonly TrialResult[]): RunSummary | null {
    if (!this.counted || this.segment().segment.purpose !== 'test_format' || !isTestFormat(module)) return null;
    const metrics = testFormatMetrics(module, results);
    const lines =
      this.past === null
        ? testFormatLines(module, metrics, null).slice(0, 1)
        : testFormatLines(module, metrics, testFormatBest(testFormatRuns(this.past, module)));
    return { metrics, title: `Прогон в формате теста · ${TEST_FORMAT_NAMES[module]}`, lines };
  }

  /**
   * «Форма дня» of a warm-up block (F5): the warm-ups of the history and of this session stored so far, and this block
   * (not stored yet, so it counts once, T-R12), on the block's local day and band. null: no history (Р18) or no RT today.
   */
  private dayFormOf(startedAt: string, L: number, hitRts: readonly number[]): string | null {
    if (this.past === null) return null;
    const day = localDayIso(startedAt);
    const band = bandIndex(reactionModules.pzmr, L);
    const form = dayForm([...warmupDays(this.past), { day, band, rts: hitRts.map(tenthMs) }], day, band);
    return form === null ? null : dayFormLine(form);
  }

  /**
   * The «Оценка» of a block; a failure leaves the summary without the section (the block is stored all the same) and
   * goes to the log when the log can be written, without waiting for it.
   */
  private assessOrLog(row: BlockRow, meanRating: number | null, floors: WindowFloors | null): BlockAssessment | undefined {
    try {
      return assessBlock(row, { kind: this.plan.kind, history: this.history, now: this.now(), meanRating, floors });
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
   * level in the session alone, and in a mix the segment level too (only the finisher moves its own level, and a band
   * module's keeps it, F3). A warm-up block touches neither (F5). A block counted as 0 after Esc moves the level like
   * any block, so the next one is not the segment's first (T-R37), but it measured nothing: no fatigue from it (T-R10).
   * The next block is a new task with no restarts yet (F11).
   */
  private record(b: SessionBlock, lAfter: number): void {
    const seg = this.segment();
    const moving = movesLevel(b.flags);
    this.sessionBlocks.push(b);
    if (moving || seg.segment.overload === 'finisher') seg.L = lAfter;
    if (moving && !b.flags.includes('timing_unreliable')) seg.levelBlockStored = true;
    if (moving && !b.flags.some((f) => f === 'timing_unreliable' || f === 'discarded')) seg.readaptPending = false;
    seg.blocksDone++;
    seg.attempt = 0;
    seg.unreliableReplayed = false;
    seg.restarts = [];
    seg.escUsed = false;
    this.active = null;
    if (b.module !== 'numseries' && moving) this.levels.set(b.module, lAfter);
    if (this.counted && isReactionModule(b.module)) {
      const clean = this.sessionBlocks.filter((x) => x.module === b.module && isCleanBlock(x.flags) && !x.flags.includes('discarded'));
      if (detectFatigue(clean)) this.fatigueDetected.add(b.module);
    }
  }

  /**
   * Whether the segment's first level-moving block that measured something (`first`) is marked summaryJson.readapt
   * (F9, T-R63): its setup (key mapping, layout, Go/No-Go swap) is not that of the module's last segment (setupBefore,
   * Р26). Never in a diagnostic, without the history (Р18) or without an earlier block that names its layout.
   */
  private isReadapt(paramsJson: string, first: boolean): boolean {
    const last = this.segment().setupBefore;
    const setup = first && last !== null ? setupOf(paramsJson) : null;
    return setup !== null && last !== null && !sameSetup(setup, last);
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

  /**
   * s of the previous level-moving block of the module in this session that was played to its end: not
   * timing_unreliable, not counted as 0 after Esc (T-R10).
   */
  private prevScore(module: ModuleId): number | null {
    for (let i = this.sessionBlocks.length - 1; i >= 0; i--) {
      const b = this.sessionBlocks[i];
      if (b?.module === module && !b.flags.some((f) => f === 'timing_unreliable' || f === 'discarded') && movesLevel(b.flags)) return b.score;
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

  /** The seed index a diagnostic's blocks come from: the plan's, else its number (I5). */
  private diagnosticSeedIndex(): number {
    return this.plan.diagnosticSeedIndex ?? this.diagnosticNumber();
  }

  /**
   * The number-series form attempt `attempt` of a diagnostic plays (T-R73): nextSeriesForm of the stored diagnostics
   * (none when they could not be read: the seed index's form), then one form on per restart.
   */
  private seriesFormAt(attempt: number): number {
    const stored = (this.earlierDiagnostics ?? []).map((d) => d.metrics);
    return (nextSeriesForm(stored, this.diagnosticSeedIndex()) + attempt) % SERIES_FORMS;
  }
}

/** A step that plays a block: reaction, table, number series or memory. */
export function isBlockStep(s: Step): s is BlockStep {
  return s.kind === 'reaction_block' || s.kind === 'table_block' || s.kind === 'numseries_block' || s.kind === 'memory_block';
}

function moduleOfBlock(s: BlockStep): ModuleId {
  switch (s.kind) {
    case 'reaction_block':
    case 'table_block':
      return s.module;
    case 'numseries_block':
      return 'numseries';
    case 'memory_block':
      return 'memory';
  }
}
