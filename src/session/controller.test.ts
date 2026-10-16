import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../data/memoryRepository';
import type { Repository } from '../data/repository';
import { rebuildCaches } from '../data/export';
import { block, item, session } from '../data/repository.contract';
import type { BlockRow, WellbeingRow } from '../data/rows';
import { nextLevel } from '../engine/adaptive';
import { FINISHER_AUDIO } from '../engine/audio/stressors';
import { deriveModuleStates, deriveRatings, defaultModuleState } from '../engine/derive';
import {
  DIAGNOSTIC_VOLUME,
  EMPTY_RESULTS,
  diagnosticSegmentSeed,
  diagnosticSeriesSchedule,
  diagnosticSeriesSeed,
  parseResults,
  planDiagnostic,
  type DiagnosticResults,
} from '../engine/diagnostic';
import { currentPhase, type PhaseInfo } from '../engine/phases';
import { planFree, planTraining, type ModuleState, type Segment, type SessionPlan, type TestFormatId } from '../engine/planner';
import type { TrialSpec } from '../engine/reaction/types';
import { readinessOfLatest } from '../engine/readiness';
import { createRng, deriveSeed } from '../engine/rng';
import { sdTrimmed } from '../engine/stats';
import { MODULE_IDS, type InputKey, type LayoutId, type ModuleId } from '../engine/types';
import { describeChanges } from '../modules/describe';
import { generateMemoryTrials, spanProtocolTrials, type MemoryTrial } from '../modules/memory/generate';
import { CARD_AUDIO, CARD_LESSON, memoryInstruction, memoryParams } from '../modules/memory/params';
import { spanProtocolStops, type MemoryAnswer } from '../modules/memory/score';
import { TRAINING_FAMILIES } from '../modules/numseries/families';
import { diagnosticSeriesItems } from '../modules/numseries/generate';
import { DIAGNOSTIC_PARAMS } from '../modules/reaction/diagnosticParams';
import { pomeh } from '../modules/reaction/pomeh';
import { isSwappedSegment } from '../modules/reaction/gonogo';
import { pzmr } from '../modules/reaction/pzmr';
import { rdoCyclePeriod, rdoPeriod } from '../modules/reaction/rdo';
import { szmr, type SzmrParams } from '../modules/reaction/szmr';
import { reactionModules } from '../modules/registry';
import { generateGorbovTable, gorbovMetrics, gorbovParams } from '../modules/tables/gorbov';
import {
  perfectMemoryAnswers,
  perfectPlayer,
  perfectSeriesAnswers,
  perfectTableRun,
  playTimeline,
  type Respond,
} from '../testing/sessionPlayers';
import { assessBlock } from './assessment';
import { appendBlock } from './blockHistory';
import { diagnosticBlockSeed, trainingBlockSeed } from './blocks';
import { SessionController, type DiscardOutcome, type SessionStartOptions } from './controller';
import { testFormatInstruction } from './testFormat';
import {
  AUDIO_NOT_PLAYED,
  MEMORY_SPAN_INSTRUCTION,
  overloadBandPrefix,
  rdoSpeedNote,
  WARMUP_LEVEL_NOTE,
  type BlockSummaryView,
  type Step,
  type StepOf,
} from './steps';

// The real functions, observed: a test can make one call throw (A-R19).
vi.mock('./assessment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assessment')>();
  return { ...actual, assessBlock: vi.fn(actual.assessBlock) };
});
vi.mock('./blockHistory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./blockHistory')>();
  return { ...actual, appendBlock: vi.fn(actual.appendBlock) };
});

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = '2026-10-14T09:00:00';

class Clock {
  ms: number;
  constructor(iso = T0) {
    this.ms = new Date(iso).getTime();
  }
  readonly now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

const instant = (): Promise<void> => Promise.resolve();

/** Counts the reads of the whole block history. */
class SpyRepo extends MemoryRepository {
  listBlocksCalls = 0;
  override listBlocks(): Promise<BlockRow[]> {
    this.listBlocksCalls++;
    return super.listBlocks();
  }
}

interface Harness {
  c: SessionController;
  repo: Repository;
  clock: Clock;
  sleeps: number[];
}

async function begin(
  plan: SessionPlan,
  o: { repo?: Repository; clock?: Clock; layout?: LayoutId; scale?: number } = {},
): Promise<Harness> {
  const repo = o.repo ?? new MemoryRepository();
  const clock = o.clock ?? new Clock();
  const sleeps: number[] = [];
  const opts: SessionStartOptions = {
    repo,
    plan,
    layout: o.layout ?? 'keyboard',
    now: clock.now,
    appVersion: '0.1.0-test',
    sleep: (ms) => {
      sleeps.push(ms);
      return instant();
    },
  };
  if (o.scale !== undefined) opts.scale = o.scale;
  const c = await SessionController.start(opts);
  return { c, repo, clock, sleeps };
}

function expectStep<K extends Step['kind']>(c: SessionController, kind: K): StepOf<K> {
  const s = c.step;
  if (s.kind !== kind) throw new Error(`expected step ${kind}, got ${s.kind}`);
  return s as StepOf<K>;
}

function label(s: Step): string {
  switch (s.kind) {
    case 'instruction':
    case 'reaction_block':
    case 'fatigue_prompt':
      return `${s.kind}:${s.module}`;
    case 'table_block':
      return `${s.kind}:${s.module}:${s.task}`;
    default:
      return s.kind;
  }
}

interface DriveOptions {
  /** Clock advance per block. */
  blockMs?: number;
  respond?: Respond;
  stopOnFatigue?: boolean;
  wellbeing?: Omit<WellbeingRow, 'id' | 'date'> | null;
}

/** Plays the whole session with a perfect player; returns the labels of every step seen. */
async function drive(h: Harness, o: DriveOptions = {}): Promise<string[]> {
  const seen: string[] = [];
  const blockMs = o.blockMs ?? 30_000;
  for (let i = 0; i < 1000; i++) {
    const s = h.c.step;
    seen.push(label(s));
    switch (s.kind) {
      case 'instruction':
        h.c.ackInstruction();
        break;
      case 'reaction_block':
        h.clock.advance(blockMs);
        await h.c.submitReaction(playTimeline(s.specs, o.respond ?? perfectPlayer));
        break;
      case 'table_block':
        h.clock.advance(blockMs);
        await h.c.submitTable(perfectTableRun(s));
        break;
      case 'numseries_block':
        h.clock.advance(blockMs);
        await h.c.submitNumSeries(perfectSeriesAnswers(s.items));
        break;
      case 'memory_block':
        h.clock.advance(blockMs);
        await h.c.submitMemory(perfectMemoryAnswers(s.trials));
        break;
      case 'lesson':
        h.c.ackLesson();
        break;
      case 'summary':
        await h.c.continueAfterSummary();
        break;
      case 'fatigue_prompt':
        await h.c.answerFatigue(o.stopOnFatigue ?? true);
        break;
      case 'wellbeing':
        await h.c.submitWellbeing(o.wellbeing ?? null);
        break;
      case 'save_error':
        throw new Error(`unexpected save error: ${s.message}`);
      case 'done':
        return seen;
    }
  }
  throw new Error('session did not finish');
}

/** Acks the instruction (if any) and plays one reaction block. */
async function playReaction(h: Harness, respond: Respond = perfectPlayer, dropped?: (idx: number) => boolean): Promise<StepOf<'summary'>> {
  if (h.c.step.kind === 'instruction') h.c.ackInstruction();
  const block = expectStep(h.c, 'reaction_block');
  await h.c.submitReaction(playTimeline(block.specs, respond, dropped ? { dropped } : {}));
  return expectStep(h.c, 'summary');
}

function stateWith(module: ModuleId, over: Partial<ModuleState>): ModuleState {
  return { ...defaultModuleState(module), ...over };
}

/** The trials of a block as the module deals them: a training block adds a jitter to each (F9; toEqual leaves undefined out). */
const unjittered = (specs: readonly TrialSpec[]): unknown[] => specs.map((t) => ({ ...t, jitter: undefined }));

/** СЗМР parameters at L with the key mapping of segment `segmentIndex` of the plan with `planSeed` (F9). */
function szmrSegment(L: number, planSeed: number, segmentIndex = 0): SzmrParams {
  const p = szmr.params(L);
  return szmr.withMapping?.(p, deriveSeed(planSeed, 'map:' + String(segmentIndex))) ?? p;
}

/** Params of a block of the load bands at level L (Р9: its level counts as played, not as an old window level). */
const bandParams = (L: number): string => JSON.stringify({ band: Math.floor(L / 4) });

/**
 * A repository with `state` saved and `n` level-moving blocks of its module at its lSaved, in a training session 30
 * days before T0: calibration counts the stored level-moving blocks, not lifetimeBlocks (T-R38).
 */
async function calibratedRepo(state: ModuleState, n = 3): Promise<MemoryRepository> {
  const repo = new MemoryRepository();
  const at = new Date(new Date(T0).getTime() - 30 * DAY).toISOString();
  await repo.createSession(session('calibrated', at, { endedAt: at }));
  for (let i = 0; i < n; i++) {
    const row = block(`calibrated${String(i)}`, 'calibrated', at, { module: state.module, lBefore: state.lSaved, lAfter: state.lSaved, paramsJson: bandParams(state.lSaved) });
    await repo.addBlock(row, [], []);
  }
  await repo.saveModuleState(state);
  return repo;
}

/** The summaryJson of the latest of these block rows (a reaction block's). */
function storedSummary(rows: readonly BlockRow[]): {
  cvRt: number | null;
  stability: { cvAll: number; lapses: number; lapseLimit: number; cvMax: number; held: boolean; cap: number | null };
} {
  const row = rows.at(-1);
  if (row === undefined) throw new Error('expected a stored block');
  return JSON.parse(row.summaryJson) as ReturnType<typeof storedSummary>;
}

const segment = (module: ModuleId, budgetMs: number): SessionPlan['segments'][number] => ({
  module,
  budgetMs,
  purpose: 'free',
});

/** The training plan Home shows on `todayIso` to a user without history and without a test date. */
function firstDayPlan(states: Record<ModuleId, ModuleState>, todayIso: string, seed: number): SessionPlan {
  return planTraining(states, todayIso, seed, currentPhase({ firstSessionAt: null, today: todayIso, testDate: null, states }));
}

describe('SessionController — flow', () => {
  it('Go/No-Go swaps its colours in the segments the plan seed picks (F8); answers by the expected key score 1', async () => {
    let seed = 1;
    while (isSwappedSegment(seed, 0) || !isSwappedSegment(seed, 1)) seed++;
    const h = await begin({ kind: 'free', seed, segments: [segment('gonogo', 1), segment('gonogo', 1)] });
    const texts: string[] = [];
    const scores: number[] = [];
    for (let i = 0; i < 2; i++) {
      texts.push(expectStep(h.c, 'instruction').text);
      h.c.ackInstruction();
      const block = expectStep(h.c, 'reaction_block');
      const goColors = new Set(block.specs.flatMap((t) => (t.expected.kind === 'press' && t.stimulus.kind === 'shape' ? [t.stimulus.color] : [])));
      expect([...goColors]).toEqual([i === 0 ? 'red' : 'green']);
      await h.c.submitReaction(playTimeline(block.specs, perfectPlayer));
      scores.push(expectStep(h.c, 'summary').view.score);
      h.clock.advance(1);
      await h.c.continueAfterSummary();
    }
    expect(texts).toEqual([
      'На красный круг нажимай Пробел. На зелёный круг не нажимай ничего. Нагрузка: no-go 20 %, интервал 0,5–2,5 с.',
      'В этом задании наоборот: на зелёный круг нажимай Пробел, на красный круг — ничего. Нагрузка: no-go 20 %, интервал 0,5–2,5 с.',
    ]);
    expect(scores).toEqual([1, 1]);
    const swapped = (await h.repo.listBlocks()).map((b) => (JSON.parse(b.paramsJson) as { swapped: boolean }).swapped);
    expect(swapped).toEqual([false, true]);
  });

  it('the changes of a swapped Go/No-Go block name the swapped colours (T-R41)', async () => {
    let seed = 1;
    while (!isSwappedSegment(seed, 0)) seed++;
    const yesterday = new Date(new Date(T0).getTime() - DAY).toISOString();
    const repo = await calibratedRepo(stateWith('gonogo', { lSaved: 16, lastTrainedAt: yesterday }));
    const h = await begin({ kind: 'free', seed, segments: [segment('gonogo', 1)] }, { repo });
    const { view } = await playReaction(h);
    // The start drop takes the segment to 15; a perfect block crosses 16, where the no-go becomes the square.
    expect([view.lBefore < 16, view.lAfter >= 16]).toEqual([true, true]);
    expect(view.changes).toContainEqual({ label: 'Нагрузка', from: 'no-go 15 %, интервал 0,3–1 с', to: 'no-go — зелёный квадрат, интервал 0,3–1 с' });
  });

  it('walks a full training plan to done', async () => {
    const repo = new MemoryRepository();
    const plan = firstDayPlan(await repo.getModuleStates(), T0, 42);
    const h = await begin(plan, { repo });
    const seen = await drive(h, { blockMs: 150_000 });
    const summaries = (n: number): string[] => Array<string>(n).fill('summary');
    const blocks = (step: string, n: number): string[] => Array.from({ length: n }, () => [step, 'summary']).flat();
    expect(seen).toEqual([
      'instruction:pzmr',
      ...blocks('reaction_block:pzmr', 1),
      'instruction:szmr',
      ...blocks('reaction_block:szmr', 2),
      'instruction:gonogo',
      ...blocks('reaction_block:gonogo', 2),
      'instruction:gorbov',
      'table_block:gorbov:black_up',
      'summary',
      'instruction:gorbov',
      'table_block:gorbov:red_down',
      'summary',
      // Each memory block plays another mode, so each has its own instruction.
      'instruction:memory',
      'memory_block',
      'summary',
      'instruction:memory',
      'memory_block',
      'summary',
      'instruction:numseries',
      ...['numseries_block', summaries(1), 'numseries_block', summaries(1), 'numseries_block', summaries(1)].flat(),
      'numseries_block',
      'summary',
      'wellbeing',
      'done',
    ]);
    const [session] = await repo.listSessions();
    expect(session).toMatchObject({ id: h.c.sessionId, kind: 'training', phase: 'base', appVersion: '0.1.0-test', startedAt: new Date(T0).toISOString() });
    expect(session?.endedAt).toBe(h.clock.now().toISOString());
    expect((await repo.listBlocks()).map((b) => b.module)).toEqual([
      'pzmr',
      'szmr',
      'szmr',
      'gonogo',
      'gonogo',
      'gorbov',
      'gorbov',
      'memory',
      'memory',
      'numseries',
      'numseries',
      'numseries',
      'numseries',
    ]);
    expect(expectStep(h.c, 'done')).toEqual({
      kind: 'done',
      sessionId: h.c.sessionId,
      diagnostic: null,
      seriesTotal: null,
      indexDeferred: false,
      comparison: null,
      layout: 'keyboard',
    });
  });

  it('the session row stores the plan phase', async () => {
    const states = await new MemoryRepository().getModuleStates();
    const overload: PhaseInfo = { phase: 'overload', reason: 'test_soon', dayNumber: 30, daysToTest: 20, uncalibrated: [] };
    const training = await begin(planTraining(states, T0, 1, overload));
    expect((await training.repo.listSessions())[0]?.phase).toBe('overload');
    // Plans without a phase (free training, diagnostics) store 'none'.
    const free = await begin(planFree('rdo', 1));
    expect((await free.repo.listSessions())[0]?.phase).toBe('none');
    const diagnostic = await begin(planDiagnostic(1));
    expect((await diagnostic.repo.listSessions())[0]).toMatchObject({ kind: 'diagnostic', phase: 'none' });
  });

  it('free session ends with done, no wellbeing', async () => {
    const h = await begin(planFree('rdo', 3));
    const seen = await drive(h, { blockMs: 100_000 });
    // Each РДО block names its own speed, so each comes with its instruction (T-R61).
    expect(seen).toEqual([
      'instruction:rdo',
      'reaction_block:rdo',
      'summary',
      'instruction:rdo',
      'reaction_block:rdo',
      'summary',
      'instruction:rdo',
      'reaction_block:rdo',
      'summary',
      'done',
    ]);
    expect((await h.repo.listSessions())[0]?.endedAt).not.toBeNull();
    expect(await h.repo.listWellbeing()).toEqual([]);
  });

  it('segment clock starts at the first instruction ack and a running block always finishes', async () => {
    const h = await begin({ kind: 'free', seed: 1, segments: [segment('pzmr', 2 * MIN)] });
    h.clock.advance(10 * MIN); // time on the instruction screen does not count
    h.c.ackInstruction();
    h.clock.advance(119_999);
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    await h.c.continueAfterSummary();
    expectStep(h.c, 'reaction_block');
    h.clock.advance(1); // now exactly at the budget: no new block
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    await h.c.continueAfterSummary();
    expectStep(h.c, 'done');
  });

  it('instruction texts and key hints', async () => {
    const t = await begin(firstDayPlan(await new MemoryRepository().getModuleStates(), T0, 1));
    expect(expectStep(t.c, 'instruction')).toEqual({
      kind: 'instruction',
      module: 'pzmr',
      text: pzmr.instruction('keyboard', pzmr.params(0)) + ' Нагрузка: красный круг.',
      keysHint: 'Пробел',
    });

    const sz = await begin(planFree('szmr', 1), { layout: 'pult' });
    expect(expectStep(sz.c, 'instruction')).toMatchObject({
      text: szmr.instruction('pult', szmrSegment(0, 1)) + ' Нагрузка: 2 цвета на 2 клавиши.',
      keysHint: '←, →',
    });
    sz.c.ackInstruction();
    expect(expectStep(sz.c, 'reaction_block')).toMatchObject({ keys: ['ArrowLeft', 'ArrowRight'], layout: 'pult' });

    const gb = await begin(planFree('gorbov', 1));
    expect(expectStep(gb.c, 'instruction')).toEqual({
      kind: 'instruction',
      module: 'gorbov',
      text: 'Находи и нажимай чёрные числа по порядку от 1 до 24.',
      keysHint: 'Мышь',
    });

    const sc = await begin(planFree('schulte', 1));
    expect(expectStep(sc.c, 'instruction')).toMatchObject({ text: 'Нажимай числа по порядку от 1 до 25.', keysHint: 'Мышь' });

    const ns = await begin(planFree('numseries', 1));
    expect(expectStep(ns.c, 'instruction')).toEqual({
      kind: 'instruction',
      module: 'numseries',
      text:
        'Найди закономерность и введи следующее число. На задачу до 30 секунд, на трудных уровнях меньше: остаток времени показывает полоса. ' +
        'Пробел — пропустить задачу (засчитается как неверная).',
      keysHint: 'Цифры и Enter',
    });

    const dg = await begin({ ...planDiagnostic(1), segments: [planDiagnostic(1).segments[5] as SessionPlan['segments'][number]] });
    expect(expectStep(dg.c, 'instruction')).toMatchObject({
      text: '20 задач, общее время — 10 минут. Найди закономерность и введи следующее число. Пробел — пропустить задачу (засчитается как неверная).',
    });
  });

  it('mouse layout falls back to the keyboard when the level needs more than 2 keys', async () => {
    const repo = new MemoryRepository();
    await repo.saveModuleState(stateWith('szmr', { lSaved: 17, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    const h = await begin(planFree('szmr', 1), { repo, layout: 'mouse' });
    const instr = expectStep(h.c, 'instruction');
    expect(instr.keysHint).toBe('D, F, J, K');
    expect(instr.text).toBe(szmr.instruction('mouse', szmrSegment(16, 1)) + ' Нагрузка: 4 цвета на 4 клавиши, отвлекающая форма.');
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block')).toMatchObject({ L: 16, keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'], layout: 'keyboard' });
  });

  it('shows the instruction again when the rules change mid-segment (СЗМР gets a third color)', async () => {
    const repo = new MemoryRepository();
    await repo.saveModuleState(stateWith('szmr', { lSaved: 8, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    const h = await begin(planFree('szmr', 1), { repo });
    h.c.ackInstruction();
    const start = h.clock.ms;
    expect(expectStep(h.c, 'reaction_block').L).toBe(7);
    h.clock.advance(4 * MIN);
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    // The segment's first block: g = 2 (F6).
    expect(expectStep(h.c, 'summary').view.lAfter).toBe(9);
    await h.c.continueAfterSummary();
    // The segment's key mapping for three colours on two keys, from the segment's seed (F9).
    expect(expectStep(h.c, 'instruction').text).toBe(szmr.instruction('keyboard', szmrSegment(9, 1)) + ' Нагрузка: 3 цвета на 2 клавиши.');
    h.c.ackInstruction(); // does not restart the segment clock
    expect(expectStep(h.c, 'reaction_block').L).toBe(9);
    h.clock.ms = start + 5 * MIN;
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    await h.c.continueAfterSummary();
    expectStep(h.c, 'done');
  });

  it('calls in the wrong step are rejected', async () => {
    const h = await begin(planFree('pzmr', 1));
    await expect(h.c.submitReaction({ onsets: [], droppedOnset: [], presses: [] })).rejects.toThrow(/instruction/);
    expect(() => {
      h.c.continueAfterSummary().catch(() => undefined);
    }).not.toThrow();
    await expect(h.c.continueAfterSummary()).rejects.toThrow();
    h.c.ackInstruction();
    expect(() => {
      h.c.ackInstruction();
    }).toThrow(/reaction_block/);
    await expect(h.c.submitTable(perfectTableRun({ task: 'schulte', params: { size: 5, timeLimitMs: 1, reshuffleEvery: null } }))).rejects.toThrow();
    await expect(h.c.retrySave()).rejects.toThrow();
    await expect(h.c.submitWellbeing(null)).rejects.toThrow();
    await expect(h.c.answerFatigue(true)).rejects.toThrow();
  });

  it('a second action while a save is in flight is rejected', async () => {
    const h = await begin(planFree('pzmr', 1));
    h.c.ackInstruction();
    const tl = playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer);
    const first = h.c.submitReaction(tl);
    await expect(h.c.submitReaction(tl)).rejects.toThrow(/in progress/);
    await expect(h.c.discardBlock('error', 0)).rejects.toThrow(/in progress/);
    await first;
    expect(await h.repo.listBlocks()).toHaveLength(1);
  });
});

describe('SessionController — levels and persistence', () => {
  it('level rises for perfect player and is saved', async () => {
    const h = await begin(planFree('pzmr', 1));
    const first = await playReaction(h);
    expect(first.view.lBefore).toBe(0);
    expect(first.view.lAfter).toBeGreaterThan(first.view.lBefore);
    let st = (await h.repo.getModuleStates()).pzmr;
    expect(st).toMatchObject({ lifetimeBlocks: 1, lSaved: first.view.lAfter, lastTrainedAt: new Date(T0).toISOString() });

    await h.c.continueAfterSummary();
    const second = await playReaction(h);
    expect(second.view.lBefore).toBe(first.view.lAfter);
    expect(second.view.lAfter).toBeGreaterThan(second.view.lBefore);
    st = (await h.repo.getModuleStates()).pzmr;
    expect(st).toMatchObject({ lifetimeBlocks: 2, lSaved: second.view.lAfter, sessionEndLevels: [second.view.lAfter] });
  });

  it('summary view of a perfect first block', async () => {
    const h = await begin(planFree('pzmr', 1));
    const { view } = await playReaction(h);
    expect(view).toEqual({
      module: 'pzmr',
      title: 'ПЗМР',
      lBefore: 0,
      lAfter: 2,
      changes: [{ label: 'Окно ответа', from: '1000 мс', to: '727 мс' }],
      score: 1,
      lines: ['Ошибок нет.', 'Медиана: 300 мс', 'Среднее: 300 мс', 'Разброс (SD): 0 мс', 'Стабильность (CV): 0,00', 'Пропуски: 0'],
      flags: ['calibration'],
      showLevel: true,
      levelNote: null,
      assessment: {
        step: 'Ступень 1 из 5+ — начальная (уровень 2; формат теста — 8)',
        goal: 'До ступени 2 «на подходе к формату теста»: уровень 4 (+2). Там: окно ответа: 727 → 542 мс',
        norms: [
          'Норма (ориентир), среднее: 300 мс — низкий; ниже среднего — до 277 мс. Мальцев 2026, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру',
          'Норма (ориентир), разброс (SD): 0 мс — высокий. Мальцев 2026, юноши 18–21, аппаратная кнопка',
        ],
        history: 'Первый такой блок — будет с чем сравнивать',
      },
    });
  });

  it('the staircase runs on the penalised score; «Успешно» keeps the share of successes', async () => {
    const repo = await calibratedRepo(stateWith('szmr', { lSaved: 4, lastTrainedAt: T0, lifetimeBlocks: 3 }));
    const h = await begin(planFree('szmr', 1), { repo });
    h.c.ackInstruction();
    const block = expectStep(h.c, 'reaction_block');
    expect(block.specs).toHaveLength(20);
    const otherKey = (key: InputKey): InputKey => block.keys.find((k) => k !== key) as InputKey;
    // Trial 0: a press 50 ms before its onset (a false start); trials 1 and 2: the other key; the rest: hits at 300 ms.
    const respond: Respond = (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      if (r === null) throw new Error('СЗМР trials are press trials');
      if (idx === 0) return { ...r, rtMs: -50 };
      return idx <= 2 ? { ...r, key: otherKey(r.key) } : r;
    };
    await h.c.submitReaction(playTimeline(block.specs, respond));
    const { view } = expectStep(h.c, 'summary');
    const row = (await repo.listBlocks()).at(-1);
    const summary = JSON.parse(row?.summaryJson ?? '{}') as {
      counts: unknown;
      score: number;
      penalizedScore: number;
      stability: { cvAll: number | null; lapses: number; lapseLimit: number };
    };
    expect(summary.counts).toMatchObject({ hit: 17, wrong: 2, false_start: 1 });
    expect(row?.score).toBeCloseTo(0.65, 12);
    expect(summary.score).toBeCloseTo(0.85, 12);
    expect(summary.penalizedScore).toBeCloseTo(0.65, 12);
    const { cvAll, lapses, lapseLimit } = summary.stability;
    const input = { score: 0.65, calibration: false, prevScoreSameSession: null, firstOfSegment: true, cvAll, lapses, lapseLimit, cvMax: szmr.cvMax, timingUnreliable: false };
    expect(view.lAfter).toBe(nextLevel(view.lBefore, input));
    // The share 0.85 would have raised the level; s 0.65 takes 0.75 off it.
    expect(view.lAfter).toBe(view.lBefore - 0.75);
    expect(view.score).toBe(0.85);
    expect(view.lines[0]).toBe('Ошибки: неверная клавиша — 2, фальстарты — 1. Штраф −4 из 20, балл 0,65.');
  });

  it('the g = 2 rule and fatigue use the penalised score', async () => {
    const repo = await calibratedRepo(stateWith('szmr', { lSaved: 4, lastTrainedAt: T0, lifetimeBlocks: 3 }));
    const h = await begin(planFree('szmr', 1), { repo });
    /** The first `falseStarts` trials answered 50 ms after onset (false starts), the others hit at `rtMs`. */
    const player =
      (falseStarts: number, rtMs: number): Respond =>
      (spec, idx) => {
        const r = perfectPlayer(spec, idx);
        return r === null ? null : { ...r, rtMs: idx < falseStarts ? 50 : rtMs };
      };
    // 19 hits and 1 false start: the share 0.95 would give the next block g = 2; s 0.85 does not.
    const first = await playReaction(h, player(1, 300));
    expect(first.view.score).toBe(0.95);
    expect(first.view.lines[0]).toBe('Ошибки: неверная клавиша — 0, фальстарты — 1. Штраф −2 из 20, балл 0,85.');
    // The first block of the segment: g = 1 on the penalised s 0.85 (below 0.9), although the share is 0.95.
    expect(first.view.lAfter - first.view.lBefore).toBe(0.25);
    await h.c.continueAfterSummary();
    const second = await playReaction(h, player(0, 300));
    expect(second.view.lBefore).toBe(first.view.lAfter);
    expect(second.view.lAfter - second.view.lBefore).toBe(1);
    // Then 2 blocks at 400 ms with 2 false starts each: share 0.9, s 0.7. Against the first two blocks s fell by
    // 0.925 − 0.7 = 0.225 ≥ 0.15 (the share only by 0.975 − 0.9 = 0.075), and the median RT rose by a third: fatigue.
    await h.c.continueAfterSummary();
    await playReaction(h, player(2, 400));
    await h.c.continueAfterSummary();
    const fourth = await playReaction(h, player(2, 400));
    expect(fourth.view.score).toBe(0.9);
    await h.c.continueAfterSummary();
    expect(h.c.step).toEqual({ kind: 'fatigue_prompt', module: 'szmr' });
  });

  it('stroop block stores conditions and shows the interference line', async () => {
    const h = await begin(planFree('stroop', 4));
    const slowerOnIncongruent: Respond = (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      return r !== null && spec.cond === 'incongruent' ? { ...r, rtMs: r.rtMs + 80 } : r;
    };
    const { view } = await playReaction(h, slowerOnIncongruent);
    expect(view.title).toBe('Струп');
    expect(view.lines[0]).toBe('Ошибок нет.');
    expect(view.lines.slice(-3)).toEqual(['Цвет совпадает со словом: 300 мс', 'Не совпадает: 380 мс', 'Интерференция: +80 мс']);
    const [row] = await h.repo.listBlocks();
    const summary = JSON.parse(row?.summaryJson ?? '{}') as { conditions?: unknown; frameMs?: unknown };
    expect(summary.conditions).toEqual({
      congruent: { n: 10, errors: 0, medianRt: 300 },
      incongruent: { n: 10, errors: 0, medianRt: 380 },
    });
    expect(summary).toHaveProperty('frameMs', null);
    const trials = await h.repo.listTrials(row?.id ?? '');
    expect(trials.map((t) => (JSON.parse(t.stimulusJson) as { cond?: unknown }).cond).sort()).toEqual([
      ...Array<string>(10).fill('congruent'),
      ...Array<string>(10).fill('incongruent'),
    ]);
  });

  it('taskswitch block shows the switch cost', async () => {
    const h = await begin(planFree('taskswitch', 4));
    const slowerOnSwitch: Respond = (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      return r !== null && spec.cond === 'switch' ? { ...r, rtMs: r.rtMs + 150 } : r;
    };
    const { view } = await playReaction(h, slowerOnSwitch);
    expect(view.title).toBe('Переключение правил');
    expect(view.lines[0]).toBe('Ошибок нет.');
    expect(view.lines.slice(-3)).toEqual(['Правило повторяется: 300 мс', 'Правило сменилось: 450 мс', 'Цена переключения: +150 мс']);
    const [row] = await h.repo.listBlocks();
    // L = 0: 20 trials, the first without a condition, round(0.2 · 19) = 4 switches.
    expect((JSON.parse(row?.summaryJson ?? '{}') as { conditions?: unknown }).conditions).toEqual({
      repeat: { n: 15, errors: 0, medianRt: 300 },
      switch: { n: 4, errors: 0, medianRt: 450 },
    });
    const trials = await h.repo.listTrials(row?.id ?? '');
    const first = JSON.parse(trials[0]?.stimulusJson ?? '{}') as { cueLeadMs?: unknown; cond?: unknown };
    expect(first).toMatchObject({ cueLeadMs: 900 });
    expect(first).not.toHaveProperty('cond');
  });

  it('pomeh block shows quiet and noisy medians', async () => {
    const h = await begin(planFree('pomeh', 4));
    const slowerOnNoisy: Respond = (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      return r !== null && spec.cond === 'noisy' ? { ...r, rtMs: r.rtMs + 35 } : r;
    };
    const { view } = await playReaction(h, slowerOnNoisy);
    expect(view.title).toBe('Помехоустойчивость');
    expect(view.lines[0]).toBe('Ошибок нет.');
    expect(view.lines.slice(-3)).toEqual(['Без помех: 300 мс', 'С помехами: 335 мс', 'Разница: +35 мс']);
    expect(view.lines).not.toContain(AUDIO_NOT_PLAYED);
    const [row] = await h.repo.listBlocks();
    const summary = JSON.parse(row?.summaryJson ?? '{}') as { conditions?: Record<string, { n: number }> };
    expect(summary.conditions).toMatchObject({ quiet: { errors: 0, medianRt: 300 }, noisy: { errors: 0, medianRt: 335 } });
    expect((summary.conditions?.quiet?.n ?? 0) + (summary.conditions?.noisy?.n ?? 0)).toBe(20);
    expect(summary).not.toHaveProperty('audioPlayed');
  });

  it('a block with sound that did not play says so', async () => {
    const repo = new MemoryRepository();
    await repo.saveModuleState(stateWith('pomeh', { lSaved: 19, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    const h = await begin(planFree('pomeh', 4), { repo });
    h.c.ackInstruction();
    const block = expectStep(h.c, 'reaction_block');
    expect(block).toMatchObject({ L: 18, layers: { audio: { layers: ['hum', 'beeps'], gain: 0.6 }, gate: 'noisy' } });
    await h.c.submitReaction({ ...playTimeline(block.specs, perfectPlayer), audioPlayed: false });
    const { view } = expectStep(h.c, 'summary');
    expect(view.lines.at(-1)).toBe(AUDIO_NOT_PLAYED);
    // The level follows the visible task as usual.
    expect(view.score).toBe(1);
    expect(view.lAfter).toBeGreaterThan(view.lBefore);
    const [row] = await h.repo.listBlocks();
    expect(JSON.parse(row?.summaryJson ?? '{}')).toHaveProperty('audioPlayed', false);

    await h.c.continueAfterSummary();
    if (h.c.step.kind === 'instruction') h.c.ackInstruction();
    const next = expectStep(h.c, 'reaction_block');
    await h.c.submitReaction({ ...playTimeline(next.specs, perfectPlayer), audioPlayed: true });
    expect(expectStep(h.c, 'summary').view.lines).not.toContain(AUDIO_NOT_PLAYED);
    expect(JSON.parse((await h.repo.listBlocks())[1]?.summaryJson ?? '{}')).toHaveProperty('audioPlayed', true);
  });

  it('reaction blocks without conditions store an empty conditions object and no condition lines', async () => {
    const h = await begin(planFree('pzmr', 1));
    const { view } = await playReaction(h);
    expect(view.lines.some((l) => l.startsWith('Интерференция'))).toBe(false);
    const [row] = await h.repo.listBlocks();
    expect((JSON.parse(row?.summaryJson ?? '{}') as { conditions?: unknown }).conditions).toEqual({});
  });

  it('the CV cap lifts the level by 0.5 and says so after the errors line', async () => {
    // A first block ever (calibration, g = 2): s = 1 would give +2. Answers alternate 250 and 450 ms: CV_all 0.293.
    const h = await begin(planFree('szmr', 1));
    const { view } = await playReaction(h, (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      return r === null ? null : { ...r, rtMs: idx % 2 === 0 ? 250 : 450 };
    });
    expect(view.score).toBe(1);
    expect(view.lBefore).toBe(0);
    expect(view.lAfter).toBe(0.5);
    expect(view.lines[0]).toBe('Ошибок нет.');
    expect(view.lines[1]).toBe('Уровень повышен только на 0,5: разброс 29,3 % при пороге 22 %.');
    expect(view.lines).toContain('Стабильность (CV): 0,29');
    const { stability } = storedSummary(await h.repo.listBlocks());
    expect(stability).toEqual({ cvAll: expect.closeTo(0.29314, 5) as number, lapses: 0, lapseLimit: 2, cvMax: 0.22, held: true, cap: 0.5 });
  });

  it('lapses hold the level', async () => {
    const repo = await calibratedRepo(stateWith('szmr', { lSaved: 4, lastTrainedAt: T0, lifetimeBlocks: 3 }));
    const h = await begin(planFree('szmr', 1), { repo });
    // 17 answers at 300 ms and 3 misses: s 0.85 would give +0.25; 3 lapses reach the limit of 2 and hold it.
    const { view } = await playReaction(h, (spec, idx) => (idx < 3 ? null : perfectPlayer(spec, idx)));
    expect(view.score).toBe(0.85);
    expect(view.lAfter).toBe(view.lBefore);
    expect(view.lines[1]).toBe('Уровень не повышен: провалов 3 (пропуск или ответ дольше 1,5 медианы), допускается 1.');
    expect(storedSummary(await repo.listBlocks()).stability).toEqual({ cvAll: 0, lapses: 3, lapseLimit: 2, cvMax: 0.22, held: true, cap: 0 });
  });

  it('no stability line when the rule did not lower the step', async () => {
    const repo = await calibratedRepo(stateWith('szmr', { lSaved: 4, lastTrainedAt: T0, lifetimeBlocks: 3 }));
    const h = await begin(planFree('szmr', 1), { repo });
    const hasLine = (v: BlockSummaryView): boolean => v.lines.some((l) => l.startsWith('Уровень '));
    /** Answers alternate 250 and 450 ms (CV_all 0.29); `wrong` trials get the other key, `missed` ones none. */
    const uneven =
      (wrong: (idx: number) => boolean, missed: (idx: number) => boolean): Respond =>
      (spec, idx) => {
        const r = perfectPlayer(spec, idx);
        if (r === null || missed(idx)) return null;
        const key = wrong(idx) ? (expectStep(h.c, 'reaction_block').keys.find((k) => k !== r.key) as InputKey) : r.key;
        return { key, rtMs: idx % 2 === 0 ? 250 : 450 };
      };
    // s 0.8 and below: no rule, whatever the spread and the lapses. The segment's first block, so the next is not.
    const weak = await playReaction(
      h,
      uneven(() => false, (idx) => idx % 5 === 0),
    );
    expect(weak.view.score).toBe(0.8);
    expect(hasLine(weak.view)).toBe(false);
    expect(storedSummary(await repo.listBlocks()).stability).toMatchObject({ lapses: 4, held: false, cap: null });
    // s 0.9 (one wrong key) gives +0.5: the CV cap fires but lowers nothing.
    await h.c.continueAfterSummary();
    const capped = await playReaction(
      h,
      uneven((idx) => idx === 0, () => false),
    );
    expect(capped.view.lAfter - capped.view.lBefore).toBe(0.5);
    expect(hasLine(capped.view)).toBe(false);
    expect(storedSummary(await repo.listBlocks()).stability).toMatchObject({ lapses: 0, held: false, cap: 0.5 });
    // s 1, every answer at 300 ms: the rule does not fire.
    await h.c.continueAfterSummary();
    const steady = await playReaction(h);
    expect(steady.view.lAfter - steady.view.lBefore).toBe(1);
    expect(hasLine(steady.view)).toBe(false);
    expect(storedSummary(await repo.listBlocks()).stability).toMatchObject({ cvAll: 0, held: false, cap: null });
  });

  it('a late answer enters CV_all: the CV line shows it and the rule uses it (Р6)', async () => {
    const repo = await calibratedRepo(stateWith('szmr', { lSaved: 4, lastTrainedAt: T0, lifetimeBlocks: 3 }));
    const h = await begin(planFree('szmr', 1), { repo });
    h.c.ackInstruction();
    const block = expectStep(h.c, 'reaction_block');
    // Trial 5 gets no answer in its window, then the right key 300 ms after it: a late answer, before trial 6.
    const tl = playTimeline(block.specs, (spec, idx) => (idx === 5 ? null : perfectPlayer(spec, idx)));
    const late = block.specs[5];
    if (late?.expected.kind !== 'press') throw new Error('СЗМР trials are press trials');
    const lateTs = (tl.onsets[5] as number) + late.windowMs + 300;
    expect(lateTs).toBeLessThan(tl.onsets[6] as number);
    await h.c.submitReaction({ ...tl, presses: [...tl.presses, { key: late.expected.key, ts: lateTs }] });
    const { view } = expectStep(h.c, 'summary');
    const stored = storedSummary(await repo.listBlocks());
    expect(stored.cvRt).toBe(0);
    expect(stored.stability.cvAll).toBeGreaterThan(0.22);
    expect(view.lines).toContain(`Стабильность (CV): ${stored.stability.cvAll.toFixed(2).replace('.', ',')}`);
    // s 0.95 (+0.75) capped at +0.5 by the spread of that one slow answer; it is 1 lapse, below the limit of 2.
    expect(stored.stability).toMatchObject({ lapses: 1, held: true, cap: 0.5 });
    expect(view.lAfter - view.lBefore).toBe(0.5);
  });

  it('segment starts at startLevel(lSaved, days since last training)', async () => {
    const at = async (lastTrainedAt: string | null, lSaved: number): Promise<number> => {
      const repo = new MemoryRepository();
      await repo.saveModuleState(stateWith('gonogo', { lSaved, lastTrainedAt, lifetimeBlocks: lastTrainedAt ? 9 : 0 }));
      const h = await begin(planFree('gonogo', 1), { repo });
      h.c.ackInstruction();
      return expectStep(h.c, 'reaction_block').L;
    };
    expect(await at(new Date(new Date(T0).getTime() - 2 * DAY).toISOString(), 10)).toBe(9);
    expect(await at(new Date(new Date(T0).getTime() - 6 * DAY).toISOString(), 10)).toBe(8);
    expect(await at(new Date(new Date(T0).getTime() - 20 * DAY).toISOString(), 10)).toBe(7);
    expect(await at(new Date(new Date(T0).getTime() + 3 * DAY).toISOString(), 10)).toBe(9); // clock went back
    expect(await at(null, 0)).toBe(0);
    expect(await at(new Date(T0).toISOString(), 0.5)).toBe(0);
  });

  it('days since the last training come from lastTrainedAt: 5 days → −2', async () => {
    const daysAgo = (d: number): string => new Date(new Date(T0).getTime() - d * DAY).toISOString();
    const repo = new MemoryRepository();
    await repo.createSession(session('s5', daysAgo(5), { endedAt: daysAgo(5) }));
    for (let i = 0; i < 3; i++) await repo.addBlock(block(`n${String(i)}`, 's5', daysAgo(5), { module: 'gonogo', lBefore: 10, lAfter: 10, paramsJson: bandParams(10) }), [], []);
    // An overload block yesterday is not training of the level: the break is still 5 days.
    await repo.createSession(session('s1', daysAgo(1), { endedAt: daysAgo(1) }));
    await repo.addBlock(block('o', 's1', daysAgo(1), { module: 'gonogo', lBefore: 13, lAfter: 14, flags: ['overload'] }), [], []);
    const state = deriveModuleStates(await repo.listSessions(), await repo.listBlocks()).gonogo;
    expect(state).toMatchObject({ lSaved: 10, lastTrainedAt: daysAgo(5) });
    await repo.saveModuleState(state);
    const h = await begin(planFree('gonogo', 1), { repo });
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block').L).toBe(8);
  });

  it('the first block of a segment gets g = 2 at s ≥ 0.9', async () => {
    const repo = await calibratedRepo(stateWith('pzmr', { lSaved: 6, lastTrainedAt: T0, lifetimeBlocks: 3 }));
    const h = await begin(planFree('pzmr', 1), { repo });
    const { view } = await playReaction(h);
    expect(view).toMatchObject({ lBefore: 5, lAfter: 7, flags: [] });
  });

  it('the first-block boost is only for a segment that started with the start drop (T-R36)', async () => {
    const repo = await calibratedRepo(stateWith('pzmr', { lSaved: 6, lastTrainedAt: T0, lifetimeBlocks: 3 }));
    const h = await begin({ kind: 'free', seed: 3, segments: [segment('pzmr', 1), segment('rdo', 1), segment('pzmr', 1)] }, { repo });
    // One miss: s 14/15 is below 0.95, so the previous-score rule gives the later block nothing.
    const first = await playReaction(h, (spec, idx) => (idx === 0 ? null : perfectPlayer(spec, idx)));
    expect(first.view.lBefore).toBe(5);
    h.clock.advance(1);
    await h.c.continueAfterSummary();
    await playReaction(h);
    h.clock.advance(1);
    await h.c.continueAfterSummary();
    // The module comes back at its level in the session, without a drop: s 1.0 gets g = 1.
    const again = await playReaction(h);
    expect(again.view.lBefore).toBe(first.view.lAfter);
    expect(again.view.lAfter - again.view.lBefore).toBe(1);
  });

  it('calibration covers the first 3 blocks of a module ever', async () => {
    const repo = await calibratedRepo(stateWith('pzmr', { lSaved: 4, lastTrainedAt: T0, lifetimeBlocks: 1 }), 1);
    const h = await begin(planFree('pzmr', 1), { repo });
    const flags: string[][] = [];
    for (let i = 0; i < 3; i++) {
      flags.push((await playReaction(h)).view.flags);
      await h.c.continueAfterSummary();
    }
    expect(flags).toEqual([['calibration'], ['calibration'], []]);
  });

  it('blocks persist before session end', async () => {
    const h = await begin(planFree('gonogo', 1));
    await playReaction(h);
    await h.c.continueAfterSummary();
    await playReaction(h);
    expect(await h.repo.listBlocks()).toHaveLength(2);
    const [session] = await h.repo.listSessions();
    expect(session?.endedAt).toBeNull();
  });

  it('writes block, trial rows and params as JSON', async () => {
    const h = await begin(planFree('pzmr', 9));
    h.c.ackInstruction();
    const block = expectStep(h.c, 'reaction_block');
    const tl = playTimeline(block.specs, perfectPlayer);
    await h.c.submitReaction(tl);
    const [row] = await h.repo.listBlocks();
    if (!row) throw new Error('no block');
    expect(row).toMatchObject({ sessionId: h.c.sessionId, module: 'pzmr', lBefore: 0, lAfter: 2, score: 1, flags: ['calibration'] });
    expect(JSON.parse(row.paramsJson)).toEqual({ ...pzmr.params(0), layout: 'keyboard', nominalWindowMs: 1000, floorMs: null });
    expect(JSON.parse(row.summaryJson)).toMatchObject({ n: 15, score: 1, medianRt: 300 });
    const trials = await h.repo.listTrials(row.id);
    expect(trials).toHaveLength(15);
    expect(trials[0]).toMatchObject({
      idx: 0,
      onsetTs: tl.onsets[0],
      responseTs: (tl.onsets[0] ?? 0) + 300,
      rtMs: 300,
      outcome: 'hit',
      frameDropped: false,
    });
    expect(JSON.parse(trials[0]?.stimulusJson ?? '')).toEqual(block.specs[0]);
    expect(JSON.parse(trials[0]?.responseJson ?? '')).toEqual({ key: 'Space', rtMs: 300, errorMs: null, outcome: 'hit', practice: false, kind: 'press' });
  });

  it('reaction summaryJson carries the block frame interval', async () => {
    const h = await begin(planFree('pzmr', 9));
    const frameMsOf = async (): Promise<unknown[]> =>
      (await h.repo.listBlocks()).map((b) => (JSON.parse(b.summaryJson) as { frameMs?: unknown }).frameMs);
    h.c.ackInstruction();
    const first = expectStep(h.c, 'reaction_block');
    await h.c.submitReaction({ ...playTimeline(first.specs, perfectPlayer), frameMs: 8.333 });
    expect(await frameMsOf()).toEqual([8.333]);
    h.clock.advance(30_000);
    await h.c.continueAfterSummary();
    if (h.c.step.kind === 'instruction') h.c.ackInstruction();
    const second = expectStep(h.c, 'reaction_block');
    await h.c.submitReaction(playTimeline(second.specs, perfectPlayer));
    expect(await frameMsOf()).toEqual([8.333, null]);
  });

  it('training block seeds: deriveSeed(plan.seed, segment:block:attempt)', async () => {
    const h = await begin(planFree('pzmr', 77));
    h.c.ackInstruction();
    const gen = (salt: string, L: number): unknown => pzmr.generateBlock(pzmr.params(L), createRng(deriveSeed(77, salt)), 'keyboard', 15);
    expect(unjittered(expectStep(h.c, 'reaction_block').specs)).toEqual(gen('0:0:0', 0));
    await h.c.discardBlock('focus_lost', 0.5);
    expect(unjittered(expectStep(h.c, 'reaction_block').specs)).toEqual(gen('0:0:1', 0));
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    await h.c.continueAfterSummary();
    expect(unjittered(expectStep(h.c, 'reaction_block').specs)).toEqual(gen('0:1:0', 2));
  });

  it('discardBlock keeps level and writes nothing', async () => {
    const h = await begin(planFree('szmr', 5));
    await playReaction(h);
    await h.c.continueAfterSummary();
    const before = expectStep(h.c, 'reaction_block');
    const blocksBefore = await h.repo.listBlocks();
    const stateBefore = await h.repo.getModuleStates();
    expect(await h.c.discardBlock('focus_lost', 0.9)).toEqual({ kind: 'restarted' });
    const after = expectStep(h.c, 'reaction_block');
    expect(after.module).toBe('szmr');
    expect(after.L).toBe(before.L);
    expect(after.specs).not.toEqual(before.specs);
    expect(await h.repo.listBlocks()).toEqual(blocksBefore);
    expect(await h.repo.getModuleStates()).toEqual(stateBefore);
    expect(h.c.discards).toEqual([{ module: 'szmr', reason: 'focus_lost' }]);
    // The replacement counts as the same block: its result moves the level once.
    await h.c.submitReaction(playTimeline(after.specs, perfectPlayer));
    expect(expectStep(h.c, 'summary').view.lBefore).toBe(before.L);
    expect(await h.repo.listBlocks()).toHaveLength(2);
  });

  it('discardBlock works for tables and number series too', async () => {
    const t = await begin(planFree('schulte', 5));
    t.c.ackInstruction();
    const table = expectStep(t.c, 'table_block');
    expect(await t.c.discardBlock('user', 0.3)).toEqual({ kind: 'restarted' });
    expect(t.c.discards).toEqual([{ module: 'schulte', reason: 'user' }]);
    const again = expectStep(t.c, 'table_block');
    expect(again.seed).not.toBe(table.seed);
    expect(again.L).toBe(table.L);

    const n = await begin(planFree('numseries', 5));
    n.c.ackInstruction();
    const items = expectStep(n.c, 'numseries_block').items;
    expect(await n.c.discardBlock('error', 0.9, [])).toEqual({ kind: 'restarted' });
    expect(expectStep(n.c, 'numseries_block').items).not.toEqual(items);
    expect(await n.repo.listBlocks()).toEqual([]);
  });

  it('timing_unreliable block does not change L', async () => {
    const state = stateWith('pzmr', { lSaved: 10, lastTrainedAt: T0, lifetimeBlocks: 3, sessionEndLevels: [10], savedHistory: [10] });
    const repo = await calibratedRepo(state);
    const h = await begin(planFree('pzmr', 1), { repo });
    const unreliable = await playReaction(h, perfectPlayer, (idx) => idx < 2); // 2 of 15 onsets dropped > 5 %
    expect(unreliable.view.flags).toEqual(['timing_unreliable']);
    expect(unreliable.view.lBefore).toBe(9);
    expect(unreliable.view.lAfter).toBe(9);
    // Module state is re-derived from history: the block counts, but gives no session-end level.
    expect((await h.repo.getModuleStates()).pzmr).toMatchObject({ lifetimeBlocks: 4, sessionEndLevels: [10], lSaved: 10 });

    // The unreliable s = 1 does not count as the previous score, and it measured nothing, so it does not use up the
    // segment's first-block boost (T-R35): the next block, s 14/15 ≥ 0.9, gets g = 2 as the first one.
    await h.c.continueAfterSummary();
    const next = await playReaction(h, (spec, idx) => (idx === 0 ? null : perfectPlayer(spec, idx)));
    expect(next.view.score).toBeCloseTo(14 / 15, 12);
    expect(next.view.lAfter).toBeCloseTo(9 + (2 * (14 / 15 - 0.8)) / 0.2, 9);
    // That block was stored: the one after it is not the first any more (s 14/15 again, g = 1).
    await h.c.continueAfterSummary();
    const third = await playReaction(h, (spec, idx) => (idx === 0 ? null : perfectPlayer(spec, idx)));
    expect(third.view.lAfter - third.view.lBefore).toBeCloseTo((14 / 15 - 0.8) / 0.2, 9);
  });

  it('state writes never read the whole block history (R26); it is read once at session start (О11)', async () => {
    const repo = new SpyRepo();
    const clock = new Clock();
    for (let day = 0; day < 2; day++) {
      const plan = firstDayPlan(await repo.getModuleStates(), clock.now().toISOString(), 42 + day);
      const h = await begin(plan, { repo, clock });
      const atStart = repo.listBlocksCalls;
      await drive(h, { blockMs: 150_000 });
      expect(repo.listBlocksCalls).toBe(atStart);
      clock.advance(DAY);
    }
    expect(repo.listBlocksCalls).toBe(2);
    expect(await repo.getModuleStates()).toEqual(deriveModuleStates(await repo.listSessions(), await repo.listBlocks()));
    expect(await repo.getRatings()).toEqual(deriveRatings(await repo.listLogicItems()));
  });

  it('a block with nothing to score is played again without a write (summary.n === 0)', async () => {
    const real = pzmr.generateBlock.bind(pzmr);
    const spy = vi
      .spyOn(pzmr, 'generateBlock')
      .mockImplementationOnce((p, rng, layout, size) => real(p, rng, layout, size).map((t) => ({ ...t, practice: true })));
    try {
      const h = await begin(planFree('pzmr', 1));
      h.c.ackInstruction();
      const onlyPractice = expectStep(h.c, 'reaction_block');
      expect(onlyPractice.specs.every((t) => t.practice === true)).toBe(true);
      await h.c.submitReaction(playTimeline(onlyPractice.specs, perfectPlayer));
      const again = expectStep(h.c, 'reaction_block');
      expect(again.L).toBe(0);
      expect(unjittered(again.specs)).toEqual(real(pzmr.params(0), createRng(deriveSeed(1, '0:0:1')), 'keyboard', 15));
      expect(h.c.discards).toEqual([{ module: 'pzmr', reason: 'error' }]);
      expect(await h.repo.listBlocks()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('two consecutive start() calls in the same day are independent sessions; state reflects both', async () => {
    const repo = new MemoryRepository();
    const clock = new Clock();
    const a = await begin(planFree('pzmr', 1), { repo, clock });
    await drive(a, { blockMs: 150_000 });
    const afterA = (await repo.getModuleStates()).pzmr;
    expect(afterA.lifetimeBlocks).toBe(2);

    clock.advance(30 * MIN);
    const b = await begin(planFree('pzmr', 2), { repo, clock });
    expect(b.c.sessionId).not.toBe(a.c.sessionId);
    b.c.ackInstruction();
    expect(expectStep(b.c, 'reaction_block').L).toBe(Math.max(0, afterA.lSaved - 1));
    await drive(b, { blockMs: 150_000 });

    const sessions = await repo.listSessions();
    expect(sessions.map((s) => s.id)).toEqual([a.c.sessionId, b.c.sessionId]);
    expect(sessions.every((s) => s.endedAt !== null)).toBe(true);
    const st = (await repo.getModuleStates()).pzmr;
    expect(st.lifetimeBlocks).toBe(4);
    expect(st.sessionEndLevels).toHaveLength(2);
    expect(st.savedHistory).toHaveLength(2);
  });

  it('a module that comes back later in the session continues from its current level', async () => {
    const h = await begin({ kind: 'free', seed: 3, segments: [segment('pzmr', 1), segment('rdo', 1), segment('pzmr', 1)] });
    const first = await playReaction(h);
    h.clock.advance(1);
    await h.c.continueAfterSummary();
    await playReaction(h);
    h.clock.advance(1);
    await h.c.continueAfterSummary();
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block').L).toBe(first.view.lAfter);
  });
});

describe('SessionController — warm-up and the form of the day (F5)', () => {
  const daysAgo = (d: number): string => new Date(new Date(T0).getTime() - d * DAY).toISOString();
  const warmup = (minutes: number): Segment => ({ module: 'pzmr', budgetMs: minutes * MIN, purpose: 'warmup' });
  const training = (...segments: Segment[]): SessionPlan => ({ kind: 'training', seed: 1, phase: 'base', segments });
  /** Plays the blocks of the segment on screen, `blockMs` each, until it is over (its level never changes the instruction). */
  async function playSegment(h: Harness, respond: Respond = perfectPlayer, blockMs = 30_000): Promise<BlockSummaryView[]> {
    const views: BlockSummaryView[] = [];
    do {
      views.push((await playReaction(h, respond)).view);
      h.clock.advance(blockMs);
      await h.c.continueAfterSummary();
    } while (h.c.step.kind === 'reaction_block');
    return views;
  }
  /** A finished training session `d` days ago with these blocks. */
  async function pastTraining(repo: Repository, id: string, d: number, blocks: Partial<BlockRow>[]): Promise<void> {
    await repo.createSession(session(id, daysAgo(d), { endedAt: daysAgo(d) }));
    for (const [i, over] of blocks.entries()) await repo.addBlock(block(`${id}b${String(i)}`, id, daysAgo(d), over), [], []);
  }

  it('the warm-up plays every block at L_saved − 1 and moves nothing', async () => {
    const repo = new MemoryRepository();
    await pastTraining(repo, 's0', 1, [{ module: 'pzmr', lBefore: 6, lAfter: 6 }]);
    const before = deriveModuleStates(await repo.listSessions(), await repo.listBlocks()).pzmr;
    expect(before).toMatchObject({ lSaved: 6, lastTrainedAt: daysAgo(1), lifetimeBlocks: 1 });
    await repo.saveModuleState(before);
    const h = await begin(training(warmup(2)), { repo });
    const views = await playSegment(h);
    expect(h.c.step.kind).toBe('wellbeing');
    expect(views).toHaveLength(4);
    for (const view of views) {
      expect(view).toMatchObject({ lBefore: 5, lAfter: 5, flags: ['warmup'], showLevel: false, levelNote: WARMUP_LEVEL_NOTE });
      expect(view.lines[1]).toBe('Форма дня: мало данных — нужно 3 разминки за 14 дней на этой нагрузке.');
    }
    const rows = (await repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId);
    expect(rows.map((b) => [b.lBefore, b.lAfter, b.flags])).toEqual(Array(4).fill([5, 5, ['warmup']]));
    expect((await repo.getModuleStates()).pzmr).toMatchObject({ lSaved: 6, lastTrainedAt: daysAgo(1), lifetimeBlocks: 5 });
  });

  it('the form of the day compares with three earlier warm-up days on the same band', async () => {
    const repo = new MemoryRepository();
    const summaryJson = JSON.stringify({ meanRt: 300, cleanHitRts: [290, 300, 310] });
    for (const d of [1, 2, 3]) await pastTraining(repo, `s${String(d)}`, d, [{ module: 'pzmr', lBefore: 5, lAfter: 5, flags: ['warmup'], summaryJson }]);
    await repo.saveModuleState(stateWith('pzmr', { lSaved: 6, lastTrainedAt: daysAgo(1), lifetimeBlocks: 10 }));
    const h = await begin(training(warmup(2)), { repo });
    const { view } = await playReaction(h);
    expect(view.lBefore).toBe(5);
    expect(view.lines[1]).toBe('Форма дня: медиана 300 мс (обычно 300) · разброс 0 мс (обычно 10) — как обычно.');
  });

  it('the form of the day adds up today’s warm-ups once each, and is left out when the history could not be read (Р18)', async () => {
    const repo = new MemoryRepository();
    const summaryJson = JSON.stringify({ meanRt: 300, cleanHitRts: [300, 300, 300] });
    for (const d of [1, 2, 3]) await pastTraining(repo, `s${String(d)}`, d, [{ module: 'pzmr', lBefore: 5, lAfter: 5, flags: ['warmup'], summaryJson }]);
    await repo.saveModuleState(stateWith('pzmr', { lSaved: 6, lastTrainedAt: daysAgo(1), lifetimeBlocks: 10 }));
    const h = await begin(training(warmup(2)), { repo });
    // 300 ms, then 340 ms: today's median is 300 after the first block, 320 after the second (15 + 15 RTs; a block
    // counted twice would keep it at 300).
    const first = await playReaction(h, (spec, idx) => perfectPlayer(spec, idx));
    expect(first.view.lines[1]).toMatch(/^Форма дня: медиана 300 мс \(обычно 300\)/);
    h.clock.advance(30_000);
    await h.c.continueAfterSummary();
    const at340: Respond = (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      return r === null ? null : { ...r, rtMs: 340 };
    };
    const second = await playReaction(h, at340);
    expect(second.view.lines[1]).toBe('Форма дня: медиана 320 мс (обычно 300) · разброс 20 мс (обычно 0) — хуже обычного.');

    vi.spyOn(repo, 'listBlocks').mockRejectedValueOnce(new Error('disk I/O error'));
    const unread = await begin(training(warmup(2)), { repo });
    const { view } = await playReaction(unread);
    expect(view.levelNote).toBe(WARMUP_LEVEL_NOTE);
    expect(view.lines.some((l) => l.startsWith('Форма дня'))).toBe(false);
  });

  it('every reaction summary keeps cleanHitRts rounded to 0.1 ms', async () => {
    const h = await begin(planFree('pzmr', 1));
    const rtOf = (idx: number): number => 300 + 0.123 * idx;
    h.c.ackInstruction();
    const step = expectStep(h.c, 'reaction_block');
    const respond: Respond = (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      return r === null ? null : { ...r, rtMs: rtOf(idx) };
    };
    await h.c.submitReaction(playTimeline(step.specs, respond));
    const expected = step.specs.flatMap((t, idx) => (t.practice === true ? [] : [Math.round(10 * rtOf(idx)) / 10]));
    expect(expected).toHaveLength(15);
    const [row] = await h.repo.listBlocks();
    expect((JSON.parse(row?.summaryJson ?? '{}') as { cleanHitRts: unknown }).cleanHitRts).toEqual(expected);
    // A diagnostic block keeps them too.
    const d = await begin(planDiagnostic(1));
    await playReaction(d);
    const [diag] = await d.repo.listBlocks();
    expect((JSON.parse(diag?.summaryJson ?? '{}') as { cleanHitRts: unknown[] }).cleanHitRts.length).toBeGreaterThan(0);
  });

  it('a warm-up block is not the previous block for g = 2 and not in fatigue', async () => {
    const repo = await calibratedRepo(stateWith('pzmr', { lSaved: 6, lastTrainedAt: T0, lifetimeBlocks: 3 }));
    const reaction: Segment = { module: 'pzmr', budgetMs: 1, purpose: 'reaction' };
    const h = await begin(training(reaction, warmup(1), reaction), { repo });
    // One miss: s 14/15 is below 0.95.
    const first = await playReaction(h, (spec, idx) => (idx === 0 ? null : perfectPlayer(spec, idx)));
    h.clock.advance(1);
    await h.c.continueAfterSummary();
    const warm = await playSegment(h);
    expect(warm.map((v) => v.score)).toEqual([1, 1]);
    // The third segment comes back at the module's level, so no first-block boost; the warm-up's s 1.0 is not the
    // previous score either: g = 1.
    const after = await playReaction(h);
    expect(after.view.lBefore).toBe(first.view.lAfter);
    expect(after.view.lAfter - after.view.lBefore).toBe(1);

    // Fatigue: two fast perfect warm-up blocks and two slow ones with false starts would be fatigue if the warm-up
    // counted; the reaction blocks alone are even.
    const fresh = await begin(training(warmup(1), { module: 'pzmr', budgetMs: 5 * MIN, purpose: 'reaction' }));
    await playSegment(fresh);
    const slow: Respond = (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      return r === null ? null : { ...r, rtMs: idx < 1 ? 50 : 400 };
    };
    for (let i = 0; i < 2; i++) {
      await playReaction(fresh, slow);
      fresh.clock.advance(30_000);
      await fresh.c.continueAfterSummary();
    }
    expect(fresh.c.step.kind).toBe('reaction_block');
  });

  it('warm-up blocks are not calibration blocks and do not use up the calibration of a new module (T-R11)', async () => {
    const h = await begin(training(warmup(1), { module: 'pzmr', budgetMs: 5 * MIN, purpose: 'reaction' }));
    const warm = await playSegment(h);
    expect(warm.map((v) => v.flags)).toEqual([['warmup'], ['warmup']]);
    const flags: string[][] = [];
    for (let i = 0; i < 4; i++) {
      flags.push((await playReaction(h)).view.flags);
      h.clock.advance(30_000);
      await h.c.continueAfterSummary();
    }
    expect(flags).toEqual([['calibration'], ['calibration'], ['calibration'], []]);
  });

  /** Flags of the first `n` blocks of a 5-minute ПЗМР reaction segment. */
  async function reactionFlags(repo: Repository, n: number): Promise<string[][]> {
    const h = await begin(training({ module: 'pzmr', budgetMs: 5 * MIN, purpose: 'reaction' }), { repo });
    const flags: string[][] = [];
    for (let i = 0; i < n; i++) {
      flags.push((await playReaction(h)).view.flags);
      h.clock.advance(30_000);
      await h.c.continueAfterSummary();
    }
    return flags;
  }

  it('warm-ups of earlier sessions do not use up the calibration either (T-R38)', async () => {
    const repo = new MemoryRepository();
    const warm: Partial<BlockRow> = { module: 'pzmr', lBefore: 0, lAfter: 0, flags: ['warmup'] };
    await pastTraining(repo, 's0', 2, [warm, warm, warm]);
    await pastTraining(repo, 's1', 1, [warm, warm]);
    const state = deriveModuleStates(await repo.listSessions(), await repo.listBlocks()).pzmr;
    expect(state.lifetimeBlocks).toBe(5);
    await repo.saveModuleState(state);
    expect(await reactionFlags(repo, 4)).toEqual([['calibration'], ['calibration'], ['calibration'], []]);
  });

  it('only level-moving blocks of training and free sessions count; without the history, lifetimeBlocks does (T-R38)', async () => {
    const repo = new MemoryRepository();
    await pastTraining(repo, 's0', 2, [
      { module: 'pzmr', flags: ['warmup'] },
      { module: 'pzmr', flags: ['overload'] },
      { module: 'pzmr', flags: ['calibration'] },
      { module: 'szmr', flags: ['calibration'] },
    ]);
    await repo.createSession(session('d0', daysAgo(1), { kind: 'diagnostic', endedAt: daysAgo(1) }));
    await repo.addBlock(block('d0b0', 'd0', daysAgo(1), { module: 'pzmr' }), [], []);
    await repo.saveModuleState(deriveModuleStates(await repo.listSessions(), await repo.listBlocks()).pzmr);
    expect(await reactionFlags(repo, 3)).toEqual([['calibration'], ['calibration'], []]);

    // The history could not be read: the stored lifetimeBlocks (3 of the training session) stand in.
    vi.spyOn(repo, 'listBlocks').mockRejectedValueOnce(new Error('disk I/O error'));
    expect(await reactionFlags(repo, 1)).toEqual([[]]);
  });

  it('a first-ever warm-up plays at level 0 and stays there', async () => {
    const h = await begin(training(warmup(1)));
    const views = await playSegment(h);
    expect(views.map((v) => [v.lBefore, v.lAfter, v.flags])).toEqual([
      [0, 0, ['warmup']],
      [0, 0, ['warmup']],
    ]);
    const rows = await h.repo.listBlocks();
    expect(rows.map((b) => [b.lBefore, b.lAfter])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect((await h.repo.getModuleStates()).pzmr).toMatchObject({ lSaved: 0, lastTrainedAt: null, lifetimeBlocks: 2 });
  });
});

describe('SessionController — the mark after a trial (F15)', () => {
  /** Plays the whole session; returns every reaction block it showed. */
  async function reactionBlocks(h: Harness): Promise<StepOf<'reaction_block'>[]> {
    const seen: StepOf<'reaction_block'>[] = [];
    const submit = h.c.submitReaction.bind(h.c);
    h.c.submitReaction = (timeline) => {
      seen.push(expectStep(h.c, 'reaction_block'));
      return submit(timeline);
    };
    await drive(h, { blockMs: 150_000 });
    return seen;
  }
  const flagsOf = (blocks: readonly StepOf<'reaction_block'>[]): Record<string, (boolean | undefined)[]> => {
    const out: Record<string, (boolean | undefined)[]> = {};
    for (const b of blocks) out[b.module] = [...new Set([...(out[b.module] ?? []), ...b.specs.map((t) => t.feedback)])];
    return out;
  };

  it('training blocks carry the plan rate; the warm-up, a test-format run and РДО carry none', async () => {
    const plan: SessionPlan = {
      kind: 'training',
      seed: 1,
      phase: 'base',
      feedback: 'every',
      segments: [
        { module: 'szmr', budgetMs: 0, purpose: 'test_format', trialCount: DIAGNOSTIC_VOLUME.szmr.trialCount, practiceTrials: 5 },
        { module: 'pzmr', budgetMs: MIN, purpose: 'warmup' },
        { module: 'gonogo', budgetMs: MIN, purpose: 'reaction' },
        { module: 'rdo', budgetMs: MIN, purpose: 'reaction' },
        { module: 'stroop', budgetMs: MIN, purpose: 'finisher', overload: 'finisher' },
      ],
    };
    const blocks = await reactionBlocks(await begin(plan));
    expect(flagsOf(blocks)).toEqual({ szmr: [undefined], pzmr: [undefined], gonogo: [true], rdo: [undefined], stroop: [true] });
    // 'half': both kinds of trials, by the block seed.
    const half = flagsOf(await reactionBlocks(await begin({ ...plan, feedback: 'half' })));
    expect(new Set(half.gonogo)).toEqual(new Set([true, false]));
    expect(half.pzmr).toEqual([undefined]);
    // No rate in the plan (a plan made before F15): none.
    const older: SessionPlan = { kind: plan.kind, seed: plan.seed, segments: plan.segments };
    expect(new Set(Object.values(flagsOf(await reactionBlocks(await begin(older)))).flat())).toEqual(new Set([undefined]));
  });

  it('a free plan of the phase of the day marks its trials; a diagnostic never does, whatever its plan says', async () => {
    expect(flagsOf(await reactionBlocks(await begin(planFree('pomeh', 3, currentPhase({ firstSessionAt: null, today: T0, testDate: null, states: deriveModuleStates([], []) })))))).toEqual({ pomeh: [true] });
    const diagnostic = await reactionBlocks(await begin({ ...planDiagnostic(1), feedback: 'every' }));
    expect(diagnostic.length).toBeGreaterThan(5);
    expect(diagnostic.every((b) => b.specs.every((t) => !('feedback' in t)))).toBe(true);
  });
});

describe('SessionController — test-format runs (F4)', () => {
  const daysAgo = (d: number): string => new Date(new Date(T0).getTime() - d * DAY).toISOString();
  const training = (...segments: Segment[]): SessionPlan => ({ kind: 'training', seed: 1, phase: 'development', segments });
  /** The run of `module` as planTraining makes it. */
  const run = (module: TestFormatId): Segment => ({
    module,
    budgetMs: 0,
    purpose: 'test_format',
    trialCount: DIAGNOSTIC_VOLUME[module].trialCount,
    practiceTrials: 5,
  });
  /** A finished training session `d` days ago with these blocks; then the caches are rebuilt, as at app start. */
  async function pastTraining(repo: MemoryRepository, id: string, d: number, blocks: Partial<BlockRow>[]): Promise<void> {
    await repo.createSession(session(id, daysAgo(d), { endedAt: daysAgo(d) }));
    for (const [i, over] of blocks.entries()) await repo.addBlock(block(`${id}b${String(i)}`, id, daysAgo(d), over), [], []);
    await rebuildCaches(repo);
  }
  const stored = { mean: 250, sd: 30, errors: 1, falseStarts: 0, thirds: [250, 250, 250] };

  it('a test-format run: frozen parameters, one block, the level unchanged', async () => {
    const repo = new MemoryRepository();
    await pastTraining(repo, 's0', 1, [{ module: 'pzmr', lBefore: 6, lAfter: 6, paramsJson: bandParams(6) }]);
    expect((await repo.getModuleStates()).pzmr).toMatchObject({ lSaved: 6, lastTrainedAt: daysAgo(1), lifetimeBlocks: 1 });
    // A budget the run never looks at: one block, then the next segment.
    const h = await begin(training({ ...run('pzmr'), budgetMs: 10 * MIN }, { module: 'szmr', budgetMs: 10 * MIN, purpose: 'reaction' }), { repo });
    expect(expectStep(h.c, 'instruction').text).toBe(testFormatInstruction(50) + reactionModules.pzmr.instruction('keyboard', DIAGNOSTIC_PARAMS.pzmr));
    h.c.ackInstruction();
    const step = expectStep(h.c, 'reaction_block');
    expect(step.L).toBe(6);
    expect([step.specs.length, step.specs.filter((t) => t.practice === true).length]).toEqual([55, 5]);
    expect(new Set(step.specs.map((t) => t.windowMs))).toEqual(new Set([1000]));
    h.clock.advance(MIN);
    await h.c.submitReaction(playTimeline(step.specs, perfectPlayer));
    const { view } = expectStep(h.c, 'summary');
    expect(view).toMatchObject({
      module: 'pzmr',
      title: 'Прогон в формате теста · ПЗМР',
      lBefore: 6,
      lAfter: 6,
      changes: [],
      flags: ['test_format'],
      showLevel: false,
      levelNote: null,
    });
    expect(view.lines).toEqual(['Среднее 300 мс · SD 0 мс · ошибки 0 · фальстарты 0', 'Первый прогон в этом формате: сравнивать пока не с чем.']);
    expect(view.assessment).toMatchObject({ step: null, goal: null, history: null });
    const row = (await repo.listBlocks()).find((b) => b.sessionId === h.c.sessionId);
    expect(row).toMatchObject({ module: 'pzmr', lBefore: 6, lAfter: 6, flags: ['test_format'] });
    expect((JSON.parse(row?.summaryJson ?? '{}') as { testFormat: unknown }).testFormat).toEqual({
      mean: 300,
      sd: 0,
      errors: 0,
      falseStarts: 0,
      thirds: [300, 300, 300],
    });
    expect(JSON.parse(row?.paramsJson ?? '{}')).toEqual({ ...DIAGNOSTIC_PARAMS.pzmr, trials: 50, layout: 'keyboard' });
    await h.c.continueAfterSummary();
    expect(expectStep(h.c, 'instruction').module).toBe('szmr');
    // L_saved and the training date stay; the block counts in lifetimeBlocks.
    expect((await repo.getModuleStates()).pzmr).toMatchObject({ lSaved: 6, lastTrainedAt: daysAgo(1), lifetimeBlocks: 2 });
  });

  it('the personal best comes from earlier runs of the same format', async () => {
    const repo = new MemoryRepository();
    await pastTraining(repo, 's1', 8, [{ module: 'pzmr', lBefore: 6, lAfter: 6, flags: ['test_format'], summaryJson: JSON.stringify({ meanRt: 250, testFormat: stored }) }]);
    // Neither another format's run nor a block that is no run counts.
    await pastTraining(repo, 's2', 4, [
      { module: 'szmr', flags: ['test_format'], summaryJson: JSON.stringify({ testFormat: { ...stored, mean: 200, sd: 5 } }) },
      { module: 'pzmr', lBefore: 6, lAfter: 6, summaryJson: JSON.stringify({ meanRt: 200, testFormat: { ...stored, mean: 100, errors: 0 } }) },
    ]);
    const h = await begin(training(run('pzmr')), { repo });
    const { view } = await playReaction(h);
    expect(view.lines).toEqual([
      'Среднее 300 мс (лучшее 250) · SD 0 мс (лучшее 30) · ошибки 0 (лучшее 1) · фальстарты 0 (лучшее 0)',
      'Новый лучший результат: SD, ошибки',
    ]);
    // One block, then the session goes on (here: to its end).
    await h.c.continueAfterSummary();
    expect(h.c.step.kind).toBe('wellbeing');
  });

  it('without the history read at start a run shows no best and does not call itself the first (Р18)', async () => {
    const repo = new MemoryRepository();
    await pastTraining(repo, 's1', 8, [{ module: 'rdo', flags: ['test_format'], summaryJson: JSON.stringify({ testFormat: stored }) }]);
    vi.spyOn(repo, 'listBlocks').mockRejectedValueOnce(new Error('disk I/O error'));
    const h = await begin(training(run('rdo')), { repo });
    const { view } = await playReaction(h);
    expect(view.title).toBe('Прогон в формате теста · РДО');
    expect(view.lines).toEqual(['Отклонение 0 мс · SD 0 мс · ошибки 0 · фальстарты 0']);
  });

  it('a Go/No-Go run keeps its colours in a segment the plan seed swaps in training (T-R42)', async () => {
    let seed = 1;
    while (!isSwappedSegment(seed, 0)) seed++;
    const h = await begin({ kind: 'training', seed, phase: 'development', segments: [run('gonogo')] });
    expect(expectStep(h.c, 'instruction').text).toBe(testFormatInstruction(60) + reactionModules.gonogo.instruction('keyboard', DIAGNOSTIC_PARAMS.gonogo));
    h.c.ackInstruction();
    const block = expectStep(h.c, 'reaction_block');
    const go = new Set(block.specs.flatMap((t) => (t.expected.kind === 'press' && t.stimulus.kind === 'shape' ? [t.stimulus.color] : [])));
    expect([...go]).toEqual(['red']);
  });

  it('a run is neither the first block of the module nor its level in the session: a later segment starts at startLevel', async () => {
    const repo = new MemoryRepository();
    await pastTraining(repo, 's0', 1, [0, 1, 2].map(() => ({ module: 'szmr', lBefore: 6, lAfter: 6, paramsJson: bandParams(6) })));
    const h = await begin(training(run('szmr'), { module: 'szmr', budgetMs: 1, purpose: 'reaction' }), { repo });
    const first = await playReaction(h);
    expect([first.view.lBefore, first.view.lAfter]).toEqual([6, 6]);
    await h.c.continueAfterSummary();
    const next = await playReaction(h);
    // startLevel(6, 1 day) = 5; a perfect first block of the segment takes g = 2 (F6): the run did not use it up.
    expect(next.view.lBefore).toBe(5);
    expect(next.view.lAfter).toBe(nextLevel(5, { score: 1, calibration: false, prevScoreSameSession: null, firstOfSegment: true, cvAll: 0, lapses: 0, lapseLimit: 2, cvMax: 0.22, timingUnreliable: false }));
    expect(next.view.flags).toEqual([]);
  });
});

describe('SessionController — the personal window floor and the load bands (F3)', () => {
  const YESTERDAY = new Date(new Date(T0).getTime() - DAY).toISOString();
  const minutesAfter = (iso: string, m: number): string => new Date(new Date(iso).getTime() + m * MIN).toISOString();
  /** A block of yesterday's session `sessionId` on load band `band` with these clean hit RTs. */
  const playedBlock = (id: string, sessionId: string, m: number, over: Partial<BlockRow> & { band: number; rts: number[] }): BlockRow => {
    const { band, rts, ...rest } = over;
    return block(id, sessionId, minutesAfter(YESTERDAY, m), {
      paramsJson: JSON.stringify({ band, windowMs: 1000 }),
      summaryJson: JSON.stringify({ meanRt: 300, cleanHitRts: rts }),
      ...rest,
    });
  };
  /** The stored module states rebuilt from the rows, as at app start. */
  async function rebuilt(repo: MemoryRepository): Promise<MemoryRepository> {
    await rebuildCaches(repo);
    return repo;
  }
  const loadLine = (label: string): string => ` Нагрузка: ${label}.`;

  it('the floor comes from the history read at start', async () => {
    const repo = new MemoryRepository();
    for (const [i, id] of ['y1', 'y2'].entries()) {
      await repo.createSession(session(id, minutesAfter(YESTERDAY, 10 * i), { kind: 'free', endedAt: minutesAfter(YESTERDAY, 10 * i + 5) }));
      await repo.addBlock(playedBlock(`${id}b`, id, 10 * i + 1, { module: 'pzmr', lBefore: 10, lAfter: 10, band: 0, rts: Array<number>(10).fill(300) }), [], []);
    }
    const h = await begin(planFree('pzmr', 1), { repo: await rebuilt(repo) });
    h.c.ackInstruction();
    const step = expectStep(h.c, 'reaction_block');
    // L 9 is band 2 with the nominal window 299; band 0 has 20 hits (floor 1.2 × 300), bands 1 and 2 follow by chain × 1.0.
    expect(step.L).toBe(9);
    expect(pzmr.params(9)).toMatchObject({ band: 2, windowMs: 299 });
    expect(step.specs[0]?.windowMs).toBe(360);
    await h.c.submitReaction(playTimeline(step.specs, perfectPlayer));
    const { view } = expectStep(h.c, 'summary');
    const floor = 'Окно ответа: 360 мс — твой минимум для этой нагрузки (по уровню — 299 мс).';
    // After the RT lines, before the condition lines.
    expect(view.lines.slice(-2)).toEqual(['Пропуски: 0', floor]);
  });

  it('an overload block names the floor of its own level, not of the load it plays', async () => {
    const repo = new MemoryRepository();
    for (const [i, id] of ['y1', 'y2'].entries()) {
      await repo.createSession(session(id, minutesAfter(YESTERDAY, 10 * i), { kind: 'free', endedAt: minutesAfter(YESTERDAY, 10 * i + 5) }));
      await repo.addBlock(playedBlock(`${id}b`, id, 10 * i + 1, { module: 'pzmr', lBefore: 10, lAfter: 10, band: 0, rts: Array<number>(10).fill(300) }), [], []);
    }
    const finisher: SessionPlan = {
      kind: 'training',
      seed: 1,
      phase: 'development',
      segments: [{ module: 'pzmr', budgetMs: 1, purpose: 'finisher', overload: 'finisher' }],
    };
    const h = await begin(finisher, { repo: await rebuilt(repo) });
    h.c.ackInstruction();
    const step = expectStep(h.c, 'reaction_block');
    // The finisher plays L_saved 10 (band 2) with band 3's load and band 2's window: the floor 1.2 × 300 over the nominal.
    expect(step.L).toBe(10);
    const nominal = pzmr.params(10).windowMs;
    expect(step.specs[0]?.windowMs).toBe(360);
    await h.c.submitReaction(playTimeline(step.specs, perfectPlayer));
    const { view } = expectStep(h.c, 'summary');
    expect(view.flags).toContain('overload');
    expect(view.lines).toContain(`Окно ответа: 360 мс — твой минимум в обычном блоке этого уровня (по уровню — ${String(nominal)} мс).`);
    expect(view.lines.some((l) => l.includes('для этой нагрузки'))).toBe(false);
  });

  it('no floor line while the window is the nominal one', async () => {
    const h = await begin(planFree('pzmr', 1));
    const { view } = await playReaction(h);
    expect(view.lines.some((l) => l.includes('твой минимум'))).toBe(false);
  });

  it('a band change inside a segment takes the floor of the new band', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('y', YESTERDAY, { kind: 'free', endedAt: minutesAfter(YESTERDAY, 5) }));
    await repo.addBlock(playedBlock('yb', 'y', 1, { module: 'szmr', lBefore: 8, lAfter: 8, band: 1, rts: Array<number>(20).fill(500) }), [], []);
    const h = await begin(planFree('szmr', 1), { repo: await rebuilt(repo) });
    h.c.ackInstruction();
    const first = expectStep(h.c, 'reaction_block');
    // L_saved 8, a day's break: L 7, band 1, floor 1.2 × 500 above the nominal 548.
    expect([first.L, szmr.params(7).windowMs, first.specs[0]?.windowMs]).toEqual([7, 548, 600]);
    await h.c.submitReaction(playTimeline(first.specs, perfectPlayer));
    const { view } = expectStep(h.c, 'summary');
    // A perfect first block: +2, into band 2, whose floor is band 1's × 1.1 (its own hits at 300 ms keep band 1 at 600).
    expect(view.lAfter).toBe(9);
    expect(view.changes).toEqual([
      { label: 'Окно ответа', from: '600 мс', to: '660 мс' },
      { label: 'Нагрузка', from: '2 цвета на 2 клавиши', to: '3 цвета на 2 клавиши' },
    ]);
    h.clock.advance(30_000);
    await h.c.continueAfterSummary();
    expect(expectStep(h.c, 'instruction').text.endsWith(loadLine('3 цвета на 2 клавиши'))).toBe(true);
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block').specs[0]?.windowMs).toBe(660);
  });

  it('the floor follows the blocks of the session: the next window rests on the hits just stored', async () => {
    const h = await begin(planFree('pzmr', 1));
    const slow: Respond = (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      return r === null ? null : { ...r, rtMs: 700 };
    };
    h.c.ackInstruction();
    const first = expectStep(h.c, 'reaction_block');
    expect(first.specs[0]?.windowMs).toBe(1000);
    await h.c.submitReaction(playTimeline(first.specs, slow));
    // A perfect calibration block: L 0 → 2, still band 0, whose 15 hits give the floor 1.2 × 700 above the nominal 727.
    const { view } = expectStep(h.c, 'summary');
    expect(view.lAfter).toBe(2);
    // The summary names the window the next block plays, on the floor of the hits just played (T-R50); so does the
    // goal: band 1 takes that floor through its chain, so the window does not change up to the next step.
    expect(view.changes).toEqual([{ label: 'Окно ответа', from: '1000 мс', to: '840 мс' }]);
    expect(view.assessment?.goal).toBe('До ступени 2 «на подходе к формату теста»: уровень 4 (+2)');
    h.clock.advance(30_000);
    await h.c.continueAfterSummary();
    const second = expectStep(h.c, 'reaction_block');
    expect([pzmr.params(2).windowMs, second.specs[0]?.windowMs]).toEqual([727, 840]);
  });

  it('a finisher of a band module plays at L_saved and keeps the level', async () => {
    const repo = await calibratedRepo(stateWith('szmr', { lSaved: 9, lastTrainedAt: YESTERDAY, lifetimeBlocks: 3 }));
    const plan: SessionPlan = { kind: 'training', seed: 21, segments: [{ module: 'szmr', budgetMs: 80_000, purpose: 'finisher', overload: 'finisher' }] };
    const h = await begin(plan, { repo });
    const { text } = expectStep(h.c, 'instruction');
    expect(text.startsWith(overloadBandPrefix('4 цвета на 4 клавиши'))).toBe(true);
    expect(text.endsWith(loadLine('4 цвета на 4 клавиши'))).toBe(true);
    const views: BlockSummaryView[] = [];
    for (let i = 0; i < 3; i++) {
      if (h.c.step.kind === 'instruction') h.c.ackInstruction();
      const step = expectStep(h.c, 'reaction_block');
      // The load of band 3 (4 colours on 4 keys) at the window of band 2.
      expect(step).toMatchObject({ L: 9, keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'] });
      expect(step.specs[0]?.windowMs).toBe(szmr.params(9).windowMs);
      h.clock.advance(30_000);
      await h.c.submitReaction(playTimeline(step.specs, perfectPlayer));
      views.push(expectStep(h.c, 'summary').view);
      await h.c.continueAfterSummary();
    }
    expect(views.map((v) => [v.lBefore, v.lAfter, v.flags, v.changes])).toEqual(Array(3).fill([9, 9, ['overload'], []]));
    expect(views[0]?.assessment?.step).toMatch(/\(уровень 9; формат теста — 8; перегрузка: нагрузка полосы 3\)$/);
    expectStep(h.c, 'wellbeing');
    const stored = (await repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId);
    expect(stored.map((b) => [b.lBefore, b.lAfter])).toEqual(Array(3).fill([9, 9]));
    expect(JSON.parse(stored[0]?.paramsJson ?? '')).toMatchObject({
      band: 2,
      bandLabel: '3 цвета на 2 клавиши',
      loadBand: 3,
      loadBandLabel: '4 цвета на 4 клавиши',
      nColors: 4,
    });
    expect((await repo.getModuleStates()).szmr.lSaved).toBe(9);
  });

  it('the instruction ends with the load line', async () => {
    const h = await begin(planFree('szmr', 1));
    const { text } = expectStep(h.c, 'instruction');
    expect(text).toBe(szmr.instruction('keyboard', szmrSegment(0, 1)) + loadLine('2 цвета на 2 клавиши'));
    expect(text.endsWith('как можно быстрее. Нагрузка: 2 цвета на 2 клавиши.')).toBe(true);
  });

  it('paramsJson keeps band, bandLabel, nominalWindowMs, windowMs, floorMs', async () => {
    const h = await begin(planFree('pzmr', 1));
    await playReaction(h);
    const [row] = (await h.repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId);
    expect(JSON.parse(row?.paramsJson ?? '')).toEqual({ ...pzmr.params(0), layout: 'keyboard', nominalWindowMs: 1000, floorMs: null });
    expect(JSON.parse(row?.paramsJson ?? '')).toMatchObject({ band: 0, bandLabel: 'красный круг', windowMs: 1000 });
  });

  it('a diagnostic never asks for a floor, whatever the history', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('y', YESTERDAY, { kind: 'free', endedAt: minutesAfter(YESTERDAY, 5) }));
    await repo.addBlock(playedBlock('yb', 'y', 1, { module: 'pzmr', lBefore: 0, lAfter: 0, band: 0, rts: Array<number>(20).fill(2000) }), [], []);
    const pzmrSegment = planDiagnostic(1).segments.find((s) => s.module === 'pzmr') as Segment;
    const h = await begin({ ...planDiagnostic(1), segments: [pzmrSegment] }, { repo: await rebuilt(repo) });
    h.c.ackInstruction();
    expect(new Set(expectStep(h.c, 'reaction_block').specs.map((t) => t.windowMs))).toEqual(new Set([DIAGNOSTIC_PARAMS.pzmr.windowMs]));
  });

  /** ПЗМР at L_saved 30, last trained yesterday: today's segment starts at L 29, band 7, nominal window 153 ms (T-R78). */
  async function highPzmr(windows: ReadonlyArray<readonly [band: number, windowMs: number, kind?: 'diagnostic']>): Promise<MemoryRepository> {
    const repo = new MemoryRepository();
    await repo.createSession(session('y', YESTERDAY, { endedAt: minutesAfter(YESTERDAY, 30) }));
    await repo.createSession(session('yd', minutesAfter(YESTERDAY, 40), { kind: 'diagnostic', endedAt: minutesAfter(YESTERDAY, 50) }));
    for (const [i, [band, windowMs, kind]] of windows.entries()) {
      const sessionId = kind === 'diagnostic' ? 'yd' : 'y';
      const paramsJson = JSON.stringify({ ...pzmr.params(4 * band), windowMs });
      await repo.addBlock(block(`y${String(i)}`, sessionId, minutesAfter(YESTERDAY, kind === 'diagnostic' ? 41 + i : 1 + i), { module: 'pzmr', lBefore: 30, lAfter: 30, paramsJson }), [], []);
    }
    await repo.saveModuleState(stateWith('pzmr', { lSaved: 30, lastTrainedAt: YESTERDAY, lifetimeBlocks: 20 }));
    return repo;
  }
  const at260: Respond = (spec, idx) => {
    const r = perfectPlayer(spec, idx);
    return r === null ? null : { ...r, rtMs: 260 };
  };

  it('a failed history read takes the floor from the light rows: the stored window of the band (T-R78)', async () => {
    // The final review's probe: L_saved 30 and listBlocks failing played windows of 153–197 ms.
    const repo = await highPzmr([
      [6, 300],
      [7, 330],
    ]);
    vi.spyOn(repo, 'listBlocks').mockRejectedValueOnce(new Error('disk I/O error'));
    const h = await begin(planFree('pzmr', 1), { repo });
    h.c.ackInstruction();
    const step = expectStep(h.c, 'reaction_block');
    expect([step.L, pzmr.params(29).windowMs]).toEqual([29, 153]);
    expect(new Set(step.specs.map((t) => t.windowMs))).toEqual(new Set([330]));
    // A steady 260 ms player hits every signal.
    await h.c.submitReaction(playTimeline(step.specs, at260));
    const { view } = expectStep(h.c, 'summary');
    expect(view.score).toBe(1);
    expect(view.lines).toContain('Окно ответа: 330 мс — твой минимум для этой нагрузки (по уровню — 153 мс).');
    // The next block rests on the same floor, so «what changed» names no narrower window.
    expect(view.lAfter).toBeGreaterThan(29);
    expect(view.changes.some((c) => c.label === 'Окно ответа')).toBe(false);
    const [row] = (await repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId);
    expect(JSON.parse(row?.paramsJson ?? '')).toMatchObject({ band: 7, windowMs: 330, nominalWindowMs: 153, floorMs: 330 });
  });

  it('without a window on the band the fallback takes the nearest band below; diagnostics and runs are no source (T-R78)', async () => {
    const repo = await highPzmr([
      [5, 400],
      [7, 1000, 'diagnostic'],
    ]);
    vi.spyOn(repo, 'listBlocks').mockRejectedValueOnce(new Error('disk I/O error'));
    const h = await begin(planFree('pzmr', 1), { repo });
    h.c.ackInstruction();
    expect(new Set(expectStep(h.c, 'reaction_block').specs.map((t) => t.windowMs))).toEqual(new Set([400]));
  });

  it('without the block history and the light rows training does not start: an error step, nothing stored (T-R78)', async () => {
    const repo = await highPzmr([[7, 330]]);
    const sessionsBefore = await repo.listSessions();
    const blocks = vi.spyOn(repo, 'listBlocks').mockRejectedValue(new Error('disk I/O error'));
    const levels = vi.spyOn(repo, 'listBlockLevels').mockRejectedValue(new Error('disk I/O error'));
    const h = await begin(planFree('pzmr', 1), { repo });
    expect(h.c.step).toEqual({ kind: 'history_error' });
    expect(await repo.listSessions()).toEqual(sessionsBefore);
    // Newest first.
    expect((await repo.listLog(5)).map((l) => l.message)).toEqual([
      'session: block levels could not be read',
      'session: block history could not be read',
    ]);
    // «Повторить» while the reads still fail: the step stays, nothing is stored.
    await h.c.retryHistory();
    expect(h.c.step).toEqual({ kind: 'history_error' });
    expect(await repo.listSessions()).toEqual(sessionsBefore);
    // The light rows read again: the session starts, on their floor.
    levels.mockRestore();
    await h.c.retryHistory();
    expectStep(h.c, 'instruction');
    expect((await repo.listSessions()).map((s) => s.id)).toEqual([...sessionsBefore.map((s) => s.id), h.c.sessionId]);
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block').specs[0]?.windowMs).toBe(330);
    // The whole history reads again: the session starts on the floors of the stored hits (the rows here have none).
    vi.spyOn(repo, 'listBlockLevels').mockRejectedValue(new Error('disk I/O error'));
    const again = await begin(planFree('pzmr', 1), { repo });
    expectStep(again.c, 'history_error');
    blocks.mockRestore();
    await again.c.retryHistory();
    again.c.ackInstruction();
    expect(expectStep(again.c, 'reaction_block').specs[0]?.windowMs).toBe(153);
    await expect(again.c.retryHistory()).rejects.toThrow('expected step history_error');
  });

  it('a diagnostic reads neither: it starts on its frozen windows when both reads fail (T-R78)', async () => {
    const repo = await highPzmr([[7, 330]]);
    vi.spyOn(repo, 'listBlocks').mockRejectedValue(new Error('disk I/O error'));
    vi.spyOn(repo, 'listBlockLevels').mockRejectedValue(new Error('disk I/O error'));
    const pzmrSegment = planDiagnostic(1).segments.find((s) => s.module === 'pzmr') as Segment;
    const h = await begin({ ...planDiagnostic(1), segments: [pzmrSegment] }, { repo });
    h.c.ackInstruction();
    expect(new Set(expectStep(h.c, 'reaction_block').specs.map((t) => t.windowMs))).toEqual(new Set([DIAGNOSTIC_PARAMS.pzmr.windowMs]));
  });
});

describe('SessionController — assessment', () => {
  it('the next block of the variant compares with the one before it: РДО at the same speed (F14, T-R9)', async () => {
    const h = await begin(planFree('rdo', 1));
    const first = await playReaction(h);
    expect(first.view.assessment?.history).toBe('Первый такой блок — будет с чем сравнивать');
    // Blocks 1–3 play the other three speeds: each is the first of its variant.
    for (let i = 1; i < 4; i++) {
      await h.c.continueAfterSummary();
      expect((await playReaction(h)).view.assessment?.history, `block ${String(i)}`).toBe('Первый такой блок — будет с чем сравнивать');
    }
    await h.c.continueAfterSummary();
    const fifth = await playReaction(h);
    expect(fifth.view.assessment?.history).toMatch(/^Раньше в этом блоке: прошлый раз \d+ мс \(ур\. [\d,]+\) · лучший \d+ мс · в среднем за 7 дней \d+ мс/);
  });

  it('an РДО block plays the speed of its slot, stores it and names it in the speed line (F14, T-R61)', async () => {
    const h = await begin(planFree('rdo', 1));
    for (let i = 0; i < 4; i++) {
      if (i > 0) await h.c.continueAfterSummary();
      const { view } = await playReaction(h);
      const periodMs = rdoCyclePeriod(i);
      const seconds = String(periodMs / 1000).replace('.', ',');
      expect(view.lines.filter((l) => l.startsWith('Скорость: ')), `block ${String(i)}`).toEqual([
        expect.stringMatching(new RegExp(`^Скорость: оборот за ${seconds} с · (смещение [^·]+ · )?точно \\d+ из 20 · рано \\d+, поздно \\d+\\.$`)),
      ]);
      expect(view.lines.some((l) => l.startsWith('Средняя ошибка по модулю: ') || l === 'Ошибок нет.')).toBe(true);
    }
    const stored = (await h.repo.listBlocks()).map((b) => (JSON.parse(b.paramsJson) as { periodMs: number }).periodMs);
    expect(stored).toEqual([0, 1, 2, 3].map(rdoCyclePeriod));
  });

  it('history from earlier sessions is read at session start', async () => {
    const repo = new MemoryRepository();
    const yesterday = new Date(new Date(T0).getTime() - DAY).toISOString();
    await repo.createSession(session('s0', yesterday, { kind: 'free' }));
    // The block before played the speed this session's first block plays (F14, T-R9): the cycle went on past it (T-R61).
    const paramsJson = JSON.stringify({ periodMs: rdoCyclePeriod(1) });
    await repo.addBlock(block('b0', 's0', yesterday, { module: 'rdo', lBefore: 3, paramsJson, summaryJson: '{"meanAbsErrorMs":25}' }), [], []);
    const h = await begin(planFree('rdo', 1), { repo });
    const { view } = await playReaction(h);
    expect(view.assessment?.history?.startsWith('Раньше в этом блоке: прошлый раз 25 мс (ур. 3) · лучший 25 мс')).toBe(true);
  });

  it('a history read failure is logged and the session runs without a history line', async () => {
    const repo = new MemoryRepository();
    vi.spyOn(repo, 'listBlocks').mockRejectedValueOnce(new Error('disk I/O error'));
    const h = await begin(planFree('pzmr', 1), { repo });
    expect(h.c.step.kind).toBe('instruction');
    const log = await repo.listLog(5);
    expect(log.some((r) => r.level === 'error' && r.message.includes('block history could not be read') && r.detail.includes('disk I/O error'))).toBe(
      true,
    );
    const { view } = await playReaction(h);
    expect(view.assessment?.history).toBeNull();
    expect(view.assessment?.step).not.toBeNull();
  });

  it('a failing assessment never loses the block: stored, summary without the section, logged (A-R19)', async () => {
    const repo = new MemoryRepository();
    const h = await begin(planFree('pzmr', 1), { repo });
    vi.mocked(assessBlock).mockImplementationOnce(() => {
      throw new RangeError('levelStep: bad level');
    });
    const { view } = await playReaction(h);
    expect(view.assessment).toBeUndefined();
    expect('assessment' in view).toBe(false);
    expect(view.lines.length).toBeGreaterThan(0);
    expect(await repo.listBlocks()).toHaveLength(1);
    const [log] = await repo.listLog(5);
    expect(log).toMatchObject({ level: 'error', message: 'session: block assessment failed' });
    expect(JSON.parse(log?.detail ?? '')).toEqual({ sessionId: h.c.sessionId, module: 'pzmr', error: 'levelStep: bad level' });
    // The next block is assessed again, and the stored one is in its history.
    await h.c.continueAfterSummary();
    const next = await playReaction(h);
    expect(next.view.assessment?.history).toMatch(/^Раньше в этом блоке: прошлый раз 300 мс/);
  });

  it('a failing assessment goes unlogged when the log cannot be written; the block is still stored', async () => {
    const repo = new MemoryRepository();
    vi.spyOn(repo, 'appendLog').mockRejectedValueOnce(new Error('disk I/O error'));
    const h = await begin(planFree('pzmr', 1), { repo });
    vi.mocked(assessBlock).mockImplementationOnce(() => {
      throw new RangeError('boom');
    });
    const { view } = await playReaction(h);
    expect(view.assessment).toBeUndefined();
    expect(await repo.listBlocks()).toHaveLength(1);
    expect(await repo.listLog(5)).toEqual([]);
  });

  it('a throw after the block was counted does not count it twice when the commit runs again (A-R19)', async () => {
    const h = await begin(planFree('rdo', 3));
    vi.mocked(appendBlock).mockImplementationOnce(() => {
      throw new Error('history: out of memory');
    });
    await drive(h, { blockMs: 100_000 });
    // Calibration covers the first three blocks of a module: block 1 counted twice would end it at block 3.
    expect((await h.repo.listBlocks()).map((b) => b.flags)).toEqual([['calibration'], ['calibration'], ['calibration']]);
  });

  it('a throw inside the commit goes to the log instead of vanishing on the retry', async () => {
    const h = await begin(planFree('rdo', 1));
    vi.mocked(appendBlock).mockImplementationOnce(() => {
      throw new Error('history: out of memory');
    });
    const { view } = await playReaction(h);
    expect(view.module).toBe('rdo');
    expect(await h.repo.listBlocks()).toHaveLength(1);
    const log = (await h.repo.listLog(5)).find((r) => r.message === 'session: block commit failed');
    expect(log).toMatchObject({ level: 'error' });
    expect(JSON.parse(log?.detail ?? '')).toEqual({ sessionId: h.c.sessionId, module: 'rdo', error: 'history: out of memory' });
  });

  it('a diagnostic reads no block history; its summaries carry norms only', async () => {
    const repo = new SpyRepo();
    const h = await begin(planDiagnostic(1), { repo, scale: 0.02 });
    const first = await playReaction(h);
    await drive(h);
    expect(repo.listBlocksCalls).toBe(0);
    expect(first.view.module).toBe('pzmr');
    const a = first.view.assessment;
    expect(a).toMatchObject({ step: null, goal: null, history: null });
    expect(a?.norms).toHaveLength(2);
    expect(a?.norms[0]?.startsWith('Норма (ориентир), среднее:')).toBe(true);
    expect(a?.norms[1]?.startsWith('Норма (ориентир), разброс (SD):')).toBe(true);
  });

  it('number series in free training show the step by rating', async () => {
    const h = await begin(planFree('numseries', 1));
    h.c.ackInstruction();
    await h.c.submitNumSeries(perfectSeriesAnswers(expectStep(h.c, 'numseries_block').items));
    expect(expectStep(h.c, 'summary').view.assessment?.step).toMatch(/^Ступень \d( из 5\+)? — .+ \(рейтинг \d+; формат теста — 1376\)$/);
  });
});

describe('SessionController — the РДО speed cycle (T-R61)', () => {
  /** The speed of every stored РДО block, in order. */
  const periods = async (repo: Repository): Promise<number[]> =>
    (await repo.listBlocks()).filter((b) => b.module === 'rdo').map((b) => (JSON.parse(b.paramsJson) as { periodMs: number }).periodMs);
  const speedOf = (block: StepOf<'reaction_block'>): number | null => {
    const [t] = block.specs;
    return t?.stimulus.kind === 'rdo' ? t.stimulus.periodMs : null;
  };

  it('the cycle goes on across sessions: a session of 3 blocks, then one of 5, play it in turn', async () => {
    const repo = new MemoryRepository();
    const clock = new Clock();
    await drive(await begin(planFree('rdo', 1), { repo, clock }), { blockMs: 100_000 });
    expect(await periods(repo)).toEqual([0, 1, 2].map(rdoCyclePeriod));
    clock.advance(DAY);
    await drive(await begin(planFree('rdo', 2), { repo, clock }), { blockMs: 60_000 });
    expect(await periods(repo)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(rdoCyclePeriod));
  });

  it('each instruction names its block\'s speed, so a new speed brings the instruction back', async () => {
    const h = await begin(planFree('rdo', 1));
    expect(expectStep(h.c, 'instruction').text.endsWith(` ${rdoSpeedNote(rdoCyclePeriod(0))}`)).toBe(true);
    await playReaction(h);
    await h.c.continueAfterSummary();
    expect(expectStep(h.c, 'instruction').text.endsWith(` ${rdoSpeedNote(rdoCyclePeriod(1))}`)).toBe(true);
  });

  it('a block counted as 0 after Esc leaves the cycle where it was: the next block plays its speed again', async () => {
    const h = await begin(planFree('rdo', 1));
    await playReaction(h);
    await h.c.continueAfterSummary();
    h.c.ackInstruction();
    expect(speedOf(expectStep(h.c, 'reaction_block'))).toBe(rdoCyclePeriod(1));
    expect(await h.c.discardBlock('user', 0.5)).toMatchObject({ kind: 'counted' });
    // The same speed: the same instruction, so the block comes at once.
    expect(speedOf(expectStep(h.c, 'reaction_block'))).toBe(rdoCyclePeriod(1));
  });

  it('a test-format run plays 3000 ms and leaves the cycle where it was', async () => {
    const plan: SessionPlan = {
      kind: 'training',
      seed: 4,
      phase: 'development',
      segments: [
        { module: 'rdo', budgetMs: 0, purpose: 'test_format', trialCount: 50, practiceTrials: 5 },
        { module: 'rdo', budgetMs: 5 * MIN, purpose: 'reaction' },
      ],
    };
    const h = await begin(plan, { scale: 0.1 });
    await playReaction(h);
    await h.c.continueAfterSummary();
    h.c.ackInstruction();
    expect(speedOf(expectStep(h.c, 'reaction_block'))).toBe(rdoCyclePeriod(0));
    expect(await periods(h.repo)).toEqual([3000]);
  });

  it('without the history (Р18) a segment plays its own order', async () => {
    const repo = new MemoryRepository();
    vi.spyOn(repo, 'listBlocks').mockRejectedValueOnce(new Error('disk I/O error'));
    await drive(await begin(planFree('rdo', 7), { repo }), { blockMs: 100_000 });
    expect(await periods(repo)).toEqual([0, 1, 2].map((i) => rdoPeriod(7, 0, i)));
  });
});

describe('SessionController — re-adaptation after a setup change (F9)', () => {
  const YESTERDAY = new Date(new Date(T0).getTime() - DAY).toISOString();
  const SEED = 6;
  /** The mapping of today's СЗМР segment (segment 0 of planFree at L 0: 2 colours on 2 keys). */
  const today = (): number[] => {
    const map = szmr.withMapping?.(szmr.params(0), deriveSeed(SEED, 'map:0')).mapping;
    if (map === undefined || map === null) throw new Error('СЗМР maps its keys');
    return map;
  };
  /** A repository with yesterday's free session and, unless null, one block of `module` with these params. */
  async function withPast(paramsJson: string | null, module: ModuleId = 'szmr'): Promise<MemoryRepository> {
    const repo = new MemoryRepository();
    await repo.createSession(session('s0', YESTERDAY, { kind: 'free', endedAt: YESTERDAY }));
    if (paramsJson !== null) await repo.addBlock(block('b0', 's0', YESTERDAY, { module, paramsJson }), [], []);
    return repo;
  }
  /** summaryJson.readapt of the blocks this session stored, in order. */
  const marks = async (h: Harness): Promise<unknown[]> =>
    (await h.repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId).map((b) => (JSON.parse(b.summaryJson) as { readapt?: unknown }).readapt);
  /** Plays the first two blocks of the session. */
  async function twoBlocks(h: Harness): Promise<void> {
    await playReaction(h);
    await h.c.continueAfterSummary();
    await playReaction(h);
  }

  it('the first block after a mapping change is marked readapt, the second is not', async () => {
    const h = await begin(planFree('szmr', SEED), { repo: await withPast(JSON.stringify({ layout: 'keyboard', mapping: [...today()].reverse() })) });
    await twoBlocks(h);
    expect(await marks(h)).toEqual([true, undefined]);
  });

  it('the same mapping on the same layout: no mark', async () => {
    const h = await begin(planFree('szmr', SEED), { repo: await withPast(JSON.stringify({ layout: 'keyboard', mapping: today() })) });
    await twoBlocks(h);
    expect(await marks(h)).toEqual([undefined, undefined]);
  });

  it('without an earlier block that names its layout: no mark', async () => {
    for (const past of [JSON.stringify({ mapping: [...today()].reverse() }), null]) {
      const h = await begin(planFree('szmr', SEED), { repo: await withPast(past) });
      await twoBlocks(h);
      expect(await marks(h), String(past)).toEqual([undefined, undefined]);
    }
  });

  it('another layout, or the Go/No-Go colours swapped, is a change too', async () => {
    const pult = await begin(planFree('szmr', SEED), { repo: await withPast(JSON.stringify({ layout: 'pult', mapping: today() })) });
    await twoBlocks(pult);
    expect(await marks(pult)).toEqual([true, undefined]);
    let seed = 1;
    while (!isSwappedSegment(seed, 0)) seed++;
    const repo = await withPast(JSON.stringify({ layout: 'keyboard', swapped: false }), 'gonogo');
    const swap = await begin(planFree('gonogo', seed), { repo });
    await twoBlocks(swap);
    expect(await marks(swap)).toEqual([true, undefined]);
  });

  it('the mark waits for the first block that measured something: not counted as 0, no dropped frames (T-R63)', async () => {
    const changed = JSON.stringify({ layout: 'keyboard', mapping: [...today()].reverse() });
    // Dropped frames first: that block keeps the level and its setup, and the next one is marked.
    const dropped = await begin(planFree('szmr', SEED), { repo: await withPast(changed) });
    expect((await playReaction(dropped, perfectPlayer, (idx) => idx < 2)).view.flags).toContain('timing_unreliable');
    await dropped.c.continueAfterSummary();
    await playReaction(dropped);
    expect(await marks(dropped)).toEqual([undefined, true]);
    // Counted as 0 after Esc first: the next block is marked.
    const escaped = await begin(planFree('szmr', SEED), { repo: await withPast(changed) });
    escaped.c.ackInstruction();
    expect(await escaped.c.discardBlock('user', 0.5)).toMatchObject({ kind: 'counted' });
    await playReaction(escaped);
    expect(await marks(escaped)).toEqual([undefined, true]);
    // The same setup as the last segment: a block with dropped frames first changes nothing.
    const same = await begin(planFree('szmr', SEED), { repo: await withPast(JSON.stringify({ layout: 'keyboard', mapping: today() })) });
    await playReaction(same, perfectPlayer, (idx) => idx < 2);
    await same.c.continueAfterSummary();
    await playReaction(same);
    expect(await marks(same)).toEqual([undefined, undefined]);
  });

  it('without the history (Р18) nothing is marked', async () => {
    const repo = await withPast(JSON.stringify({ layout: 'keyboard', mapping: [...today()].reverse() }));
    vi.spyOn(repo, 'listBlocks').mockRejectedValueOnce(new Error('disk I/O error'));
    const h = await begin(planFree('szmr', SEED), { repo });
    await twoBlocks(h);
    expect(await marks(h)).toEqual([undefined, undefined]);
  });
});

describe('SessionController — the layout of the day (F9)', () => {
  const YESTERDAY = new Date(new Date(T0).getTime() - DAY).toISOString();
  const PULT_DAY = 'Сегодня раскладка: пульт (стрелки и цифры). Основная — клавиатура. ';
  const free = (module: ModuleId, layout: LayoutId, seed = 3): SessionPlan => ({ ...planFree(module, seed), layout });
  /** The paramsJson.layout of the blocks this session stored, in order. */
  const storedLayouts = async (h: Harness): Promise<unknown[]> =>
    (await h.repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId).map((b) => (JSON.parse(b.paramsJson) as { layout?: unknown }).layout);

  it('a remote-control day plays the arrows; only the session’s first instruction names the day', async () => {
    const plan: SessionPlan = { kind: 'free', seed: 3, layout: 'pult', segments: [segment('pzmr', 5 * MIN), segment('gonogo', 5 * MIN)] };
    const h = await begin(plan, { layout: 'keyboard' });
    const first = expectStep(h.c, 'instruction');
    expect(first.text.startsWith(PULT_DAY)).toBe(true);
    expect(first.text).toContain('нажми ↓');
    expect(first.keysHint).toBe('↓');
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block')).toMatchObject({ keys: ['ArrowDown'], layout: 'pult' });
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    await h.c.continueAfterSummary();
    // The same rules: the next block of the segment comes without an instruction (the day line is no change of rules).
    expectStep(h.c, 'reaction_block');
    h.clock.advance(5 * MIN);
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    await h.c.continueAfterSummary();
    const second = expectStep(h.c, 'instruction');
    expect(second.module).toBe('gonogo');
    expect(second.text).not.toContain('Сегодня раскладка');
    expect(second.keysHint).toBe('↓');
    expect(await storedLayouts(h)).toEqual(['pult', 'pult']);
  });

  it('the primary layout of the day: no day line', async () => {
    const h = await begin(free('pzmr', 'keyboard'), { layout: 'keyboard' });
    expect(expectStep(h.c, 'instruction').text).not.toContain('Сегодня раскладка');
    // A plan without a layout plays the user’s own.
    const own = await begin(planFree('pzmr', 3), { layout: 'pult' });
    expect(expectStep(own.c, 'instruction')).toMatchObject({ keysHint: '↓' });
    expect(expectStep(own.c, 'instruction').text).not.toContain('Сегодня раскладка');
  });

  it('the mouse day falls back to the keyboard for more than two keys', async () => {
    // L_saved 14: the segment starts at 13, band 3, 4 colours on 4 keys.
    const repo = await calibratedRepo(stateWith('szmr', { lSaved: 14, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    const h = await begin(free('szmr', 'mouse'), { repo, layout: 'keyboard' });
    const step = expectStep(h.c, 'instruction');
    expect(step.text.startsWith('Сегодня раскладка: мышь. Основная — клавиатура. ')).toBe(true);
    expect(step.text).toContain(' Для этого уровня нужны клавиши: D, F, J, K.');
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block')).toMatchObject({ keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'], layout: 'keyboard' });
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    expect(await storedLayouts(h)).toEqual(['keyboard']);
    // Two keys or one: the mouse.
    const pzmrDay = await begin(free('pzmr', 'mouse'), { layout: 'keyboard' });
    pzmrDay.c.ackInstruction();
    expect(expectStep(pzmrDay.c, 'reaction_block')).toMatchObject({ keys: ['MouseLeft'], layout: 'mouse' });
  });

  it('a test-format run and a diagnostic play the primary layout', async () => {
    const run: Segment = { module: 'pzmr', budgetMs: 0, purpose: 'test_format', trialCount: 50, practiceTrials: 5 };
    const plan: SessionPlan = { kind: 'training', seed: 3, phase: 'development', layout: 'pult', segments: [run, { module: 'gonogo', budgetMs: 5 * MIN, purpose: 'reaction' }] };
    const h = await begin(plan, { layout: 'keyboard' });
    const runStep = expectStep(h.c, 'instruction');
    expect(runStep.text).not.toContain('Сегодня раскладка');
    expect(runStep.keysHint).toBe('Пробел');
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block')).toMatchObject({ keys: ['Space'], layout: 'keyboard' });
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    await h.c.continueAfterSummary();
    // The first instruction on the day's layout names it.
    const next = expectStep(h.c, 'instruction');
    expect(next.text.startsWith(PULT_DAY)).toBe(true);
    expect(next.keysHint).toBe('↓');
    expect(await storedLayouts(h)).toEqual(['keyboard']);

    const diag = await begin({ ...planDiagnostic(1, 1), layout: 'pult' }, { layout: 'keyboard' });
    const first = expectStep(diag.c, 'instruction');
    expect(first.text).not.toContain('Сегодня раскладка');
    expect(first.keysHint).toBe('Пробел');
  });

  it('a warm-up on a mouse day plays the primary layout; the day line opens the first reaction block after it (T-R65)', async () => {
    const warmup: Segment = { module: 'pzmr', budgetMs: 2 * MIN, purpose: 'warmup' };
    const plan: SessionPlan = { kind: 'training', seed: 3, phase: 'development', layout: 'mouse', segments: [warmup, { module: 'gonogo', budgetMs: 5 * MIN, purpose: 'reaction' }] };
    const h = await begin(plan, { layout: 'keyboard' });
    const first = expectStep(h.c, 'instruction');
    expect(first.text).not.toContain('Сегодня раскладка');
    expect(first.keysHint).toBe('Пробел');
    h.c.ackInstruction();
    do {
      expect(expectStep(h.c, 'reaction_block')).toMatchObject({ keys: ['Space'], layout: 'keyboard' });
      await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
      h.clock.advance(30_000);
      await h.c.continueAfterSummary();
    } while (h.c.step.kind === 'reaction_block');
    const warmups = await storedLayouts(h);
    expect(warmups.length).toBeGreaterThan(0);
    expect(new Set(warmups)).toEqual(new Set(['keyboard']));
    // The warm-up was on the keyboard: the first block on the mouse names the day.
    const next = expectStep(h.c, 'instruction');
    expect(next.module).toBe('gonogo');
    expect(next.text.startsWith('Сегодня раскладка: мышь. Основная — клавиатура. ')).toBe(true);
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block')).toMatchObject({ keys: ['MouseLeft'], layout: 'mouse' });
  });

  it('tables do not use the layout: a free Горбов session on a remote-control day has no day line (T-R65)', async () => {
    const h = await begin(free('gorbov', 'pult'), { layout: 'keyboard' });
    expect(expectStep(h.c, 'instruction').text).not.toContain('Сегодня раскладка');
  });

  it('a diagnostic on the user’s mouse names its layout for the results table (T-R23)', async () => {
    const plan = planDiagnostic(1, 1);
    const h = await begin({ ...plan, segments: plan.segments.slice(0, 1) }, { layout: 'mouse' });
    await drive(h);
    expect(expectStep(h.c, 'done')).toMatchObject({ layout: 'mouse' });
  });

  it('a layout change between days is a setup change: the first block re-adapts, once (Р26)', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('s0', YESTERDAY, { kind: 'free', endedAt: YESTERDAY }));
    await repo.addBlock(block('b0', 's0', YESTERDAY, { module: 'pzmr', paramsJson: JSON.stringify({ layout: 'keyboard' }) }), [], []);
    const h = await begin(free('pzmr', 'pult'), { repo, layout: 'keyboard' });
    await playReaction(h);
    await h.c.continueAfterSummary();
    await playReaction(h);
    const marks = (await h.repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId).map((b) => (JSON.parse(b.summaryJson) as { readapt?: unknown }).readapt);
    expect(marks).toEqual([true, undefined]);
    // A mouse day whose block falls back to the keyboard plays yesterday's setup: no re-adaptation.
    const szmrRepo = await calibratedRepo(stateWith('szmr', { lSaved: 14, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    await szmrRepo.createSession(session('s1', YESTERDAY, { kind: 'free', endedAt: YESTERDAY }));
    const mapping = szmrSegment(13, 3).mapping;
    await szmrRepo.addBlock(block('b1', 's1', YESTERDAY, { module: 'szmr', paramsJson: JSON.stringify({ layout: 'keyboard', mapping }) }), [], []);
    const mouse = await begin(free('szmr', 'mouse'), { repo: szmrRepo, layout: 'keyboard' });
    await playReaction(mouse);
    const [row] = (await szmrRepo.listBlocks()).filter((b) => b.sessionId === mouse.c.sessionId);
    expect(JSON.parse(row?.summaryJson ?? '{}')).not.toHaveProperty('readapt');
  });
});

describe('SessionController — fatigue', () => {
  /** Fast and clean for 2 blocks, then slower with 30 % misses. */
  const tiring = (): Respond => {
    let block = 0;
    return (spec, idx) => {
      if (idx === 0) block++;
      if (block <= 2) return perfectPlayer(spec, idx);
      if (idx % 10 < 3) return null;
      const e = spec.expected;
      return e.kind === 'press' ? { key: e.key, rtMs: 400 } : perfectPlayer(spec, idx);
    };
  };
  const plan: SessionPlan = { kind: 'training', seed: 11, segments: [segment('szmr', 5 * MIN), segment('gorbov', 6 * MIN)] };

  async function playUntilPrompt(h: Harness, respond: Respond): Promise<void> {
    for (let i = 0; i < 4; i++) {
      h.clock.advance(30_000);
      await playReaction(h, respond);
      await h.c.continueAfterSummary();
    }
  }

  it('fatigue prompt appears and stop skips segment', async () => {
    const h = await begin(plan);
    await playUntilPrompt(h, tiring());
    expect(h.c.step).toEqual({ kind: 'fatigue_prompt', module: 'szmr' });
    await h.c.answerFatigue(true);
    expect(expectStep(h.c, 'instruction').module).toBe('gorbov');
    expect(await h.repo.listBlocks()).toHaveLength(4);
  });

  it('continue after fatigue flags next blocks fatigued', async () => {
    const h = await begin(plan);
    const respond = tiring();
    await playUntilPrompt(h, respond);
    expectStep(h.c, 'fatigue_prompt');
    const lSavedBefore = (await h.repo.getModuleStates()).szmr.lSaved;
    await h.c.answerFatigue(false);
    const fifth = await playReaction(h, respond);
    expect(fifth.view.flags).toEqual(['fatigued']);
    await h.c.continueAfterSummary();
    expectStep(h.c, 'reaction_block'); // asked once per module
    const sixth = await playReaction(h, respond);
    expect(sixth.view.flags).toEqual(['fatigued']);
    const blocks = await h.repo.listBlocks();
    expect(blocks.map((b) => b.flags)).toEqual([['calibration'], ['calibration'], ['calibration'], [], ['fatigued'], ['fatigued']]);
    // Fatigued blocks do not move L_saved.
    expect((await h.repo.getModuleStates()).szmr.lSaved).toBe(lSavedBefore);
  });

  it('no prompt when the segment time is already over', async () => {
    const h = await begin(plan);
    const respond = tiring();
    for (let i = 0; i < 4; i++) {
      h.clock.advance(i === 3 ? 5 * MIN : 20_000);
      await playReaction(h, respond);
      await h.c.continueAfterSummary();
    }
    expect(expectStep(h.c, 'instruction').module).toBe('gorbov');
  });

  it('continue re-checks the budget: a long pause on the prompt ends the segment', async () => {
    const h = await begin(plan);
    await playUntilPrompt(h, tiring());
    expectStep(h.c, 'fatigue_prompt');
    h.clock.advance(5 * MIN);
    await h.c.answerFatigue(false);
    expect(expectStep(h.c, 'instruction').module).toBe('gorbov');
  });

  it('a diagnostic segment of several blocks never prompts or flags fatigue', async () => {
    // Same tiring player as above (which prompts after block 4 of a free plan), 6 fixed blocks.
    const diag: SessionPlan = {
      kind: 'diagnostic',
      seed: 1,
      diagnosticNumber: 9,
      segments: [{ module: 'szmr', budgetMs: 0, purpose: 'diagnostic', fixedL: 0, trialCount: 20, runs: 6 }],
    };
    const h = await begin(diag);
    const seen = await drive(h, { respond: tiring() });
    expect(seen.filter((x) => x === 'reaction_block:szmr')).toHaveLength(6);
    expect(seen.filter((x) => x.startsWith('fatigue_prompt'))).toEqual([]);
    expect((await h.repo.listBlocks()).flatMap((b) => b.flags)).toEqual([]);
  });
});

describe('SessionController — overload', () => {
  const YESTERDAY = new Date(new Date(T0).getTime() - DAY).toISOString();
  const overloadSegment = (module: ModuleId, overload: 'finisher' | 'mix', budgetMs = 5 * MIN): Segment => ({
    module,
    budgetMs,
    purpose: overload === 'finisher' ? 'finisher' : 'reaction',
    overload,
  });
  const training = (...segments: Segment[]): SessionPlan => ({ kind: 'training', seed: 21, segments });

  /** A trained module: yesterday's session ended at `level` after 3 blocks; the cached state is its rebuild. */
  async function trainedRepo(module: ModuleId, level: number): Promise<MemoryRepository> {
    const repo = new MemoryRepository();
    await repo.createSession(session('old', YESTERDAY, { endedAt: YESTERDAY }));
    for (let i = 0; i < 3; i++) {
      await repo.addBlock(block(`old${String(i)}`, 'old', YESTERDAY, { module, lBefore: level, lAfter: level, paramsJson: bandParams(level) }), [], []);
    }
    await repo.saveModuleState(deriveModuleStates(await repo.listSessions(), await repo.listBlocks())[module]);
    return repo;
  }

  /** Plays reaction blocks (with their summaries) until the segment ends; returns every summary view. */
  async function playSegment(h: Harness, n: number, respond: Respond = perfectPlayer): Promise<BlockSummaryView[]> {
    const views: BlockSummaryView[] = [];
    for (let i = 0; i < n; i++) {
      h.clock.advance(30_000);
      views.push((await playReaction(h, respond)).view);
      await h.c.continueAfterSummary();
    }
    return views;
  }

  it('a finisher of a module without bands starts at L_saved + 3 and flags every block overload', async () => {
    const repo = await calibratedRepo(stateWith('rdo', { lSaved: 10, lastTrainedAt: YESTERDAY, lifetimeBlocks: 3 }));
    const h = await begin(training(overloadSegment('rdo', 'finisher')), { repo });
    const [first, second] = await playSegment(h, 2);
    expect(first).toMatchObject({ lBefore: 13, flags: ['overload'] });
    // The finisher segment moves its own level.
    expect(first?.lAfter).toBeGreaterThan(13);
    expect(second).toMatchObject({ lBefore: first?.lAfter, flags: ['overload'] });
    const stored = (await repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId);
    expect(stored.map((b) => b.flags)).toEqual([['overload'], ['overload']]);
  });

  it("a finisher's first block is an overload block, not the first", async () => {
    // РДО: the finisher of the development phase on a calibrated module; s 1 moves it by g = 1, not by the first-block g = 2.
    const repo = await calibratedRepo(stateWith('rdo', { lSaved: 10, lastTrainedAt: YESTERDAY, lifetimeBlocks: 3 }));
    const plan: SessionPlan = { kind: 'training', seed: 21, phase: 'development', segments: [overloadSegment('rdo', 'finisher', 3 * MIN)] };
    const h = await begin(plan, { repo });
    const [first] = await playSegment(h, 1);
    expect(first).toMatchObject({ module: 'rdo', score: 1, lBefore: 13, lAfter: 14, flags: ['overload'] });
  });

  it('finisher blocks leave L_saved alone', async () => {
    const repo = await trainedRepo('szmr', 10);
    const before = (await repo.getModuleStates()).szmr;
    expect(before).toMatchObject({ lSaved: 10, sessionEndLevels: [10], lifetimeBlocks: 3 });
    const h = await begin(training(overloadSegment('szmr', 'finisher', 3 * MIN)), { repo });
    const seen = await drive(h);
    expect(seen.filter((x) => x === 'reaction_block:szmr').length).toBeGreaterThan(1);
    const after = (await repo.getModuleStates()).szmr;
    expect(after).toEqual({ ...before, lifetimeBlocks: after.lifetimeBlocks, lastTrainedAt: after.lastTrainedAt });
    expect(after.lifetimeBlocks).toBeGreaterThan(3);
    expect(after).toEqual(deriveModuleStates(await repo.listSessions(), await repo.listBlocks()).szmr);
  });

  it('mix alternates normal and overload blocks', async () => {
    const repo = await trainedRepo('szmr', 10);
    // A later plain segment of the module continues from the last normal level, not from an overload block.
    const h = await begin(training(overloadSegment('szmr', 'mix', 90_000), segment('rdo', 1), segment('szmr', 1)), { repo });
    const views = await playSegment(h, 4);
    expect(views.map((v) => v.flags)).toEqual([[], ['overload'], [], ['overload']]);
    const [b0, b1, b2, b3] = views as [BlockSummaryView, BlockSummaryView, BlockSummaryView, BlockSummaryView];
    expect(b0.lBefore).toBe(9); // startLevel(10, 1 day)
    // A band module's overload block plays the segment level with the next band's load and keeps it (F3).
    expect([b1.lBefore, b1.lAfter]).toEqual([b0.lAfter, b0.lAfter]);
    // The level after overload block 1 is the level after block 0.
    expect(b2.lBefore).toBe(b0.lAfter);
    expect([b3.lBefore, b3.lAfter]).toEqual([b2.lAfter, b2.lAfter]);
    // The overload lAfter goes to history.
    expect((await repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId).map((b) => b.lAfter)).toEqual(views.map((v) => v.lAfter));
    await playReaction(h);
    h.clock.advance(1);
    await h.c.continueAfterSummary();
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block').L).toBe(b2.lAfter);
  });

  it('overload reaction blocks play the finisher sound with gate all', async () => {
    const repo = new MemoryRepository();
    await repo.saveModuleState(stateWith('pzmr', { lSaved: 5, lastTrainedAt: YESTERDAY, lifetimeBlocks: 10 }));
    await repo.saveModuleState(stateWith('pomeh', { lSaved: 17, lastTrainedAt: YESTERDAY, lifetimeBlocks: 10 }));
    const h = await begin(training(overloadSegment('pzmr', 'finisher', 1), overloadSegment('pomeh', 'finisher', 1)), { repo });
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block').layers).toMatchObject({ noise: null, audio: FINISHER_AUDIO, gate: 'all' });
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    h.clock.advance(1);
    await h.c.continueAfterSummary();
    h.c.ackInstruction();
    const pomehBlock = expectStep(h.c, 'reaction_block');
    // A band module's finisher plays L_saved with the next band's load (F3): L 17 is band 4, the load band 5's.
    expect(pomehBlock.L).toBe(17);
    // pomeh's own sound in band 5 is hum, beeps and metronome at 0.75, the finisher's hum, beeps and babble at 0.8: only
    // a merge has all four layers at 0.8 (keeping its own sound loses the babble, taking the finisher's the metronome).
    // The noise stays.
    expect(pomeh.params(17, 5).audio).toEqual({ layers: ['hum', 'beeps', 'metronome'], gain: 0.75 });
    expect(pomehBlock.layers).toMatchObject({
      noise: pomeh.params(17, 5).noise,
      audio: { layers: ['hum', 'beeps', 'metronome', 'babble'], gain: 0.8 },
      gate: 'all',
    });

    // From band 6 pomeh's own sound has all four layers at 1, so only a merge keeps the metronome and the gain.
    const high = new MemoryRepository();
    await high.saveModuleState(stateWith('pomeh', { lSaved: 33, lastTrainedAt: YESTERDAY, lifetimeBlocks: 10 }));
    const h36 = await begin(training(overloadSegment('pomeh', 'finisher', 1)), { repo: high });
    h36.c.ackInstruction();
    const top = expectStep(h36.c, 'reaction_block');
    expect(top.L).toBe(33);
    expect(pomeh.params(33, 9).audio).toEqual({ layers: ['hum', 'beeps', 'metronome', 'babble'], gain: 1 });
    expect(top.layers).toMatchObject({ audio: { layers: ['hum', 'beeps', 'metronome', 'babble'], gain: 1 }, gate: 'all' });
  });

  it('a pomeh overload block names its conditions by the figures and announces the sound once (M2)', async () => {
    const repo = new MemoryRepository();
    await repo.saveModuleState(stateWith('pomeh', { lSaved: 17, lastTrainedAt: YESTERDAY, lifetimeBlocks: 10 }));
    const h = await begin(training(overloadSegment('pomeh', 'finisher', 1)), { repo });
    const { text } = expectStep(h.c, 'instruction');
    // L 17 is band 4; the block plays band 5's load (F3).
    const played = pomeh.params(17, 5);
    expect(text).toBe(overloadBandPrefix(played.bandLabel) + pomeh.instruction('keyboard', played, true) + ` Нагрузка: ${played.bandLabel}.`);
    expect(text).not.toContain('В части блока');
    // The window at L 17 is 199 ms.
    expect(pomeh.params(17).windowMs).toBe(199);
    const slowerOnNoisy: Respond = (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      return r === null ? null : { ...r, rtMs: spec.cond === 'noisy' ? 170 : 135 };
    };
    const { view } = await playReaction(h, slowerOnNoisy);
    expect(view.lines.slice(-3)).toEqual(['Без отвлекающих фигур: 135 мс', 'С отвлекающими фигурами: 170 мс', 'Разница: +35 мс']);
  });

  it('overload blocks are left out of fatigue and the g = 2 rule', async () => {
    const repo = await trainedRepo('szmr', 10);
    const h = await begin(training(overloadSegment('szmr', 'mix', 2 * MIN)), { repo });
    // Block 0: s < 0.95 (no boost after it); block 1 (overload): s = 1; block 2: perfect.
    const missFirstThree: Respond = (spec, idx) => (idx < 3 ? null : perfectPlayer(spec, idx));
    const [b0] = await playSegment(h, 1, missFirstThree);
    const [b1, b2] = await playSegment(h, 2);
    expect(b0?.score).toBeLessThan(0.95);
    expect(b1).toMatchObject({ score: 1, flags: ['overload'] });
    // prevScoreSameSession of block 2 is block 0's s, so g = 1: ΔL = (1 − 0.8)/0.2 = 1, not 2.
    expect(b2?.lAfter).toBe((b2?.lBefore ?? NaN) + 1);

    // Fatigue: a finisher of tiring overload blocks never prompts.
    let blockNo = 0;
    const tiring: Respond = (spec, idx) => {
      if (idx === 0) blockNo++;
      if (blockNo <= 2) return perfectPlayer(spec, idx);
      if (idx % 10 < 3) return null;
      const e = spec.expected;
      return e.kind === 'press' ? { key: e.key, rtMs: 400 } : perfectPlayer(spec, idx);
    };
    const f = await begin(training(overloadSegment('szmr', 'finisher')), { repo: await trainedRepo('szmr', 10) });
    const views = await playSegment(f, 6, tiring);
    expect(views.every((v) => v.flags.includes('overload') && !v.flags.includes('fatigued'))).toBe(true);
    expect(f.c.step.kind).not.toBe('fatigue_prompt');
  });

  it('overload table blocks play at L + 3 without sound', async () => {
    const repo = await calibratedRepo(stateWith('schulte', { lSaved: 5, lastTrainedAt: T0, lifetimeBlocks: 3 }));
    const h = await begin(training(overloadSegment('schulte', 'mix')), { repo });
    h.c.ackInstruction();
    const first = expectStep(h.c, 'table_block');
    expect(first.L).toBe(4);
    await h.c.submitTable(perfectTableRun(first));
    const firstView = expectStep(h.c, 'summary').view;
    await h.c.continueAfterSummary();
    h.c.ackInstruction();
    const over = expectStep(h.c, 'table_block');
    expect(over.L).toBe(firstView.lAfter + 3);
    expect(over).not.toHaveProperty('layers');
    await h.c.submitTable(perfectTableRun(over));
    expect(expectStep(h.c, 'summary').view.flags).toEqual(['overload']);
  });

  it('the instruction announces an overload block', async () => {
    const repo = await trainedRepo('szmr', 10);
    const h = await begin(training(overloadSegment('szmr', 'mix')), { repo });
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      texts.push(expectStep(h.c, 'instruction').text);
      h.clock.advance(30_000);
      await playReaction(h);
      await h.c.continueAfterSummary();
    }
    // Block 1 at L 11 (band 2) plays band 3's load (Р16).
    expect(texts[0]?.startsWith('Блок с перегрузкой')).toBe(false);
    expect(texts[1]?.startsWith(overloadBandPrefix('4 цвета на 4 клавиши'))).toBe(true);
    expect(texts[2]?.startsWith('Блок с перегрузкой')).toBe(false);
  });
});

describe('SessionController — save errors', () => {
  type Op =
    | 'createSession'
    | 'addBlock'
    | 'saveModuleState'
    | 'saveRatings'
    | 'finishSession'
    | 'addDiagnostic'
    | 'addWellbeing'
    | 'appendLog';

  class FlakyRepo extends MemoryRepository {
    readonly failures: Partial<Record<Op, number>> = {};
    readonly calls: Op[] = [];
    private check(op: Op): void {
      this.calls.push(op);
      const left = this.failures[op] ?? 0;
      if (left > 0) {
        this.failures[op] = left - 1;
        throw new Error(`${op}: disk I/O error`);
      }
    }
    override async createSession(...a: Parameters<MemoryRepository['createSession']>): Promise<void> {
      this.check('createSession');
      await super.createSession(...a);
    }
    override async addBlock(...a: Parameters<MemoryRepository['addBlock']>): Promise<void> {
      this.check('addBlock');
      await super.addBlock(...a);
    }
    override async saveModuleState(...a: Parameters<MemoryRepository['saveModuleState']>): Promise<void> {
      this.check('saveModuleState');
      await super.saveModuleState(...a);
    }
    override async saveRatings(...a: Parameters<MemoryRepository['saveRatings']>): Promise<void> {
      this.check('saveRatings');
      await super.saveRatings(...a);
    }
    override async finishSession(...a: Parameters<MemoryRepository['finishSession']>): Promise<void> {
      this.check('finishSession');
      await super.finishSession(...a);
    }
    override async addDiagnostic(...a: Parameters<MemoryRepository['addDiagnostic']>): Promise<void> {
      this.check('addDiagnostic');
      await super.addDiagnostic(...a);
    }
    override async addWellbeing(...a: Parameters<MemoryRepository['addWellbeing']>): Promise<void> {
      this.check('addWellbeing');
      await super.addWellbeing(...a);
    }
    override async appendLog(...a: Parameters<MemoryRepository['appendLog']>): Promise<void> {
      this.check('appendLog');
      await super.appendLog(...a);
    }
  }

  it('abandonPending drops an unsaved block: no row, level unchanged, the next block follows; logged (R27)', async () => {
    const repo = new FlakyRepo();
    const h = await begin(planFree('pzmr', 1), { repo });
    await playReaction(h); // block 1 stored: L 0 → 2
    await h.c.continueAfterSummary();
    const second = expectStep(h.c, 'reaction_block');
    repo.failures.addBlock = 3;
    await h.c.submitReaction(playTimeline(second.specs, perfectPlayer));
    expect(expectStep(h.c, 'save_error')).toMatchObject({ canAbandon: true, what: 'block' });
    await h.c.abandonPending();

    const third = expectStep(h.c, 'reaction_block');
    expect(third.L).toBe(2);
    expect(unjittered(third.specs)).toEqual(pzmr.generateBlock(pzmr.params(2), createRng(deriveSeed(1, '0:2:0')), 'keyboard', 15));
    expect(await repo.listBlocks()).toHaveLength(1);
    const [log] = await repo.listLog(10);
    expect(log).toMatchObject({ level: 'error', message: 'session: unsaved pzmr block skipped' });
    expect(JSON.parse(log?.detail ?? '')).toEqual({
      sessionId: h.c.sessionId,
      dropped: ['addBlock', 'commit', 'saveModuleState'],
      error: 'addBlock: disk I/O error',
    });

    // The dropped block left no trace: block 4 is still calibration (lifetime 0 + blocks 1 and 3 < 3).
    await h.c.submitReaction(playTimeline(third.specs, perfectPlayer));
    // Nor did it enter the history: block 3 compares with block 1 (with block 2 it would read «(ур. 2)»).
    expect(expectStep(h.c, 'summary').view.assessment?.history).toBe(
      'Раньше в этом блоке: прошлый раз 300 мс (ур. 0) · лучший 300 мс · в среднем за 7 дней 300 мс',
    );
    await h.c.continueAfterSummary();
    const fourth = await playReaction(h);
    expect(fourth.view.flags).toEqual(['calibration']);
    expect((await repo.getModuleStates()).pzmr.lifetimeBlocks).toBe(3);
  });

  it('abandonPending after the block was stored keeps it; the next state write catches the cache up', async () => {
    const repo = new FlakyRepo();
    const h = await begin(planFree('pzmr', 1), { repo });
    h.c.ackInstruction();
    repo.failures.saveModuleState = 3;
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    expect(expectStep(h.c, 'save_error')).toMatchObject({ canAbandon: true, what: 'block_cache' });
    await h.c.abandonPending();
    const next = expectStep(h.c, 'reaction_block');
    expect(next.L).toBe(2); // the stored block counts, and the next block has the next index
    expect(unjittered(next.specs)).toEqual(pzmr.generateBlock(pzmr.params(2), createRng(deriveSeed(1, '0:1:0')), 'keyboard', 15));
    expect(await repo.listBlocks()).toHaveLength(1);
    expect((await repo.getModuleStates()).pzmr.lifetimeBlocks).toBe(0);
    expect(JSON.parse((await repo.listLog(1))[0]?.detail ?? '')).toMatchObject({ dropped: ['saveModuleState'] });
    await h.c.submitReaction(playTimeline(next.specs, perfectPlayer));
    expect((await repo.getModuleStates()).pzmr.lifetimeBlocks).toBe(2);
  });

  it('abandonPending still moves on when the log cannot be written', async () => {
    const repo = new FlakyRepo();
    const h = await begin(planFree('pzmr', 1), { repo });
    h.c.ackInstruction();
    repo.failures.addBlock = 3;
    repo.failures.appendLog = 1;
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    await h.c.abandonPending();
    expect(expectStep(h.c, 'reaction_block').L).toBe(0);
    expect(await repo.listLog(10)).toEqual([]);
  });

  it('the session row cannot be skipped', async () => {
    const repo = new FlakyRepo();
    repo.failures.createSession = 3;
    const h = await begin(planFree('pzmr', 1), { repo });
    expect(expectStep(h.c, 'save_error')).toMatchObject({ canAbandon: false, what: 'session_start' });
    await expect(h.c.abandonPending()).rejects.toThrow(/session start/);
    expectStep(h.c, 'save_error');
    await expect(h.c.abandonPending.call(h.c)).rejects.toThrow();
  });

  it('skipping the session end writes still reaches done', async () => {
    const repo = new FlakyRepo();
    const h = await begin(planFree('pzmr', 1), { repo });
    repo.failures.finishSession = 3;
    await drive(h, { blockMs: 6 * MIN }).catch(() => undefined);
    expect(expectStep(h.c, 'save_error')).toMatchObject({ canAbandon: true, what: 'session_end' });
    await h.c.abandonPending();
    expectStep(h.c, 'done');
    expect((await repo.listSessions())[0]?.endedAt).toBeNull();
  });

  it('a diagnostic block that cannot be saved is skipped: next segment, its metric stays null', async () => {
    const repo = new FlakyRepo();
    const h = await begin(planDiagnostic(1), { repo, scale: 0.02 });
    h.c.ackInstruction();
    repo.failures.addBlock = 3;
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    await h.c.abandonPending();
    expect(expectStep(h.c, 'instruction').module).toBe('szmr');
    await drive(h);
    const done = expectStep(h.c, 'done');
    expect(done.diagnostic).toMatchObject({ pzmrMedianRt: null, szmrMedianRt: 300 });
  });

  it('save error retries then shows save_error, retrySave succeeds', async () => {
    const repo = new FlakyRepo();
    const h = await begin(planFree('pzmr', 1), { repo });
    repo.failures.addBlock = 3;
    h.c.ackInstruction();
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    const err = expectStep(h.c, 'save_error');
    expect(err.message).toContain('addBlock: disk I/O error');
    expect(h.sleeps).toEqual([100, 500]);
    expect(repo.calls.filter((c) => c === 'addBlock')).toHaveLength(3);
    expect(await repo.listBlocks()).toEqual([]);

    await h.c.retrySave();
    const summary = expectStep(h.c, 'summary');
    expect(summary.view.lAfter).toBe(2);
    expect(await repo.listBlocks()).toHaveLength(1);
    expect((await repo.getModuleStates()).pzmr.lifetimeBlocks).toBe(1);
  });

  it('a block stored on retrySave enters the history once (A-R19)', async () => {
    const repo = new FlakyRepo();
    const h = await begin(planFree('pzmr', 1), { repo });
    // 3 misses of 15: s = 0.8 keeps the level, so the three blocks play one load band, one history variant (Р29).
    const rt = (ms: number): Respond => (spec, idx) => {
      const p = perfectPlayer(spec, idx);
      return p === null || idx < 3 ? null : { ...p, rtMs: ms };
    };
    repo.failures.addBlock = 3;
    h.c.ackInstruction();
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, rt(300)));
    expectStep(h.c, 'save_error');
    await h.c.retrySave();
    expectStep(h.c, 'summary');
    await h.c.continueAfterSummary();
    await playReaction(h, rt(360));
    await h.c.continueAfterSummary();
    const third = await playReaction(h, rt(450));
    // (300 + 360) / 2 = 330; block 1 counted twice would make it (300 + 300 + 360) / 3 = 320.
    expect(third.view.assessment?.history).toMatch(
      /^Раньше в этом блоке: прошлый раз 360 мс \(ур\. 0\) · лучший 300 мс · в среднем за 7 дней 330 мс$/,
    );
    expect(await repo.listBlocks()).toHaveLength(3);
  });

  it('a failure after the block was stored repeats only what is left', async () => {
    const repo = new FlakyRepo();
    const h = await begin(planFree('pzmr', 1), { repo });
    repo.failures.saveModuleState = 6;
    h.c.ackInstruction();
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    expectStep(h.c, 'save_error');
    await h.c.retrySave(); // 3 more failures (6 in total) → still an error
    expectStep(h.c, 'save_error');
    expect(h.sleeps).toEqual([100, 500, 100, 500]);
    await h.c.retrySave();
    expectStep(h.c, 'summary');
    expect(repo.calls.filter((c) => c === 'addBlock')).toHaveLength(1);
    expect(await repo.listBlocks()).toHaveLength(1);
    expect((await repo.getModuleStates()).pzmr.lifetimeBlocks).toBe(1);
  });

  it('an addBlock that committed but reported a failure is not written twice on retry (M8)', async () => {
    class CommitThenThrow extends MemoryRepository {
      addCalls = 0;
      hasCalls = 0;
      override async addBlock(...a: Parameters<MemoryRepository['addBlock']>): Promise<void> {
        this.addCalls++;
        await super.addBlock(...a);
        if (this.addCalls === 1) throw new Error('connection reset after commit');
      }
      override async hasBlock(id: string): Promise<boolean> {
        this.hasCalls++;
        return super.hasBlock(id);
      }
    }
    const repo = new CommitThenThrow();
    const h = await begin(planFree('pzmr', 1), { repo });
    h.c.ackInstruction();
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    expectStep(h.c, 'summary');
    expect(repo.addCalls).toBe(1);
    expect(repo.hasCalls).toBe(1);
    expect(await repo.listBlocks()).toHaveLength(1);
    expect((await repo.getModuleStates()).pzmr.lifetimeBlocks).toBe(1);
  });

  it('one failure is retried silently', async () => {
    const repo = new FlakyRepo();
    const h = await begin(planFree('pzmr', 1), { repo });
    repo.failures.addBlock = 1;
    h.c.ackInstruction();
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    expectStep(h.c, 'summary');
    expect(h.sleeps).toEqual([100]);
  });

  it('session start and end writes go through the same retry', async () => {
    const repo = new FlakyRepo();
    repo.failures.createSession = 3;
    const h = await begin(planFree('pzmr', 1), { repo });
    expectStep(h.c, 'save_error');
    await h.c.retrySave();
    expectStep(h.c, 'instruction');
    expect(await repo.listSessions()).toHaveLength(1);

    repo.failures.finishSession = 3;
    const seen = await drive(h, { blockMs: 2 * MIN }).catch((e: unknown) => e);
    expect(String(seen)).toContain('finishSession');
    expectStep(h.c, 'save_error');
    await h.c.retrySave();
    expectStep(h.c, 'done');
    expect((await repo.listSessions())[0]?.endedAt).not.toBeNull();
  });

  it('wellbeing write failure keeps the answers and retries them', async () => {
    const repo = new FlakyRepo();
    const h = await begin({ kind: 'training', seed: 1, segments: [segment('pzmr', 1)] }, { repo });
    await playReaction(h);
    h.clock.advance(1);
    await h.c.continueAfterSummary();
    expectStep(h.c, 'wellbeing');
    repo.failures.addWellbeing = 3;
    await h.c.submitWellbeing({ sleepH: 6.5, caffeine: false, mood: 3 });
    expect(expectStep(h.c, 'save_error').what).toBe('session_end');
    await h.c.retrySave();
    expectStep(h.c, 'done');
    expect(await repo.listWellbeing()).toMatchObject([{ sleepH: 6.5, caffeine: false, mood: 3, date: '2026-10-14' }]);
  });
});

describe('SessionController — wellbeing', () => {
  it('training ends with wellbeing on the local date, then done', async () => {
    const h = await begin({ kind: 'training', seed: 1, segments: [segment('pzmr', 1)] }, { clock: new Clock('2026-10-14T23:30:00') });
    await playReaction(h);
    h.clock.advance(1);
    await h.c.continueAfterSummary();
    expectStep(h.c, 'wellbeing');
    await h.c.submitWellbeing({ sleepH: 7.5, caffeine: true, mood: 4 });
    expectStep(h.c, 'done');
    const [w] = await h.repo.listWellbeing();
    expect(w).toMatchObject({ date: '2026-10-14', sleepH: 7.5, caffeine: true, mood: 4 });
    expect(w?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('skipped wellbeing writes nothing', async () => {
    const h = await begin({ kind: 'training', seed: 1, segments: [segment('pzmr', 1)] });
    const seen = await drive(h, { wellbeing: null });
    expect(seen.slice(-2)).toEqual(['wellbeing', 'done']);
    expect(await h.repo.listWellbeing()).toEqual([]);
  });
});

describe('SessionController — tables', () => {
  it('gorbov runs cycle the tasks with an instruction before each; table rows keep clicks', async () => {
    const h = await begin(planFree('gorbov', 4));
    const seen = await drive(h, { blockMs: 70_000 });
    expect(seen).toEqual([
      'instruction:gorbov',
      'table_block:gorbov:black_up',
      'summary',
      'instruction:gorbov',
      'table_block:gorbov:red_down',
      'summary',
      'instruction:gorbov',
      'table_block:gorbov:alternate',
      'summary',
      'instruction:gorbov',
      'table_block:gorbov:black_up',
      'summary',
      'instruction:gorbov',
      'table_block:gorbov:red_down',
      'summary',
      'done',
    ]);
    const blocks = await h.repo.listBlocks();
    expect(JSON.parse(blocks[2]?.paramsJson ?? '')).toMatchObject({ task: 'alternate', size: 7 });
    const summary = JSON.parse(blocks[0]?.summaryJson ?? '') as { completed: boolean; clicks: unknown[]; task: string };
    expect(summary).toMatchObject({ task: 'black_up', completed: true, errors: 0 });
    expect(summary.clicks).toHaveLength(24);
    expect(await h.repo.listAllTrials()).toEqual([]);
  });

  it('table step: seed, cells and params; summary lines and changes', async () => {
    const h = await begin(planFree('schulte', 8));
    h.c.ackInstruction();
    const step = expectStep(h.c, 'table_block');
    expect(step.seed).toBe(deriveSeed(8, '0:0:0'));
    expect(step.cells).toHaveLength(25);
    expect(step.params).toEqual({ size: 5, timeLimitMs: 60_000, reshuffleEvery: null });
    const run = perfectTableRun(step, 1000);
    run.clicks.splice(3, 0, { cell: { value: 9, color: 'black' }, ts: 3500 });
    await h.c.submitTable(run);
    const { view } = expectStep(h.c, 'summary');
    expect(view).toMatchObject({
      module: 'schulte',
      title: 'Таблицы Шульте',
      lBefore: 0,
      score: 24 / 25,
      lines: ['Время: 25,0 с', 'Ошибки: 1'],
      flags: ['calibration'],
    });
    expect(view.lAfter).toBeCloseTo(2 * (24 / 25 - 0.8) / 0.2, 9);
    expect(view.changes.map((ch) => ch.label)).toEqual(['Лимит времени']);
  });

  it('a restart of block 0 deals a new table, of blocks 1–2 keeps it; block 3 has its own (F10)', async () => {
    const h = await begin(planFree('gorbov', 4));
    const next = (): StepOf<'table_block'> => {
      if (h.c.step.kind === 'instruction') h.c.ackInstruction();
      return expectStep(h.c, 'table_block');
    };
    const finish = async (step: StepOf<'table_block'>): Promise<void> => {
      await h.c.submitTable(perfectTableRun(step));
      await h.c.continueAfterSummary();
    };
    const first = next();
    expect(first.cells).toEqual(generateGorbovTable(createRng(trainingBlockSeed(4, 0, 0, 0))));
    expect(await h.c.discardBlock('focus_lost', 0.5)).toEqual({ kind: 'restarted' });
    const again = next();
    const tableSeed = trainingBlockSeed(4, 0, 0, 1);
    expect(again.seed).toBe(tableSeed);
    expect(again.cells).toEqual(generateGorbovTable(createRng(tableSeed)));
    expect(again.cells).not.toEqual(first.cells);
    await finish(again);
    const second = next();
    expect(second).toMatchObject({ task: 'red_down', seed: trainingBlockSeed(4, 0, 1, 0), cells: again.cells });
    await h.c.discardBlock('focus_lost', 0.5);
    const secondAgain = next();
    expect(secondAgain.seed).toBe(trainingBlockSeed(4, 0, 1, 1));
    expect(secondAgain.cells).toEqual(again.cells);
    await finish(secondAgain);
    const third = next();
    expect(third).toMatchObject({ task: 'alternate', cells: again.cells });
    await finish(third);
    const own = next();
    expect(own.cells).toEqual(generateGorbovTable(createRng(trainingBlockSeed(4, 0, 3, 0))));
    await finish(own);
    const params = (await h.repo.listBlocks()).map((b) => JSON.parse(b.paramsJson) as { table: string; tableSeed: number });
    expect(params.map((p) => [p.table, p.tableSeed])).toEqual([
      ['series', tableSeed],
      ['series', tableSeed],
      ['series', tableSeed],
      ['own', trainingBlockSeed(4, 0, 3, 0)],
    ]);
  });

  it('a counted Esc on block 0 keeps its table: block 1 plays it and stores its seed (T-R62)', async () => {
    const h = await begin(planFree('gorbov', 4));
    h.c.ackInstruction();
    const first = expectStep(h.c, 'table_block');
    const tableSeed = trainingBlockSeed(4, 0, 0, 0);
    expect(first.cells).toEqual(generateGorbovTable(createRng(tableSeed)));
    expect(await h.c.discardBlock('user', 0.5)).toMatchObject({ kind: 'counted' });
    if (h.c.step.kind === 'instruction') h.c.ackInstruction();
    const second = expectStep(h.c, 'table_block');
    expect(second).toMatchObject({ task: 'red_down', seed: trainingBlockSeed(4, 0, 1, 0), cells: first.cells });
    await h.c.submitTable(perfectTableRun(second));
    const rows = await h.repo.listBlocks();
    expect(rows.map((b) => b.flags.includes('discarded'))).toEqual([true, false]);
    expect(rows.map((b) => (JSON.parse(b.paramsJson) as { tableSeed: number }).tableSeed)).toEqual([tableSeed, tableSeed]);
  });

  it('«what changed» after a normal series block names no reshuffle: the series never reshuffles (T-R62)', async () => {
    // L_saved 15: the segment starts at 14, below the reshuffle (from L 15), and a perfect run lifts it above.
    const repo = await calibratedRepo(stateWith('gorbov', { lSaved: 15, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    const h = await begin(planFree('gorbov', 4), { repo });
    h.c.ackInstruction();
    const step = expectStep(h.c, 'table_block');
    expect(step.params.reshuffleEvery).toBeNull();
    await h.c.submitTable(perfectTableRun(step));
    const { view } = expectStep(h.c, 'summary');
    expect(view.lBefore).toBe(14);
    expect(view.lAfter).toBeGreaterThanOrEqual(15);
    expect(gorbovParams(view.lAfter, 'black_up').reshuffleEvery).not.toBeNull();
    expect(view.changes.map((ch) => ch.label)).toEqual(['Лимит времени']);
    // The next block of the series plays as the summary says: no reshuffle.
    await h.c.continueAfterSummary();
    if (h.c.step.kind === 'instruction') h.c.ackInstruction();
    expect(expectStep(h.c, 'table_block').params.reshuffleEvery).toBeNull();
  });

  it('«what changed» after series block 2 describes the next block, an own table that may reshuffle (T-R65)', async () => {
    const repo = await calibratedRepo(stateWith('gorbov', { lSaved: 15, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    const h = await begin(planFree('gorbov', 4), { repo });
    const views: BlockSummaryView[] = [];
    for (let k = 0; k < 3; k++) {
      if (h.c.step.kind === 'instruction') h.c.ackInstruction();
      const step = expectStep(h.c, 'table_block');
      expect(step.params.reshuffleEvery).toBeNull();
      await h.c.submitTable(perfectTableRun(step));
      views.push(expectStep(h.c, 'summary').view);
      await h.c.continueAfterSummary();
    }
    const [, second, third] = views;
    // Block 1 → block 2: both of the series, no reshuffle on either side.
    expect(second?.changes.map((ch) => ch.label)).toEqual(['Лимит времени']);
    // Block 2 → block 3: block 3 deals its own table and reshuffles from L 15.
    expect(third?.lAfter).toBeGreaterThanOrEqual(15);
    const after = gorbovParams(third?.lAfter ?? 0, 'alternate');
    expect(after.reshuffleEvery).not.toBeNull();
    expect(third?.changes.map((ch) => ch.label)).toEqual(['Лимит времени', 'Перемешивание']);
    if (h.c.step.kind === 'instruction') h.c.ackInstruction();
    expect(expectStep(h.c, 'table_block').params.reshuffleEvery).not.toBeNull();
  });

  it('a run of another task or time limit is rejected', async () => {
    const h = await begin(planFree('gorbov', 4));
    h.c.ackInstruction();
    const step = expectStep(h.c, 'table_block');
    await expect(h.c.submitTable({ ...perfectTableRun(step), task: 'red_down', total: 25 })).rejects.toThrow(/task/);
    await expect(h.c.submitTable({ ...perfectTableRun(step), timeLimitMs: 1 })).rejects.toThrow(/time limit/);
    expectStep(h.c, 'table_block');
  });
});

describe('SessionController — memory', () => {
  /** Acks the instruction (if any) and returns the memory block on screen. */
  function memoryBlock(h: Harness): StepOf<'memory_block'> {
    if (h.c.step.kind === 'instruction') h.c.ackInstruction();
    return expectStep(h.c, 'memory_block');
  }

  it('memory block in free training raises the level for a perfect player', async () => {
    const h = await begin(planFree('memory', 3));
    expect(expectStep(h.c, 'instruction')).toMatchObject({
      module: 'memory',
      text: memoryInstruction('digits', memoryParams(0, 'digits')),
      keysHint: 'Цифры, Backspace, Enter',
    });
    const block = memoryBlock(h);
    expect(block).toMatchObject({ kind: 'memory_block', L: 0, mode: 'digits', params: memoryParams(0, 'digits'), protocol: 'fixed', audio: null });
    expect(block.trials).toEqual(generateMemoryTrials(memoryParams(0, 'digits'), 'digits', 10, createRng(deriveSeed(3, '0:0:0'))));
    await h.c.submitMemory(perfectMemoryAnswers(block.trials));
    const { view } = expectStep(h.c, 'summary');
    expect(view).toMatchObject({
      module: 'memory',
      title: 'Память',
      lBefore: 0,
      score: 1,
      lines: ['Верных позиций: 100 % · точных рядов: 10 из 10 · длина 4 (цифры)'],
      flags: ['calibration'],
      showLevel: true,
    });
    expect(view.lAfter).toBeGreaterThan(0);
    expect(view.changes).toEqual(describeChanges('memory', 0, view.lAfter, 'digits'));
    expect(view.changes.length).toBeGreaterThan(0);
    const [row] = await h.repo.listBlocks();
    expect(row).toMatchObject({ module: 'memory', lBefore: 0, lAfter: view.lAfter, score: 1 });
    expect(JSON.parse(row?.summaryJson ?? '')).toEqual({
      mode: 'digits',
      length: 4,
      exposureMs: null,
      sound: false,
      exact: 10,
      positionsCorrect: 40,
      partial: 1,
      answers: perfectMemoryAnswers(block.trials),
    });
    expect(JSON.parse(row?.paramsJson ?? '')).toEqual({ mode: 'digits', ...memoryParams(0, 'digits'), trials: 10 });
    expect((await h.repo.getModuleStates()).memory.lifetimeBlocks).toBe(1);
  });

  it('s is the share of positions right', async () => {
    // L_saved 10 a day ago: the block plays L 9, digits 7 long.
    const repo = await calibratedRepo(stateWith('memory', { lSaved: 10, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    const h = await begin(planFree('memory', 3), { repo });
    const block = memoryBlock(h);
    expect(block.trials.map((t) => t.items.length)).toEqual(Array<number>(10).fill(7));
    // 4 rows exact; then four with 5 of 7 in place and two with 4: 28 + 20 + 8 = 56 of 70.
    const inPlace = [7, 7, 7, 7, 5, 5, 5, 5, 4, 4];
    const answers: MemoryAnswer[] = block.trials.map((t, i) => ({
      given: t.items.map((x, k) => (k < (inPlace[i] ?? 0) ? x : String((Number(x) + 1) % 10))),
      timeMs: 3000,
    }));
    await h.c.submitMemory(answers);
    const { view } = expectStep(h.c, 'summary');
    expect(view.score).toBeCloseTo(0.8, 12);
    expect(view.lines).toEqual(['Верных позиций: 80 % · точных рядов: 4 из 10 · длина 7 (цифры)']);
    const [row] = (await h.repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId);
    expect(row?.score).toBeCloseTo(0.8, 12);
    expect(JSON.parse(row?.summaryJson ?? '')).toMatchObject({ exact: 4, positionsCorrect: 56, partial: 56 / 70 });
    // s = 0.8 holds the level.
    expect(view.lAfter).toBe(9);
  });

  it('modes cycle by block, each with its instruction; the level carries on', async () => {
    const h = await begin(planFree('memory', 5));
    const modes: string[] = [];
    for (let i = 0; i < 4; i++) {
      if (h.c.step.kind === 'lesson') h.c.ackLesson();
      expectStep(h.c, 'instruction');
      const block = memoryBlock(h);
      modes.push(block.mode);
      expect(block.params).toEqual(memoryParams(block.L, block.mode));
      h.clock.advance(10_000);
      await h.c.submitMemory(perfectMemoryAnswers(block.trials));
      const { view } = expectStep(h.c, 'summary');
      expect(view.lBefore).toBe(block.L);
      expect(view.changes).toEqual(describeChanges('memory', block.L, view.lAfter, block.mode));
      await h.c.continueAfterSummary();
    }
    expect(modes).toEqual(['digits', 'positions', 'card3x3', 'letters']);
  });

  it('the strategy lesson comes once, before the first 3×3 card', async () => {
    const h = await begin(planFree('memory', 5));
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = h.c.step;
      seen.push(s.kind);
      if (s.kind === 'lesson') {
        expect(s.lines).toEqual(CARD_LESSON);
        expect(() => {
          h.c.ackInstruction();
        }).toThrow(/expected step instruction/);
        h.c.ackLesson();
        seen.push(h.c.step.kind);
      }
      expect(expectStep(h.c, 'instruction').text.endsWith(i === 2 ? ' Стратегия: читай строки как трёхзначные числа.' : 'Enter.')).toBe(true);
      const block = memoryBlock(h);
      h.clock.advance(10_000);
      await h.c.submitMemory(perfectMemoryAnswers(block.trials));
      await h.c.continueAfterSummary();
    }
    expect(seen).toEqual(['instruction', 'instruction', 'lesson', 'instruction']);
    expect(() => {
      h.c.ackLesson();
    }).toThrow(/expected step lesson/);
    // The card stored: the next 3×3 card, in this session or another, comes without the lesson.
    for (let i = 3; i < 7; i++) {
      expectStep(h.c, 'instruction');
      const block = memoryBlock(h);
      h.clock.advance(10_000);
      await h.c.submitMemory(perfectMemoryAnswers(block.trials));
      await h.c.continueAfterSummary();
    }
    const again = await begin(planFree('memory', 5), { repo: h.repo });
    for (let i = 0; i < 3; i++) {
      expectStep(again.c, 'instruction');
      await again.c.submitMemory(perfectMemoryAnswers(memoryBlock(again).trials));
      await again.c.continueAfterSummary();
    }
    expectStep(again.c, 'instruction');
  });

  it('no lesson with a 3×3 card in the history, nor without a readable history (Р18)', async () => {
    const yesterday = new Date(new Date(T0).getTime() - DAY).toISOString();
    const played = new MemoryRepository();
    await played.createSession(session('s0', yesterday, { kind: 'free', endedAt: yesterday }));
    // A block counted as 0 after Esc names its mode in its params only.
    const paramsJson = JSON.stringify({ mode: 'card3x3', ...memoryParams(0, 'card3x3'), trials: 10 });
    await played.addBlock(block('b0', 's0', yesterday, { module: 'memory', paramsJson, flags: ['discarded'], summaryJson: '{}' }), [], []);
    const unread = new MemoryRepository();
    vi.spyOn(unread, 'listBlocks').mockRejectedValueOnce(new Error('disk I/O error'));
    for (const repo of [played, unread]) {
      const h = await begin(planFree('memory', 5), { repo });
      for (let i = 0; i < 2; i++) {
        await h.c.submitMemory(perfectMemoryAnswers(memoryBlock(h).trials));
        await h.c.continueAfterSummary();
      }
      expect(expectStep(h.c, 'instruction').text).toMatch(/^На карточке/);
    }
  });

  it('a 3×3 card with sound carries CARD_AUDIO and says so (F13)', async () => {
    // L_saved 22 today: the segment starts at 21, where the card plays 9 digits for 5 s with sound.
    const repo = await calibratedRepo(stateWith('memory', { lSaved: 22, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    // A card in the history: no lesson in the way.
    await repo.addBlock(block('card', 'calibrated', T0, { module: 'memory', paramsJson: '{"mode":"card3x3"}' }), [], []);
    const h = await begin(planFree('memory', 5), { repo });
    const audios: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const b = memoryBlock(h);
      audios.push(b.audio);
      if (b.mode === 'card3x3') {
        expect(b.trials.every((t) => t.sound && t.cardMs === 5000)).toBe(true);
        // 7 of the 9 positions of every row right (s ≈ 0.78): the level stays where the card has its sound.
        await h.c.submitMemory(b.trials.map((t) => ({ given: t.items.slice(0, 7), timeMs: 3000 })));
        const { view } = expectStep(h.c, 'summary');
        expect(view.lines[0]).toMatch(/ · длина 9 \(карточка 3×3, 5 с, со звуком\)$/);
        const row = (await h.repo.listBlocks()).filter((r) => r.sessionId === h.c.sessionId).at(-1);
        expect(JSON.parse(row?.summaryJson ?? '')).toMatchObject({ mode: 'card3x3', length: 9, exposureMs: 5000, sound: true });
      } else {
        // Answers 0.8 of each row right: the level stays at 21.
        await h.c.submitMemory(b.trials.map((t) => ({ given: t.items.map((x, k) => (k < Math.round(0.8 * t.items.length) ? x : '')), timeMs: 3000 })));
      }
      await h.c.continueAfterSummary();
    }
    expect(audios).toEqual([null, null, CARD_AUDIO]);
  });

  it('a card whose sound never started stores sound: false and says the sound did not play (T-R67)', async () => {
    const repo = await calibratedRepo(stateWith('memory', { lSaved: 22, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    await repo.addBlock(block('card', 'calibrated', T0, { module: 'memory', paramsJson: '{"mode":"card3x3"}' }), [], []);
    const h = await begin(planFree('memory', 5), { repo });
    const lines: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const b = memoryBlock(h);
      const given = (t: (typeof b.trials)[number]) => t.items.map((x, k) => (k < Math.round(0.8 * t.items.length) ? x : ''));
      if (b.mode === 'card3x3') await h.c.submitMemory(b.trials.map((t) => ({ given: given(t), timeMs: 3000 })), false);
      else await h.c.submitMemory(b.trials.map((t) => ({ given: given(t), timeMs: 3000 })));
      lines.push(expectStep(h.c, 'summary').view.lines);
      await h.c.continueAfterSummary();
    }
    const card = lines[2] ?? [];
    expect(card[0]).toMatch(/ · длина 9 \(карточка 3×3, 5 с\)$/);
    expect(card.at(-1)).toBe(AUDIO_NOT_PLAYED);
    // The blocks without sound have no such line.
    expect(lines.slice(0, 2).flat()).not.toContain(AUDIO_NOT_PLAYED);
    const row = (await h.repo.listBlocks()).filter((r) => r.sessionId === h.c.sessionId).at(-1);
    expect(JSON.parse(row?.summaryJson ?? '')).toMatchObject({ mode: 'card3x3', exposureMs: 5000, sound: false });
    // The parameters keep what was planned: a card with sound.
    expect(JSON.parse(row?.paramsJson ?? '')).toMatchObject({ mode: 'card3x3', sound: true });
  });

  it('a card whose sound played keeps sound: true and no note (T-R67)', async () => {
    const repo = await calibratedRepo(stateWith('memory', { lSaved: 22, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    await repo.addBlock(block('card', 'calibrated', T0, { module: 'memory', paramsJson: '{"mode":"card3x3"}' }), [], []);
    const h = await begin(planFree('memory', 5), { repo });
    for (let i = 0; i < 3; i++) {
      const b = memoryBlock(h);
      const answers = b.trials.map((t) => ({ given: t.items.map((x, k) => (k < Math.round(0.8 * t.items.length) ? x : '')), timeMs: 3000 }));
      await h.c.submitMemory(answers, b.mode === 'card3x3' ? true : undefined);
      if (b.mode === 'card3x3') {
        const { view } = expectStep(h.c, 'summary');
        expect(view.lines).toEqual([expect.stringMatching(/ · длина 9 \(карточка 3×3, 5 с, со звуком\)$/)]);
        const row = (await h.repo.listBlocks()).filter((r) => r.sessionId === h.c.sessionId).at(-1);
        expect(JSON.parse(row?.summaryJson ?? '')).toMatchObject({ sound: true });
      }
      await h.c.continueAfterSummary();
    }
  });

  it('discardBlock keeps the memory level', async () => {
    const h = await begin(planFree('memory', 5));
    await h.c.submitMemory(perfectMemoryAnswers(memoryBlock(h).trials));
    const lAfter = expectStep(h.c, 'summary').view.lAfter;
    await h.c.continueAfterSummary();
    const before = memoryBlock(h);
    expect(before.L).toBe(lAfter);
    const blocksBefore = await h.repo.listBlocks();
    expect(await h.c.discardBlock('user', 0)).toEqual({ kind: 'restarted' });
    const after = expectStep(h.c, 'memory_block');
    expect(after.L).toBe(lAfter);
    expect(after.mode).toBe(before.mode);
    expect(after.trials).not.toEqual(before.trials);
    expect(h.c.discards).toEqual([{ module: 'memory', reason: 'user' }]);
    expect(await h.repo.listBlocks()).toEqual(blocksBefore);
  });

  it('wrong answer count is rejected', async () => {
    const h = await begin(planFree('memory', 3));
    const block = memoryBlock(h);
    const answers = perfectMemoryAnswers(block.trials);
    await expect(h.c.submitMemory(answers.slice(1))).rejects.toThrow(RangeError);
    await expect(h.c.submitMemory([...answers, answers[0] as MemoryAnswer])).rejects.toThrow(/11 answers for 10 trials/);
    expectStep(h.c, 'memory_block');
    expect(await h.repo.listBlocks()).toEqual([]);
  });

  it('under the e2e scale a block has 3 trials and s is out of those (W2-R9)', async () => {
    const h = await begin(planFree('memory', 3), { scale: 0.02 });
    const block = memoryBlock(h);
    expect(block.trials).toHaveLength(3);
    await h.c.submitMemory(perfectMemoryAnswers(block.trials));
    const { view } = expectStep(h.c, 'summary');
    expect(view.score).toBe(1);
    expect(view.lines[0]).toBe('Верных позиций: 100 % · точных рядов: 3 из 3 · длина 4 (цифры)');
  });
});

describe('SessionController — number series', () => {
  it('numseries updates ratings', async () => {
    const h = await begin(planFree('numseries', 21));
    h.c.ackInstruction();
    const block = expectStep(h.c, 'numseries_block');
    expect(block.items).toHaveLength(10);
    // Starting ratings (R0): targetD below 1000, 30 s per item (F12).
    expect(block.items.map((it) => it.timeLimitMs)).toEqual(Array<number>(10).fill(30_000));
    expect(block.totalLimitMs).toBeNull();
    const answers = perfectSeriesAnswers(block.items);
    // Right but too slow: not a success for Elo.
    answers[0] = { itemId: block.items[0]?.id ?? '', given: block.items[0]?.answer ?? 0, timeMs: 31_000 };
    // Wrong answer and no answer.
    answers[1] = { itemId: block.items[1]?.id ?? '', given: (block.items[1]?.answer ?? 0) + 1, timeMs: 9000 };
    answers[2] = { itemId: block.items[2]?.id ?? '', given: null, timeMs: 30_000 };
    await h.c.submitNumSeries(answers);

    const { view } = expectStep(h.c, 'summary');
    expect(view).toMatchObject({ module: 'numseries', title: 'Числовые ряды', lBefore: 0, lAfter: 0, changes: [], score: 0.7, flags: [], showLevel: false });
    // (31 + 9 + 30 + 7 · 5) / 10 = 10,5 s; every limit is 30 s, so no limit part.
    expect(view.lines).toEqual(['Верно 7 из 10 · пропущено 0 · среднее время 10,5 с']);

    const items = await h.repo.listLogicItems();
    expect(items).toHaveLength(10);
    expect(items.map((i) => i.correct)).toEqual([true, false, false, true, true, true, true, true, true, true]);
    expect(items[2]).toMatchObject({ given: null, timeMs: 30_000, family: block.items[2]?.family, seed: block.items[2]?.seed });
    expect(items.map((i) => i.timeLimitMs)).toEqual(Array<number>(10).fill(30_000));

    const ratings = await h.repo.getRatings();
    expect(ratings).toEqual(deriveRatings(items)); // incremental == rebuilt from history
    const total = [...ratings.values()].reduce((n, r) => n + r.n, 0);
    expect(total).toBe(10);
    const [blockRow] = await h.repo.listBlocks();
    expect(JSON.parse(blockRow?.summaryJson ?? '')).toMatchObject({ correct: 7, total: 10 });
    expect((await h.repo.getModuleStates()).numseries.lifetimeBlocks).toBe(1);
  });

  it('a skipped item (Space, F12) is stored as skipped and moves its family rating as a failure', async () => {
    const h = await begin(planFree('numseries', 21));
    h.c.ackInstruction();
    const block = expectStep(h.c, 'numseries_block');
    const answers = perfectSeriesAnswers(block.items);
    const skipped = block.items[3];
    answers[3] = { itemId: skipped?.id ?? '', given: null, timeMs: 6500, skipped: true };
    await h.c.submitNumSeries(answers);

    expect(expectStep(h.c, 'summary').view.lines).toEqual([expect.stringMatching(/^Верно 9 из 10 · пропущено 1 · среднее время \d+,\d с$/)]);
    const [row] = await h.repo.listBlocks();
    const summary = JSON.parse(row?.summaryJson ?? '{}') as { correct: number; items: { skipped?: boolean; given: unknown; timeMs: number }[] };
    expect(summary.correct).toBe(9);
    expect(summary.items.map((it) => it.skipped)).toEqual([undefined, undefined, undefined, true, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(summary.items[3]).toMatchObject({ given: null, timeMs: 6500 });
    const items = await h.repo.listLogicItems();
    expect(items[3]).toMatchObject({ given: null, correct: false, timeMs: 6500 });
    // The family of the skipped item moved as on a failure: the same as a wrong answer at the same time.
    const ratings = await h.repo.getRatings();
    expect(ratings).toEqual(deriveRatings(items));
    const wrong = perfectSeriesAnswers(block.items);
    wrong[3] = { itemId: skipped?.id ?? '', given: (skipped?.answer ?? 0) + 1, timeMs: 6500 };
    const other = await begin(planFree('numseries', 21));
    other.c.ackInstruction();
    await other.c.submitNumSeries(wrong);
    expect(await other.repo.getRatings()).toEqual(ratings);
  });

  it('numseries stores per-item limits and names the shortest', async () => {
    const repo = new MemoryRepository();
    await repo.saveRatings(new Map(TRAINING_FAMILIES.map((f) => [f, { rating: 1900, n: 60 }])));
    const h = await begin(planFree('numseries', 21), { repo });
    h.c.ackInstruction();
    const block = expectStep(h.c, 'numseries_block');
    const limits = block.items.map((it) => it.timeLimitMs ?? Number.NaN);
    for (const limit of limits) {
      expect(limit).toBeLessThan(30_000);
      expect(limit).toBeGreaterThanOrEqual(8000);
    }
    await h.c.submitNumSeries(perfectSeriesAnswers(block.items));

    const shortest = Math.min(...limits) / 1000;
    const seconds = Number.isInteger(shortest) ? String(shortest) : shortest.toFixed(1).replace('.', ',');
    const { view } = expectStep(h.c, 'summary');
    expect(view.lines).toEqual([`Верно 10 из 10 · пропущено 0 · среднее время 5,0 с · самый короткий лимит ${seconds} с`]);
    expect((await h.repo.listLogicItems()).map((i) => i.timeLimitMs)).toEqual(limits);
    const [stored] = await h.repo.listBlocks();
    expect(JSON.parse(stored?.paramsJson ?? '')).toEqual({ items: 10, itemLimitsMs: limits, totalLimitMs: null });
  });

  it('later blocks are generated from the updated ratings', async () => {
    const h = await begin(planFree('numseries', 21));
    h.c.ackInstruction();
    await h.c.submitNumSeries(perfectSeriesAnswers(expectStep(h.c, 'numseries_block').items));
    await h.c.continueAfterSummary();
    const second = expectStep(h.c, 'numseries_block');
    const ratings = await h.repo.getRatings();
    const { generateBlockItems } = await import('../modules/numseries/generate');
    const numbers = new Map([...ratings].map(([f, r]) => [f, r.rating]));
    expect(second.items).toEqual(generateBlockItems(numbers, 10, createRng(deriveSeed(21, '0:1:0'))));
  });

  it('answers must match the items of the block', async () => {
    const h = await begin(planFree('numseries', 21));
    h.c.ackInstruction();
    const items = expectStep(h.c, 'numseries_block').items;
    await expect(h.c.submitNumSeries(perfectSeriesAnswers(items).slice(1))).rejects.toThrow(RangeError);
    await expect(h.c.submitNumSeries(perfectSeriesAnswers([...items].reverse()))).rejects.toThrow(RangeError);
    expectStep(h.c, 'numseries_block');
  });
});

/** The F7 values of a diagnostic played by perfectPlayer: every RT 300 ms, every timed answer on target, no errors. */
const PERFECT_F7 = {
  pzmrSdRt: 0,
  szmrSdRt: 0,
  pzmrIqrRt: 0,
  szmrIqrRt: 0,
  pzmrFalseStarts: 0,
  szmrFalseStarts: 0,
  szmrWrong: 0,
  gonogoCommissions: 0,
  gonogoOmissions: 0,
  rdoEarly: 0,
  rdoLate: 0,
  rdoSignedBiasMs: 0,
};

describe('SessionController — diagnostics', () => {
  /** Fails every practice trial (no press), perfect otherwise. */
  const skipsPractice: Respond = (spec, idx) => (spec.practice ? null : perfectPlayer(spec, idx));

  /** The diagnostic with only the six segments of 0.1.0. */
  const w1Only = (n = 1): SessionPlan => {
    const plan = planDiagnostic(n);
    return { ...plan, segments: plan.segments.slice(0, 6) };
  };

  it('diagnostic uses fixed L, ignores module state, writes diagnostic row', async () => {
    const repo = new MemoryRepository();
    const trained = stateWith('pzmr', { lSaved: 20, lastTrainedAt: T0, lifetimeBlocks: 30, sessionEndLevels: [20], savedHistory: [20] });
    await repo.saveModuleState(trained);
    const statesBefore = await repo.getModuleStates();
    const h = await begin(w1Only(), { repo });

    const levels: Array<[string, number]> = [];
    const seen: string[] = [];
    for (let i = 0; i < 200 && h.c.step.kind !== 'done'; i++) {
      const s = h.c.step;
      seen.push(label(s));
      if (s.kind === 'instruction') h.c.ackInstruction();
      else if (s.kind === 'reaction_block') {
        levels.push([s.module, s.L]);
        if (s.module === 'pzmr') {
          const segSeed = diagnosticSegmentSeed(1, 'pzmr');
          const p = pzmr.params(0);
          expect(s.specs).toHaveLength(55);
          expect(s.specs.slice(0, 5)).toEqual(
            pzmr.generateBlock(p, createRng(deriveSeed(segSeed, 'practice')), 'keyboard', 5).map((t) => ({ ...t, practice: true })),
          );
          expect(s.specs.slice(5)).toEqual(pzmr.generateBlock(p, createRng(segSeed), 'keyboard', 50));
        }
        h.clock.advance(MIN);
        await h.c.submitReaction(playTimeline(s.specs, skipsPractice));
        expect(expectStep(h.c, 'summary').view.score).toBe(1); // practice misses do not count
      } else if (s.kind === 'table_block') {
        levels.push([`${s.module}:${s.task}`, s.L]);
        await h.c.submitTable(perfectTableRun(s));
      } else if (s.kind === 'numseries_block') {
        // Form 0 of the forms v2 (F12, T-R72): the schedule of spec §4.8.
        const schedule = diagnosticSeriesSchedule();
        expect(s.items.map((it) => it.family)).toEqual(schedule.map((e) => e.family));
        expect(s.items.map((it) => it.seed)).toEqual(diagnosticSeriesItems(1).map((it) => it.seed));
        expect(s.totalLimitMs).toBe(600_000);
        expect(s.items.every((it) => it.timeLimitMs === null)).toBe(true);
        await h.c.submitNumSeries(perfectSeriesAnswers(s.items, 20_000));
      } else if (s.kind === 'summary') await h.c.continueAfterSummary();
      else throw new Error(`unexpected ${s.kind}`);
    }
    expect(levels).toEqual([
      ['pzmr', 0],
      ['szmr', 0],
      ['gonogo', 10],
      ['rdo', 0],
      ['gorbov:black_up', 0],
      ['gorbov:red_down', 0],
      ['gorbov:alternate', 0],
    ]);
    expect(seen).not.toContain('wellbeing');

    const expected: DiagnosticResults = {
      ...EMPTY_RESULTS,
      pzmrMedianRt: 300,
      pzmrMeanRt: 300,
      szmrMedianRt: 300,
      szmrMeanRt: 300,
      gonogoScore: 100,
      rdoMeanAbsErrorMs: 0,
      // F7: every RT 300 ms, no errors.
      ...PERFECT_F7,
      gorbov: gorbovMetrics(7.2, 7.5, 14.7),
      numseriesCorrect: 20,
      unreliable: [],
      // F10: the three Горбов tasks on one table; F12: the number-series forms v2, form 0 played (T-R73).
      gorbovOneTable: true,
      seriesForm: 'v2',
      seriesFormIndex: 0,
    };
    const done = expectStep(h.c, 'done');
    expect(done.diagnostic).toEqual(expected);
    expect(done.seriesTotal).toBe(20);
    const diags = await repo.listDiagnostics();
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ sessionId: h.c.sessionId, number: 1 });
    expect(JSON.parse(diags[0]?.resultsJson ?? '')).toEqual(expected);

    expect(await repo.getModuleStates()).toEqual(statesBefore);
    expect((await repo.getRatings()).size).toBe(0);
    const blocks = await repo.listBlocks();
    expect(blocks.every((b) => b.lBefore === b.lAfter && b.flags.length === 0)).toBe(true);
    const pzmrTrials = await repo.listTrials(blocks[0]?.id ?? '');
    expect(pzmrTrials).toHaveLength(55);
    expect(pzmrTrials.map((t) => (JSON.parse(t.responseJson) as { practice: boolean }).practice).filter(Boolean)).toHaveLength(5);
    expect((await repo.listSessions())[0]).toMatchObject({ kind: 'diagnostic' });
    expect((await repo.listSessions())[0]?.endedAt).not.toBeNull();
  });

  it('the done step says when new parts count in the index: first 0.2.0 diagnostic after a 0.1.0 one, not the first ever (W2-R31)', async () => {
    const play = async (h: Harness): Promise<StepOf<'done'>> => {
      await drive(h);
      return expectStep(h.c, 'done');
    };
    const first = await play(await begin(planDiagnostic(1), { scale: 0.02 }));
    expect(first.diagnostic?.memorySpan).not.toBeNull();
    expect(first.indexDeferred).toBe(false);

    const repo = new MemoryRepository();
    await repo.createSession(session('w1', '2026-10-01T10:00:00.000Z', { kind: 'diagnostic' }));
    const w1: DiagnosticResults = { ...EMPTY_RESULTS, pzmrMedianRt: 300, szmrMedianRt: 450, gonogoScore: 90, numseriesCorrect: 14, unreliable: [] };
    await repo.addDiagnostic({ id: 'd1', sessionId: 'w1', number: 1, at: '2026-10-01T10:30:00.000Z', resultsJson: JSON.stringify(w1) });
    const clock = new Clock();
    const upgrade = await play(await begin(planDiagnostic(2), { repo, clock, scale: 0.02 }));
    expect(upgrade.diagnostic?.memorySpan).not.toBeNull();
    expect(upgrade.indexDeferred).toBe(true);
    clock.advance(DAY);
    const second = await play(await begin(planDiagnostic(3), { repo, clock, scale: 0.02 }));
    expect(second.indexDeferred).toBe(false);
  });

  it('a diagnostic starts when the earlier diagnostics cannot be read: no deferred note, the error is logged (B9)', async () => {
    const repo = new MemoryRepository();
    vi.spyOn(repo, 'listDiagnostics').mockRejectedValueOnce(new Error('disk I/O error'));
    const h = await begin(planDiagnostic(1), { repo, scale: 0.02 });
    expect(h.c.step.kind).toBe('instruction');
    expect((await repo.listSessions()).map((r) => r.kind)).toEqual(['diagnostic']);
    const log = await repo.listLog(5);
    expect(log.some((r) => r.level === 'error' && r.message.includes('earlier diagnostics') && r.detail.includes('disk I/O error'))).toBe(true);
    await drive(h);
    const done = expectStep(h.c, 'done');
    expect(done.diagnostic).not.toBeNull();
    expect(done.indexDeferred).toBe(false);
    expect(done.comparison).toBeNull();
  });

  it('the done step compares with the previous diagnostic by date (W2-R33); both indexes come from readinessOfLatest', async () => {
    const repo = new MemoryRepository();
    const m2: DiagnosticResults = { ...EMPTY_RESULTS, pzmrMedianRt: 320, szmrMedianRt: 450, gonogoScore: 85, numseriesCorrect: 12, unreliable: [] };
    const m1: DiagnosticResults = {
      ...EMPTY_RESULTS,
      pzmrMedianRt: 300,
      pzmrMeanRt: 310,
      szmrMedianRt: 430,
      gonogoScore: 90,
      numseriesCorrect: 14,
      unreliable: ['szmr'],
    };
    // Number 2 is the older one: the previous diagnostic is the latest by date, not by number.
    await repo.createSession(session('s2', '2026-10-01T10:00:00.000Z', { kind: 'diagnostic' }));
    await repo.createSession(session('s1', '2026-10-05T10:00:00.000Z', { kind: 'diagnostic' }));
    const row2 = { id: 'd2', sessionId: 's2', number: 2, at: '2026-10-01T10:30:00.000Z', resultsJson: JSON.stringify(m2) };
    const row1 = { id: 'd1', sessionId: 's1', number: 1, at: '2026-10-05T10:30:00.000Z', resultsJson: JSON.stringify(m1) };
    await repo.addDiagnostic(row2);
    await repo.addDiagnostic(row1);
    const h = await begin(planDiagnostic(3), { repo, scale: 0.02 });
    await drive(h);
    const done = expectStep(h.c, 'done');
    const diagnostic = done.diagnostic as DiagnosticResults;
    expect(done.comparison).toEqual({
      previous: { number: 1, at: '2026-10-05T10:30:00.000Z', metrics: parseResults(row1) },
      readiness: readinessOfLatest([m2, m1], diagnostic).overall,
      readinessPrevious: readinessOfLatest([m2], m1).overall,
      earlierUnreadable: false,
    });
    expect(done.comparison?.readiness).toEqual(expect.any(Number));
    expect(done.comparison?.readinessPrevious).toEqual(expect.any(Number));
    expect(done.comparison?.previous?.metrics.unreliable).toEqual(['szmr']);
  });

  it('the very first diagnostic has nothing to compare with; its index is readinessOfLatest of it alone', async () => {
    const h = await begin(planDiagnostic(1), { scale: 0.02 });
    await drive(h);
    const done = expectStep(h.c, 'done');
    const d = done.diagnostic as DiagnosticResults;
    expect(done.comparison).toEqual({ previous: null, readiness: readinessOfLatest([], d).overall, readinessPrevious: null, earlierUnreadable: false });
    expect(done.comparison?.readiness).toEqual(expect.any(Number));
  });

  it('diagnostic №3 whose earlier diagnostics are stored but unreadable: no previous, and it says so (FW10)', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('s1', '2026-10-01T10:00:00.000Z', { kind: 'diagnostic' }));
    await repo.createSession(session('s2', '2026-10-05T10:00:00.000Z', { kind: 'diagnostic' }));
    await repo.addDiagnostic({ id: 'd1', sessionId: 's1', number: 1, at: '2026-10-01T10:30:00.000Z', resultsJson: '{not json' });
    await repo.addDiagnostic({ id: 'd2', sessionId: 's2', number: 2, at: '2026-10-05T10:30:00.000Z', resultsJson: '42' });
    const h = await begin(planDiagnostic(3), { repo, scale: 0.02 });
    await drive(h);
    const done = expectStep(h.c, 'done');
    const d = done.diagnostic as DiagnosticResults;
    expect(done.comparison).toEqual({ previous: null, readiness: readinessOfLatest([], d).overall, readinessPrevious: null, earlierUnreadable: true });
  });

  it('gorbov metrics need all three runs completed; series count only inside the total limit', async () => {
    const h = await begin(planDiagnostic(3), { scale: 0.02 });
    let run = 0;
    for (let i = 0; i < 200 && h.c.step.kind !== 'done'; i++) {
      const s = h.c.step;
      if (s.kind === 'instruction') h.c.ackInstruction();
      else if (s.kind === 'reaction_block') await h.c.submitReaction(playTimeline(s.specs, perfectPlayer));
      else if (s.kind === 'table_block') {
        const r = perfectTableRun(s);
        if (run++ === 1) r.clicks.pop(); // red_down not finished
        await h.c.submitTable(r);
      } else if (s.kind === 'numseries_block') {
        // 3 items, 600 s × 0.02 = 12 s in total: the third answer ends after the limit.
        expect(s.totalLimitMs).toBe(12_000);
        await h.c.submitNumSeries(perfectSeriesAnswers(s.items).map((a, idx) => ({ ...a, timeMs: idx === 2 ? 3001 : 4500 })));
      } else if (s.kind === 'memory_block') await h.c.submitMemory(perfectMemoryAnswers(s.trials));
      else if (s.kind === 'summary') await h.c.continueAfterSummary();
      else throw new Error(`unexpected ${s.kind}`);
    }
    const done = expectStep(h.c, 'done');
    expect(done.diagnostic?.gorbov).toBeNull();
    expect(done.diagnostic?.numseriesCorrect).toBe(2);
    expect(done.seriesTotal).toBe(3);
  });

  /** Answers rows up to `span` digits exactly and longer ones wrong (the last digit changed). */
  const spanPlayer = (trials: readonly MemoryTrial[], span: number): MemoryAnswer[] =>
    trials.map((t) => {
      const given = [...t.items];
      if (t.items.length > span) given[given.length - 1] = given.at(-1) === '0' ? '1' : '0';
      return { given, timeMs: 2500 };
    });

  /** The diagnostic with only the segment of `module`. */
  const only = (module: ModuleId, n = 1): SessionPlan => {
    const plan = planDiagnostic(n);
    return { ...plan, segments: plan.segments.filter((x) => x.module === module) };
  };

  it('a diagnostic stores the spread of the clean hits and the false starts of ПЗМР (F7)', async () => {
    const h = await begin(only('pzmr'));
    // RTs 280…320 ms in turn; trials 10 and 20 are false starts (50 ms after the onset).
    const uneven: Respond = (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      if (r === null) return r;
      return { ...r, rtMs: idx === 10 || idx === 20 ? 50 : 280 + 10 * (idx % 5) };
    };
    await playReaction(h, uneven);
    await h.c.continueAfterSummary();
    const done = expectStep(h.c, 'done');
    // 50 trials after 5 practice ones: 48 hits, 280 ms eight times (two of its trials were false starts), the rest ten.
    const hits = [...Array<number>(8).fill(280), ...[290, 300, 310, 320].flatMap((rt) => Array<number>(10).fill(rt))];
    expect(done.diagnostic).toMatchObject({ pzmrIqrRt: 20, pzmrFalseStarts: 2 });
    expect(done.diagnostic?.pzmrSdRt).toBeCloseTo(sdTrimmed(hits), 10);
    const [row] = await h.repo.listDiagnostics();
    expect(JSON.parse(row?.resultsJson ?? '')).toEqual(done.diagnostic);
  });

  it('diagnostic plays ten segments and fills the W2 metrics', async () => {
    const h = await begin(planDiagnostic(1));
    // 80 ms slower on incongruent Stroop and on switch trials, 30 ms slower with noise.
    const slower: Respond = (spec, idx) => {
      const r = perfectPlayer(spec, idx);
      if (r === null) return r;
      const extra = spec.cond === 'incongruent' || spec.cond === 'switch' ? 80 : spec.cond === 'noisy' ? 30 : 0;
      return { ...r, rtMs: r.rtMs + extra };
    };
    const blocks: string[] = [];
    let memory: StepOf<'memory_block'> | null = null;
    for (let i = 0; i < 200 && h.c.step.kind !== 'done'; i++) {
      const s = h.c.step;
      if (s.kind === 'instruction') h.c.ackInstruction();
      else if (s.kind === 'reaction_block') {
        blocks.push(`${s.module}:${String(s.L)}:${String(s.specs.length)}`);
        await h.c.submitReaction(playTimeline(s.specs, slower));
      } else if (s.kind === 'table_block') {
        blocks.push(s.task);
        await h.c.submitTable(perfectTableRun(s));
      } else if (s.kind === 'numseries_block') {
        blocks.push('numseries');
        await h.c.submitNumSeries(perfectSeriesAnswers(s.items, 20_000));
      } else if (s.kind === 'memory_block') {
        blocks.push(`memory:${s.protocol}:${String(s.trials.length)}`);
        memory = s;
        // Lengths 3–7 right, both rows of 8 wrong: the protocol stops after the 12th answer.
        const answers = spanPlayer(s.trials, 7).slice(0, 12);
        expect(spanProtocolStops(s.trials, answers)).toBe(true);
        await h.c.submitMemory(answers);
        const { view } = expectStep(h.c, 'summary');
        expect(view).toMatchObject({ module: 'memory', score: 10 / 12, lines: ['Верно воспроизведено: 10 из 12', 'Объём памяти: 7 цифр'], showLevel: false });
      } else if (s.kind === 'summary') await h.c.continueAfterSummary();
      else throw new Error(`unexpected ${s.kind}`);
    }
    expect(blocks).toEqual([
      'pzmr:0:55',
      'szmr:0:75',
      'gonogo:10:65',
      'rdo:0:55',
      'black_up',
      'red_down',
      'alternate',
      'numseries',
      'pomeh:8:45',
      'stroop:8:53',
      'taskswitch:5:53',
      'memory:span:20',
    ]);
    expect(memory?.trials).toEqual(spanProtocolTrials(createRng(diagnosticSegmentSeed(1, 'memory'))));
    const done = expectStep(h.c, 'done');
    expect(done.diagnostic).toEqual({
      pzmrMedianRt: 300,
      pzmrMeanRt: 300,
      szmrMedianRt: 300,
      szmrMeanRt: 300,
      ...PERFECT_F7,
      gonogoScore: 100,
      rdoMeanAbsErrorMs: 0,
      gorbov: gorbovMetrics(7.2, 7.5, 14.7),
      numseriesCorrect: 20,
      pomehQuietRt: 300,
      pomehNoisyRt: 330,
      pomehDeltaMs: 30,
      stroopCongruentRt: 300,
      stroopIncongruentRt: 380,
      stroopInterferenceMs: 80,
      switchRepeatRt: 300,
      switchSwitchRt: 380,
      switchCostMs: 80,
      memorySpan: 7,
      unreliable: [],
      restarts: {},
      gorbovOneTable: true,
      seriesForm: 'v2',
      seriesFormIndex: 0,
    });
    const [row] = await h.repo.listDiagnostics();
    expect(JSON.parse(row?.resultsJson ?? '')).toEqual(done.diagnostic);
    const memoryRow = (await h.repo.listBlocks()).find((b) => b.module === 'memory');
    expect(memoryRow).toMatchObject({ lBefore: 0, lAfter: 0, score: 10 / 12, flags: [] });
    expect(JSON.parse(memoryRow?.summaryJson ?? '')).toMatchObject({ protocol: 'span', mode: 'digits', exact: 10, span: 7 });
    expect(JSON.parse(memoryRow?.paramsJson ?? '')).toMatchObject({ protocol: 'span', trials: 20 });
  });

  it('a diagnostic session leaves every module level, L_saved and the number-series ratings unchanged', async () => {
    const repo = new MemoryRepository();
    // A training history for every module (number series with two items), then the caches built from it.
    await repo.createSession(session('t', '2026-10-10T10:00:00', { endedAt: '2026-10-10T10:40:00' }));
    for (const [i, m] of MODULE_IDS.entries()) {
      const at = `2026-10-10T10:${String(i).padStart(2, '0')}:00`;
      const items = m === 'numseries' ? [item('i1', 'b-numseries', at), item('i2', 'b-numseries', at, { family: 'geom', correct: false })] : [];
      await repo.addBlock(block(`b-${m}`, 't', at, { module: m, lBefore: 5, lAfter: 6 }), [], items);
    }
    await rebuildCaches(repo);
    const states = await repo.getModuleStates();
    const ratings = await repo.getRatings();
    expect(states.stroop.lSaved).toBe(6);
    expect(states.memory.lifetimeBlocks).toBe(1);
    expect(ratings.size).toBe(2);

    const h = await begin(planDiagnostic(1), { repo, scale: 0.02 });
    const seen = await drive(h);
    expect(seen).toContain('memory_block');
    expect(await repo.getModuleStates()).toEqual(states);
    expect(await repo.getRatings()).toEqual(ratings);
    // Rebuilt from the whole history, the diagnostic included, the caches are the same: diagnostics never count.
    await rebuildCaches(repo);
    expect(await repo.getModuleStates()).toEqual(states);
    expect(await repo.getRatings()).toEqual(ratings);
    const played = (await repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId);
    expect(new Set(played.map((b) => b.module))).toEqual(new Set(planDiagnostic(1).segments.map((x) => x.module)));
    expect(played.every((b) => b.lBefore === b.lAfter && b.flags.length === 0)).toBe(true);
  });

  it('a W2 module that stays unreliable is listed in unreliable', async () => {
    const h = await begin(only('stroop'));
    h.c.ackInstruction();
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer, { dropped: droppedFive }));
    expect(expectStep(h.c, 'notice').module).toBe('stroop');
    h.c.ackNotice();
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer, { dropped: droppedFive }));
    expect(expectStep(h.c, 'summary').view.flags).toEqual(['timing_unreliable']);
    await h.c.continueAfterSummary();
    const done = expectStep(h.c, 'done');
    // The value is kept (from the trials whose onset frame was not dropped) and marked.
    expect(done.diagnostic).toMatchObject({ stroopCongruentRt: 300, stroopIncongruentRt: 300, stroopInterferenceMs: 0, unreliable: ['stroop'] });
  });

  it('span protocol answers must stop where the protocol stops', async () => {
    const h = await begin(only('memory'));
    expect(expectStep(h.c, 'instruction')).toMatchObject({ module: 'memory', text: MEMORY_SPAN_INSTRUCTION });
    h.c.ackInstruction();
    const step = expectStep(h.c, 'memory_block');
    expect(step.protocol).toBe('span');
    // Lengths 3 and 4 right, both rows of 5 wrong: the protocol stops after the 6th answer.
    const answers = spanPlayer(step.trials, 4);
    await expect(h.c.submitMemory(answers.slice(0, 5))).rejects.toThrow(RangeError);
    await expect(h.c.submitMemory(answers.slice(0, 7))).rejects.toThrow(/stopped after answer 6/);
    await expect(h.c.submitMemory(answers)).rejects.toThrow(/stopped after answer 6/);
    await expect(h.c.submitMemory([])).rejects.toThrow(RangeError);
    await expect(h.c.submitMemory([...perfectMemoryAnswers(step.trials), { given: [], timeMs: 1 }])).rejects.toThrow(/21 answers for 20 trials/);
    expectStep(h.c, 'memory_block');
    expect(await h.repo.listBlocks()).toEqual([]);
    await h.c.submitMemory(answers.slice(0, 6));
    expect(expectStep(h.c, 'summary').view.lines).toEqual(['Верно воспроизведено: 4 из 6', 'Объём памяти: 4 цифры']);
    await h.c.continueAfterSummary();
    expect(expectStep(h.c, 'done').diagnostic).toMatchObject({ memorySpan: 4, unreliable: [] });
  });

  it('a span protocol that never stops takes one answer per trial', async () => {
    const h = await begin(only('memory'));
    h.c.ackInstruction();
    const step = expectStep(h.c, 'memory_block');
    await h.c.submitMemory(perfectMemoryAnswers(step.trials));
    expect(expectStep(h.c, 'summary').view).toMatchObject({ score: 1, lines: ['Верно воспроизведено: 20 из 20', 'Объём памяти: 12 цифр'] });
    await h.c.continueAfterSummary();
    expect(expectStep(h.c, 'done').diagnostic?.memorySpan).toBe(12);
  });

  it('the three diagnostic Горбов tasks keep their own seeds and share one table (F10)', async () => {
    const plan: SessionPlan = { ...planDiagnostic(4), segments: [planDiagnostic(4).segments[4] as Segment] };
    const h = await begin(plan);
    const seeds: number[] = [];
    const tables = new Set<string>();
    for (let i = 0; i < 20 && h.c.step.kind !== 'done'; i++) {
      const s = h.c.step;
      if (s.kind === 'instruction') h.c.ackInstruction();
      else if (s.kind === 'table_block') {
        seeds.push(s.seed);
        tables.add(JSON.stringify(s.cells));
        await h.c.submitTable(perfectTableRun(s));
      } else await h.c.continueAfterSummary();
    }
    const seg = diagnosticSegmentSeed(4, 'gorbov');
    // The task seeds drive nothing but reshuffles, which the diagnostic never has.
    expect(seeds).toEqual([seg, deriveSeed(seg, 'run:1'), deriveSeed(seg, 'run:2')]);
    expect([...tables]).toEqual([JSON.stringify(generateGorbovTable(createRng(seg)))]);
    expect(expectStep(h.c, 'done').diagnostic?.gorbovOneTable).toBe(true);
    const [row] = await h.repo.listDiagnostics();
    expect(parseResults(row ?? { resultsJson: '' })?.gorbovOneTable).toBe(true);
  });

  it('a restart of Горбов task 1 deals a new table, of tasks 2–3 keeps it (F10)', async () => {
    const plan: SessionPlan = { ...planDiagnostic(4), segments: [planDiagnostic(4).segments[4] as Segment] };
    const h = await begin(plan);
    const next = (): StepOf<'table_block'> => {
      if (h.c.step.kind === 'instruction') h.c.ackInstruction();
      if (h.c.step.kind === 'notice') h.c.ackNotice();
      return expectStep(h.c, 'table_block');
    };
    const first = next();
    await h.c.discardBlock('focus_lost', 0.5);
    const again = next();
    const tableSeed = diagnosticBlockSeed(4, 'gorbov', 0, 1);
    expect(again.cells).toEqual(generateGorbovTable(createRng(tableSeed)));
    expect(again.cells).not.toEqual(first.cells);
    // The restart by Esc of task 1 deals another one again.
    await h.c.discardBlock('user', 0.5);
    const third = next();
    const counted = diagnosticBlockSeed(4, 'gorbov', 0, 2);
    expect(third.cells).toEqual(generateGorbovTable(createRng(counted)));
    await h.c.submitTable(perfectTableRun(third));
    await h.c.continueAfterSummary();
    const task2 = next();
    expect(task2.cells).toEqual(third.cells);
    await h.c.discardBlock('user', 0.5);
    const task2Again = next();
    expect(task2Again.seed).toBe(diagnosticBlockSeed(4, 'gorbov', 1, 1));
    expect(task2Again.cells).toEqual(third.cells);
    await h.c.submitTable(perfectTableRun(task2Again));
    await h.c.continueAfterSummary();
    expect(next().cells).toEqual(third.cells);
    await drive(h);
    const params = (await h.repo.listBlocks()).map((b) => JSON.parse(b.paramsJson) as { table: string; tableSeed: number });
    expect(params.map((p) => [p.table, p.tableSeed])).toEqual([
      ['series', counted],
      ['series', counted],
      ['series', counted],
    ]);
    expect(expectStep(h.c, 'done').diagnostic?.gorbovOneTable).toBe(true);
  });

  it('a discarded diagnostic block is replaced by one from a derived seed, same L', async () => {
    const h = await begin(planDiagnostic(1));
    h.c.ackInstruction();
    const first = expectStep(h.c, 'reaction_block');
    await h.c.discardBlock('focus_lost', 0.5);
    const again = expectStep(h.c, 'reaction_block');
    const seed = deriveSeed(diagnosticSegmentSeed(1, 'pzmr'), 'retry:1');
    const p = pzmr.params(0);
    expect(again.L).toBe(0);
    expect(again.specs).not.toEqual(first.specs);
    expect(again.specs.slice(5)).toEqual(pzmr.generateBlock(p, createRng(seed), 'keyboard', 50));
    expect(again.specs.slice(0, 5)).toEqual(
      pzmr.generateBlock(p, createRng(deriveSeed(seed, 'practice')), 'keyboard', 5).map((t) => ({ ...t, practice: true })),
    );
  });

  const pzmrOnly = (n = 1, seedIndex = n): SessionPlan => {
    const plan = planDiagnostic(n, seedIndex);
    return { ...plan, segments: [plan.segments[0] as Segment] };
  };
  /** 5 of the 50 counted onsets dropped (practice trials are 0–4): 10 % > 5 %. */
  const droppedFive = (idx: number): boolean => idx >= 5 && idx < 10;

  it('an unreliable diagnostic reaction block is replayed once from a new seed, with a notice and no write (I1)', async () => {
    const h = await begin(pzmrOnly());
    h.c.ackInstruction();
    const first = expectStep(h.c, 'reaction_block');
    await h.c.submitReaction(playTimeline(first.specs, perfectPlayer, { dropped: droppedFive }));
    expect(expectStep(h.c, 'notice')).toEqual({
      kind: 'notice',
      module: 'pzmr',
      text: 'Замер ненадёжен (пропуски кадров). Блок будет повторён.',
    });
    expect(await h.repo.listBlocks()).toEqual([]);
    expect(h.c.discards).toEqual([{ module: 'pzmr', reason: 'timing_unreliable' }]);
    h.c.ackNotice();
    const again = expectStep(h.c, 'reaction_block');
    const seed = deriveSeed(diagnosticSegmentSeed(1, 'pzmr'), 'retry:1');
    expect(again.specs.slice(5)).toEqual(pzmr.generateBlock(pzmr.params(0), createRng(seed), 'keyboard', 50));
    await h.c.submitReaction(playTimeline(again.specs, perfectPlayer));
    expect(expectStep(h.c, 'summary').view.flags).toEqual([]);
    await h.c.continueAfterSummary();
    const done = expectStep(h.c, 'done');
    expect(done.diagnostic).toMatchObject({ pzmrMedianRt: 300, unreliable: [] });
    expect(await h.repo.listBlocks()).toHaveLength(1);
  });

  it('a replay that is unreliable again is accepted and its module is marked unreliable (I1)', async () => {
    const h = await begin(pzmrOnly());
    h.c.ackInstruction();
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer, { dropped: droppedFive }));
    h.c.ackNotice();
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer, { dropped: droppedFive }));
    const summary = expectStep(h.c, 'summary');
    expect(summary.view.flags).toEqual(['timing_unreliable']);
    await h.c.continueAfterSummary();
    const done = expectStep(h.c, 'done');
    expect(done.diagnostic).toMatchObject({ pzmrMedianRt: 300, unreliable: ['pzmr'] });
    const [row] = await h.repo.listDiagnostics();
    expect(JSON.parse(row?.resultsJson ?? '')).toMatchObject({ unreliable: ['pzmr'] });
    expect(await h.repo.listBlocks()).toHaveLength(1);
  });

  it('training never replays an unreliable block (the flag keeps the level instead)', async () => {
    const h = await begin(planFree('pzmr', 1));
    const s = await playReaction(h, perfectPlayer, (idx) => idx < 2);
    expect(s.view.flags).toContain('timing_unreliable');
    expect(() => {
      h.c.ackNotice();
    }).toThrow(/expected step notice/);
  });

  it('the seed index of a diagnostic can differ from its displayed number (I5)', async () => {
    const h = await begin(pzmrOnly(1, 2));
    h.c.ackInstruction();
    const block = expectStep(h.c, 'reaction_block');
    const seed = diagnosticSegmentSeed(2, 'pzmr');
    expect(block.specs.slice(5)).toEqual(pzmr.generateBlock(pzmr.params(0), createRng(seed), 'keyboard', 50));
    await h.c.submitReaction(playTimeline(block.specs, perfectPlayer));
    await h.c.continueAfterSummary();
    expect((await h.repo.listDiagnostics())[0]?.number).toBe(1);
  });

  it('the diagnostic Go/No-Go value stays the share of successes', async () => {
    const plan = planDiagnostic(1);
    const gonogo = plan.segments.find((seg) => seg.module === 'gonogo') as Segment;
    const h = await begin({ ...plan, segments: [gonogo] });
    h.c.ackInstruction();
    const block = expectStep(h.c, 'reaction_block');
    const noGo = block.specs.findIndex((spec) => spec.practice !== true && spec.expected.kind === 'withhold');
    // One press 300 ms into a no-go trial (inside its window): a no-go press.
    const respond: Respond = (spec, idx) => (idx === noGo ? { key: block.keys[0] as InputKey, rtMs: 300 } : perfectPlayer(spec, idx));
    await h.c.submitReaction(playTimeline(block.specs, respond));
    const { view } = expectStep(h.c, 'summary');
    const [row] = await h.repo.listBlocks();
    const summary = JSON.parse(row?.summaryJson ?? '{}') as { counts: unknown; score: number; penalizedScore: number };
    expect(summary.counts).toMatchObject({ commission: 1, false_start: 0, wrong: 0 });
    expect(summary.score).toBeCloseTo(59 / 60, 12);
    expect(summary.penalizedScore).toBeCloseTo(57 / 60, 12);
    expect(row?.score).toBe(summary.penalizedScore);
    expect(view.score).toBe(summary.score);
    await h.c.continueAfterSummary();
    expect(expectStep(h.c, 'done').diagnostic?.gonogoScore).toBe(summary.score * 100);
  });

  it('diagnostic summaries do not show a level (M5)', async () => {
    const h = await begin(pzmrOnly());
    h.c.ackInstruction();
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    expect(expectStep(h.c, 'summary').view.showLevel).toBe(false);
  });

  it('a diagnostic plan needs its number', async () => {
    const plan: SessionPlan = { kind: 'diagnostic', seed: 1, segments: planDiagnostic(1).segments };
    await expect(begin(plan)).rejects.toThrow(/diagnosticNumber/);
  });

  it('the series task plays the form of the diagnostic seed index; a restart plays the next form (F12)', async () => {
    const plan = planDiagnostic(2, 5);
    const h = await begin({ ...plan, segments: [plan.segments[5] as Segment] });
    h.c.ackInstruction();
    const seeds = (): number[] => expectStep(h.c, 'numseries_block').items.map((it) => it.seed);
    const form = (seedIndex: number): number[] => diagnosticSeriesItems(seedIndex).map((it) => it.seed);
    // Seed index 5: form 4.
    expect(seeds()).toEqual(form(5));
    expect(seeds()[0]).toBe(diagnosticSeriesSeed(5, 1));
    // A focus loss restarts the task with the next form: the items already seen do not come again.
    expect(await h.c.discardBlock('focus_lost', 0.2)).toEqual({ kind: 'restarted' });
    expect(seeds()).toEqual(form(6));
    // The Esc restart after it: the form after that (form 0 again, 7 mod 6).
    expect(await h.c.discardBlock('user', 0.4)).toEqual({ kind: 'restarted' });
    h.c.ackNotice();
    expect(seeds()).toEqual(form(1));
    // Every item comes from its scheduled family, whatever the form.
    expect(expectStep(h.c, 'numseries_block').items.map((it) => it.family)).toEqual(diagnosticSeriesSchedule().map((e) => e.family));
  });

  /** A diagnostic of the number series alone. */
  const seriesOnly = (n: number, seedIndex = n): SessionPlan => {
    const plan = planDiagnostic(n, seedIndex);
    return { ...plan, segments: [plan.segments[5] as Segment] };
  };
  const formSeeds = (form: number): number[] => diagnosticSeriesItems(form + 1).map((it) => it.seed);

  it('a restart never makes the next diagnostic replay its form; the form played is stored (T-R73)', async () => {
    const repo = new MemoryRepository();
    // Diagnostic 1 (seed index 1, form 0) restarts its series once and plays form 1 in full.
    const first = await begin(seriesOnly(1), { repo });
    first.c.ackInstruction();
    const seeds = (h: Harness): number[] => expectStep(h.c, 'numseries_block').items.map((it) => it.seed);
    expect(seeds(first)).toEqual(formSeeds(0));
    expect(await first.c.discardBlock('focus_lost', 0.3)).toEqual({ kind: 'restarted' });
    expect(seeds(first)).toEqual(formSeeds(1));
    await first.c.submitNumSeries(perfectSeriesAnswers(expectStep(first.c, 'numseries_block').items));
    await drive(first);
    expect(expectStep(first.c, 'done').diagnostic?.seriesFormIndex).toBe(1);
    const [stored] = await repo.listDiagnostics();
    expect(parseResults(stored ?? { resultsJson: '' })?.seriesFormIndex).toBe(1);
    // Diagnostic 2 (seed index 2, whose own form is 1) plays form 2: form 1 does not come twice in a row.
    const second = await begin(seriesOnly(2), { repo });
    second.c.ackInstruction();
    expect(seeds(second)).toEqual(formSeeds(2));
    // Its Esc restart moves on to form 3.
    expect(await second.c.discardBlock('user', 0.5)).toEqual({ kind: 'restarted' });
    second.c.ackNotice();
    expect(seeds(second)).toEqual(formSeeds(3));
    await second.c.submitNumSeries(perfectSeriesAnswers(expectStep(second.c, 'numseries_block').items));
    await drive(second);
    expect(expectStep(second.c, 'done').diagnostic?.seriesFormIndex).toBe(3);
    // Diagnostic 3 then plays form 4.
    const third = await begin(seriesOnly(3), { repo });
    third.c.ackInstruction();
    expect(seeds(third)).toEqual(formSeeds(4));
  });

  it('after diagnostics stored without a form, the form of the seed index (T-R73)', async () => {
    const repo = new MemoryRepository();
    const oldRow = Object.fromEntries(Object.entries({ ...EMPTY_RESULTS, seriesForm: 'v2', numseriesCorrect: 12 }).filter(([k]) => k !== 'seriesFormIndex'));
    await repo.createSession(session('old', T0, { kind: 'diagnostic', endedAt: T0 }));
    await repo.addDiagnostic({ id: 'd-old', sessionId: 'old', number: 1, at: T0, resultsJson: JSON.stringify(oldRow) });
    const h = await begin(seriesOnly(2, 4), { repo });
    h.c.ackInstruction();
    // Seed index 4: form 3.
    expect(expectStep(h.c, 'numseries_block').items.map((it) => it.seed)).toEqual(formSeeds(3));
  });
});

describe('SessionController — scale (e2e)', () => {
  it('scales budgets, block sizes, diagnostic volumes and practice', async () => {
    const t = await begin(planFree('pzmr', 1), { scale: 0.02 });
    t.c.ackInstruction();
    expect(expectStep(t.c, 'reaction_block').specs).toHaveLength(3);
    t.clock.advance(5 * MIN * 0.02);
    await t.c.submitReaction(playTimeline(expectStep(t.c, 'reaction_block').specs, perfectPlayer));
    await t.c.continueAfterSummary();
    expectStep(t.c, 'done'); // 5 min × 0.02 = 6 s budget used up

    const n = await begin(planFree('numseries', 1), { scale: 0.02 });
    n.c.ackInstruction();
    expect(expectStep(n.c, 'numseries_block').items).toHaveLength(3);

    const series: SessionPlan = { ...planDiagnostic(1), segments: [planDiagnostic(1).segments[5] as Segment] };
    const ds = await begin(series, { scale: 0.02 });
    expect(expectStep(ds.c, 'instruction').text).toBe(
      '3 задачи, общее время — 12 секунд. Найди закономерность и введи следующее число. Пробел — пропустить задачу (засчитается как неверная).',
    );
    ds.c.ackInstruction();
    expect(expectStep(ds.c, 'numseries_block')).toMatchObject({ totalLimitMs: 12_000 });
    expect(expectStep(ds.c, 'numseries_block').items).toHaveLength(3);

    const d = await begin(planDiagnostic(1), { scale: 0.02 });
    d.c.ackInstruction();
    const specs = expectStep(d.c, 'reaction_block').specs;
    expect(specs).toHaveLength(4);
    expect(specs.map((s) => s.practice === true)).toEqual([true, false, false, false]);

    const seen = await drive(d);
    expect(seen.filter((s) => s.startsWith('table_block'))).toHaveLength(3);
  });

  it('rejects a non-positive scale', async () => {
    await expect(begin(planFree('pzmr', 1), { scale: 0 })).rejects.toThrow(RangeError);
  });
});

describe('SessionController — Esc policy (F11)', () => {
  const YESTERDAY = new Date(new Date(T0).getTime() - DAY).toISOString();
  const training = (...segments: Segment[]): SessionPlan => ({ kind: 'training', seed: 3, phase: 'development', segments });
  /** The block rows this session stored, in order. */
  const storedRows = async (h: Harness): Promise<BlockRow[]> => (await h.repo.listBlocks()).filter((b) => b.sessionId === h.c.sessionId);
  const summaryOf = (row: BlockRow | undefined): Record<string, unknown> => JSON.parse(row?.summaryJson ?? '{}') as Record<string, unknown>;
  /** Misses the first trial: s = 14/15 on ПЗМР. */
  const missFirst: Respond = (spec, idx) => (idx === 0 ? null : perfectPlayer(spec, idx));

  it('p = 0.30 restarts for free, p = 0.31 counts as 0', async () => {
    const repo = await calibratedRepo(stateWith('szmr', { lSaved: 6, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    const h = await begin(planFree('szmr', 5), { repo });
    h.c.ackInstruction();
    const first = expectStep(h.c, 'reaction_block');
    expect(first.L).toBe(5);
    expect(await h.c.discardBlock('user', 0.3)).toEqual({ kind: 'restarted' });
    const again = expectStep(h.c, 'reaction_block');
    expect(again.L).toBe(5);
    expect(again.specs).not.toEqual(first.specs);
    expect(await storedRows(h)).toEqual([]);
    expect(h.c.discards).toEqual([{ module: 'szmr', reason: 'user' }]);

    expect(await h.c.discardBlock('user', 0.31)).toEqual({ kind: 'counted', progress: 0.31, lBefore: 5, lAfter: 3, levelMoves: true, series: false });
    const [row] = await storedRows(h);
    expect(row).toMatchObject({ module: 'szmr', lBefore: 5, lAfter: 3, score: 0, flags: ['discarded'] });
    expect(await h.repo.listTrials(row?.id ?? '')).toEqual([]);
    // The free restart is recorded in the next stored block of the segment: this one.
    expect(summaryOf(row)).toEqual({ discarded: { reason: 'user', progress: 0.31 }, restarts: [{ reason: 'user', progress: 0.3 }] });
    // A counted block is stored, not thrown away.
    expect(h.c.discards).toHaveLength(1);
    // It counts for the level like any block: the session's end level so far (the old session ended at 6).
    expect((await repo.getModuleStates()).szmr.sessionEndLevels).toEqual([6, 3]);
    // The next step is the next block, at the level the Esc left.
    const next = expectStep(h.c, 'reaction_block');
    expect(next.L).toBe(3);
    await h.c.submitReaction(playTimeline(next.specs, perfectPlayer));
    const after = summaryOf((await storedRows(h))[1]);
    expect(after).not.toHaveProperty('restarts');
    expect(after).not.toHaveProperty('discarded');
  });

  it('a counted Esc in a warm-up, an overload block or a test-format run keeps the level', async () => {
    const counted = (lBefore: number): DiscardOutcome => ({ kind: 'counted', progress: 0.5, lBefore, lAfter: lBefore, levelMoves: false, series: false });

    // The warm-up plays L_saved − 1.
    const warmRepo = await calibratedRepo(stateWith('pzmr', { lSaved: 6, lastTrainedAt: YESTERDAY, lifetimeBlocks: 10 }));
    const warm = await begin(training({ module: 'pzmr', budgetMs: 2 * MIN, purpose: 'warmup' }), { repo: warmRepo });
    warm.c.ackInstruction();
    expect(await warm.c.discardBlock('user', 0.5)).toEqual(counted(5));
    expect((await storedRows(warm))[0]).toMatchObject({ lBefore: 5, lAfter: 5, score: 0, flags: ['warmup', 'discarded'] });
    expect((await warmRepo.getModuleStates()).pzmr.lSaved).toBe(6);
    expect(expectStep(warm.c, 'reaction_block').L).toBe(5);

    // The overload block of a band module's plateau mix (its second block) plays the segment level and keeps it.
    const mixRepo = await calibratedRepo(stateWith('szmr', { lSaved: 9, lastTrainedAt: YESTERDAY, lifetimeBlocks: 10 }));
    const mix = await begin(training({ module: 'szmr', budgetMs: 5 * MIN, purpose: 'reaction', overload: 'mix' }), { repo: mixRepo });
    const normal = await playReaction(mix);
    await mix.c.continueAfterSummary();
    if (mix.c.step.kind === 'instruction') mix.c.ackInstruction();
    expect(expectStep(mix.c, 'reaction_block').L).toBe(normal.view.lAfter);
    expect(await mix.c.discardBlock('user', 0.5)).toEqual(counted(normal.view.lAfter));
    expect((await storedRows(mix))[1]).toMatchObject({ flags: ['overload', 'discarded'], lAfter: normal.view.lAfter, score: 0 });

    // A finisher of РДО plays L_saved + 3: a counted Esc leaves its level there too.
    const finRepo = await calibratedRepo(stateWith('rdo', { lSaved: 10, lastTrainedAt: YESTERDAY, lifetimeBlocks: 10 }));
    const fin = await begin(training({ module: 'rdo', budgetMs: 5 * MIN, purpose: 'finisher', overload: 'finisher' }), { repo: finRepo });
    fin.c.ackInstruction();
    expect(await fin.c.discardBlock('user', 0.5)).toEqual(counted(13));
    expect((await storedRows(fin))[0]).toMatchObject({ flags: ['overload', 'discarded'], lBefore: 13, lAfter: 13 });
    expect(expectStep(fin.c, 'reaction_block').L).toBe(13);

    // A test-format run is one block: the next segment follows.
    const runRepo = await calibratedRepo(stateWith('pzmr', { lSaved: 6, lastTrainedAt: YESTERDAY, lifetimeBlocks: 10 }));
    const runSegment: Segment = { module: 'pzmr', budgetMs: 0, purpose: 'test_format', trialCount: 50, practiceTrials: 5 };
    const run = await begin(training(runSegment, { module: 'szmr', budgetMs: 5 * MIN, purpose: 'reaction' }), { repo: runRepo });
    run.c.ackInstruction();
    expect(await run.c.discardBlock('user', 0.5)).toEqual(counted(6));
    const [runRow] = await storedRows(run);
    expect(runRow).toMatchObject({ module: 'pzmr', flags: ['test_format', 'discarded'], lBefore: 6, lAfter: 6, score: 0 });
    // No metrics: the run is never anyone's best.
    expect(summaryOf(runRow)).toEqual({ discarded: { reason: 'user', progress: 0.5 } });
    expect(expectStep(run.c, 'instruction').module).toBe('szmr');
  });

  it('number series: the answered items count, the rest are skipped', async () => {
    const h = await begin(planFree('numseries', 21));
    h.c.ackInstruction();
    const block = expectStep(h.c, 'numseries_block');
    expect(block.items).toHaveLength(10);
    const answers = perfectSeriesAnswers(block.items).slice(0, 4);
    answers[1] = { itemId: block.items[1]?.id ?? '', given: (block.items[1]?.answer ?? 0) + 1, timeMs: 9000 };
    expect(await h.c.discardBlock('user', 0.4, answers)).toEqual({ kind: 'counted', progress: 0.4, lBefore: 0, lAfter: 0, levelMoves: false, series: true });

    const items = await h.repo.listLogicItems();
    expect(items).toHaveLength(10);
    expect(items.map((i) => i.given === null)).toEqual([false, false, false, false, true, true, true, true, true, true]);
    expect(items.map((i) => i.correct)).toEqual([true, false, true, true, false, false, false, false, false, false]);
    expect(items.slice(4).map((i) => i.timeMs)).toEqual(Array<number>(6).fill(0));
    const ratings = await h.repo.getRatings();
    expect(ratings).toEqual(deriveRatings(items));
    expect([...ratings.values()].reduce((n, r) => n + r.n, 0)).toBe(10);

    const [row] = await storedRows(h);
    expect(row).toMatchObject({ module: 'numseries', flags: ['discarded'], score: 0.3, lBefore: 0, lAfter: 0 });
    const summary = summaryOf(row) as { correct: number; total: number; discarded: unknown; items: { itemId: string; skipped?: boolean }[] };
    expect(summary).toMatchObject({ correct: 3, total: 10, discarded: { reason: 'user', progress: 0.4 } });
    expect(summary.items.map((it) => it.skipped)).toEqual([undefined, undefined, undefined, undefined, true, true, true, true, true, true]);
    expect(summary.items.map((it) => it.itemId)).toEqual(block.items.map((it) => it.id));
    // The next block follows.
    expect(expectStep(h.c, 'numseries_block').items).not.toEqual(block.items);
  });

  it('number series: answers that are not the first items of the block are rejected', async () => {
    const h = await begin(planFree('numseries', 21));
    h.c.ackInstruction();
    const block = expectStep(h.c, 'numseries_block');
    const answers = perfectSeriesAnswers(block.items);
    await expect(h.c.discardBlock('user', 0.4, answers.slice(1, 5))).rejects.toThrow(RangeError);
    await expect(h.c.discardBlock('user', 0.4, [...answers, ...answers])).rejects.toThrow(RangeError);
    expect(expectStep(h.c, 'numseries_block')).toBe(block);
    expect(await h.repo.listBlocks()).toEqual([]);
  });

  it('tables and memory count an Esc after 30 % as 0 too', async () => {
    const t = await begin(planFree('schulte', 5), { repo: await calibratedRepo(stateWith('schulte', { lSaved: 6, lastTrainedAt: T0, lifetimeBlocks: 10 })) });
    t.c.ackInstruction();
    expect(await t.c.discardBlock('user', 0.5)).toEqual({ kind: 'counted', progress: 0.5, lBefore: 5, lAfter: 3, levelMoves: true, series: false });
    expect((await storedRows(t))[0]).toMatchObject({ module: 'schulte', flags: ['discarded'], score: 0 });

    const m = await begin(planFree('memory', 5), { repo: await calibratedRepo(stateWith('memory', { lSaved: 1, lastTrainedAt: T0, lifetimeBlocks: 10 })) });
    m.c.ackInstruction();
    expect(await m.c.discardBlock('user', 0.5)).toEqual({ kind: 'counted', progress: 0.5, lBefore: 0, lAfter: 0, levelMoves: false, series: false });
    expect((await storedRows(m))[0]).toMatchObject({ module: 'memory', flags: ['discarded'], score: 0, lBefore: 0, lAfter: 0 });
  });

  it('memory of 10 rows and partial scoring: Esc after 3 of 10 answers restarts for free, after 4 counts as s = 0 (F11, F13)', async () => {
    const repo = await calibratedRepo(stateWith('memory', { lSaved: 10, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    const h = await begin(planFree('memory', 5), { repo });
    h.c.ackInstruction();
    expect(expectStep(h.c, 'memory_block').trials).toHaveLength(10);
    // The share its view reports: answered rows / rows.
    expect(await h.c.discardBlock('user', 3 / 10)).toEqual({ kind: 'restarted' });
    expect(await h.c.discardBlock('user', 4 / 10)).toEqual({ kind: 'counted', progress: 0.4, lBefore: 9, lAfter: 7, levelMoves: true, series: false });
    const [row] = await storedRows(h);
    expect(row).toMatchObject({ module: 'memory', flags: ['discarded'], score: 0, lBefore: 9, lAfter: 7 });
    expect(summaryOf(row)).toEqual({ discarded: { reason: 'user', progress: 0.4 }, restarts: [{ reason: 'user', progress: 0.3 }] });
    // The next block follows: the next mode, with its instruction.
    expect(expectStep(h.c, 'instruction').text).toMatch(/^Клетки загораются/);
  });

  it('focus loss and drawing errors restart for free and are recorded', async () => {
    const h = await begin(planFree('pzmr', 1));
    h.c.ackInstruction();
    expect(await h.c.discardBlock('focus_lost', 0.9)).toEqual({ kind: 'restarted' });
    expect(await h.c.discardBlock('error', 0.6)).toEqual({ kind: 'restarted' });
    expect(h.c.discards).toEqual([
      { module: 'pzmr', reason: 'focus_lost' },
      { module: 'pzmr', reason: 'error' },
    ]);
    expect(await h.repo.listBlocks()).toEqual([]);
    await playReaction(h);
    const [row] = await storedRows(h);
    expect(row?.flags).toEqual(['calibration']);
    expect(summaryOf(row)['restarts']).toEqual([
      { reason: 'focus_lost', progress: 0.9 },
      { reason: 'error', progress: 0.6 },
    ]);
  });

  it('a counted Esc block moves the level, so the next block is not the first of the segment (T-R37)', async () => {
    const repo = await calibratedRepo(stateWith('pzmr', { lSaved: 6, lastTrainedAt: T0, lifetimeBlocks: 3 }));
    const h = await begin(planFree('pzmr', 1), { repo });
    h.c.ackInstruction();
    expect(await h.c.discardBlock('user', 0.5)).toMatchObject({ kind: 'counted', lBefore: 5, lAfter: 3 });
    // s 14/15 ≥ 0.9 gets no first-block boost: g = 1.
    const next = await playReaction(h, missFirst);
    expect(next.view.lBefore).toBe(3);
    expect(next.view.lAfter - 3).toBeCloseTo((14 / 15 - 0.8) / 0.2, 9);
  });

  it('a counted Esc block is not the previous block of g = 2 (T-R10)', async () => {
    const repo = await calibratedRepo(stateWith('pzmr', { lSaved: 6, lastTrainedAt: T0, lifetimeBlocks: 3 }));
    const h = await begin(planFree('pzmr', 1), { repo });
    const first = await playReaction(h);
    expect(first.view.score).toBe(1);
    await h.c.continueAfterSummary();
    if (h.c.step.kind === 'instruction') h.c.ackInstruction();
    expect(await h.c.discardBlock('user', 0.5)).toMatchObject({ kind: 'counted', lBefore: first.view.lAfter, lAfter: first.view.lAfter - 2 });
    // The previous block of the module is the s = 1 one: s 14/15 gets g = 2.
    const third = await playReaction(h, missFirst);
    expect(third.view.lAfter - third.view.lBefore).toBeCloseTo((2 * (14 / 15 - 0.8)) / 0.2, 9);
  });

  it('a counted Esc block stays out of fatigue (T-R10)', async () => {
    // Two fast blocks and a slow one: with an s = 0 block after them the last two would look tired.
    let blockNo = 0;
    const slowThird: Respond = (spec, idx) => {
      if (idx === 0) blockNo++;
      const e = spec.expected;
      return blockNo === 3 && e.kind === 'press' ? { key: e.key, rtMs: 400 } : perfectPlayer(spec, idx);
    };
    const h = await begin({ kind: 'training', seed: 11, segments: [segment('szmr', 5 * MIN)] });
    for (let i = 0; i < 3; i++) {
      h.clock.advance(30_000);
      await playReaction(h, slowThird);
      await h.c.continueAfterSummary();
    }
    h.clock.advance(30_000);
    if (h.c.step.kind === 'instruction') h.c.ackInstruction();
    expect(await h.c.discardBlock('user', 0.5)).toMatchObject({ kind: 'counted' });
    expectStep(h.c, 'reaction_block');
  });

  it('a share outside [0, 1] or a step without a block is rejected', async () => {
    const h = await begin(planFree('pzmr', 1));
    await expect(h.c.discardBlock('user', 0)).rejects.toThrow(/expected a block step/);
    h.c.ackInstruction();
    const block = expectStep(h.c, 'reaction_block');
    for (const p of [-0.1, 1.01, Number.NaN]) await expect(h.c.discardBlock('user', p)).rejects.toThrow(RangeError);
    expect(h.c.step).toBe(block);
    expect(h.c.escAllowed).toBe(true);
  });
});

describe('SessionController — Esc in a diagnostic (F11)', () => {
  const NOTICE = 'Блок перезапущен. В диагностике это можно сделать один раз за задание.';

  it('the first Esc in a task restarts it with a notice', async () => {
    const h = await begin(planDiagnostic(1), { scale: 0.02 });
    h.c.ackInstruction();
    const first = expectStep(h.c, 'reaction_block');
    expect(h.c.escAllowed).toBe(true);
    // Whatever the share: a diagnostic never counts a block as 0.
    expect(await h.c.discardBlock('user', 0.8)).toEqual({ kind: 'restarted' });
    expect(h.c.step).toEqual({ kind: 'notice', module: 'pzmr', text: NOTICE });
    expect(h.c.escAllowed).toBe(false);
    expect(await h.repo.listBlocks()).toEqual([]);
    h.c.ackNotice();
    const again = expectStep(h.c, 'reaction_block');
    expect(again.specs).not.toEqual(first.specs);
    expect(h.c.escAllowed).toBe(false);
  });

  it('a second Esc in a diagnostic task is refused', async () => {
    const h = await begin(planDiagnostic(1), { scale: 0.02 });
    h.c.ackInstruction();
    await h.c.discardBlock('user', 0.1);
    h.c.ackNotice();
    const block = expectStep(h.c, 'reaction_block');
    expect(await h.c.discardBlock('user', 0.9)).toEqual({ kind: 'refused' });
    expect(h.c.step).toBe(block);
    expect(h.c.discards).toEqual([{ module: 'pzmr', reason: 'user' }]);
    expect(await h.repo.listBlocks()).toEqual([]);
  });

  it('focus loss in a diagnostic does not use up the restart', async () => {
    const h = await begin(planDiagnostic(1), { scale: 0.02 });
    h.c.ackInstruction();
    expect(await h.c.discardBlock('focus_lost', 0.5)).toEqual({ kind: 'restarted' });
    // No notice of its own: the session screen explains a focus loss.
    expectStep(h.c, 'reaction_block');
    expect(h.c.escAllowed).toBe(true);
    expect(await h.c.discardBlock('user', 0.2)).toEqual({ kind: 'restarted' });
    expect(h.c.escAllowed).toBe(false);
    h.c.ackNotice();
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    const [pzmrRow] = await h.repo.listBlocks();
    expect((JSON.parse(pzmrRow?.summaryJson ?? '{}') as { restarts: unknown }).restarts).toEqual([
      { reason: 'focus_lost', progress: 0.5 },
      { reason: 'user', progress: 0.2 },
    ]);
    await h.c.continueAfterSummary();
    // The next task has its own restart.
    expectStep(h.c, 'instruction');
    expect(h.c.escAllowed).toBe(true);
    await drive(h);
    const done = expectStep(h.c, 'done');
    expect(done.diagnostic?.restarts).toEqual({ pzmr: { user: 1, focus: 1 } });
    const [row] = await h.repo.listDiagnostics();
    expect(parseResults(row ?? { resultsJson: '' })?.restarts).toEqual({ pzmr: { user: 1, focus: 1 } });
  });

  it('each Горбов task has its own restart; drawing errors restart without a count', async () => {
    const plan: SessionPlan = { ...planDiagnostic(4), segments: [planDiagnostic(4).segments[4] as Segment] };
    const h = await begin(plan);
    h.c.ackInstruction();
    expect(await h.c.discardBlock('error', 0.5)).toEqual({ kind: 'restarted' });
    expect(await h.c.discardBlock('user', 0.5)).toEqual({ kind: 'restarted' });
    expect(expectStep(h.c, 'notice').module).toBe('gorbov');
    h.c.ackNotice();
    expect(await h.c.discardBlock('user', 0.5)).toEqual({ kind: 'refused' });
    await h.c.submitTable(perfectTableRun(expectStep(h.c, 'table_block')));
    await h.c.continueAfterSummary();
    h.c.ackInstruction();
    expect(h.c.escAllowed).toBe(true);
    expect(await h.c.discardBlock('user', 0.5)).toEqual({ kind: 'restarted' });
    h.c.ackNotice();
    await drive(h);
    expect(expectStep(h.c, 'done').diagnostic?.restarts).toEqual({ gorbov: { user: 2, focus: 0 } });
  });
});
