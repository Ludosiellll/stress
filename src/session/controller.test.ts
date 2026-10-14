import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../data/memoryRepository';
import type { Repository } from '../data/repository';
import type { BlockRow, WellbeingRow } from '../data/rows';
import { deriveModuleStates, deriveRatings, defaultModuleState } from '../engine/derive';
import { diagnosticSegmentSeed, diagnosticSeriesSchedule, planDiagnostic, type DiagnosticResults } from '../engine/diagnostic';
import { planFree, planTraining, type ModuleState, type Segment, type SessionPlan } from '../engine/planner';
import { createRng, deriveSeed } from '../engine/rng';
import type { LayoutId, ModuleId } from '../engine/types';
import { FAMILIES } from '../modules/numseries/families';
import { pzmr } from '../modules/reaction/pzmr';
import { szmr } from '../modules/reaction/szmr';
import { gorbovMetrics } from '../modules/tables/gorbov';
import { perfectPlayer, perfectSeriesAnswers, perfectTableRun, playTimeline, type Respond } from '../testing/sessionPlayers';
import { SessionController, type SessionStartOptions } from './controller';
import type { Step, StepOf } from './steps';

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

const segment = (module: ModuleId, budgetMs: number): SessionPlan['segments'][number] => ({
  module,
  budgetMs,
  purpose: 'free',
});

describe('SessionController — flow', () => {
  it('walks a full training plan to done', async () => {
    const repo = new MemoryRepository();
    const plan = planTraining(await repo.getModuleStates(), T0, 42);
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
      'instruction:gorbov',
      'table_block:gorbov:alternate',
      'summary',
      'instruction:schulte',
      ...blocks('table_block:schulte:schulte', 2),
      'instruction:numseries',
      ...['numseries_block', summaries(1), 'numseries_block', summaries(1), 'numseries_block', summaries(1)].flat(),
      'numseries_block',
      'summary',
      'wellbeing',
      'done',
    ]);
    const [session] = await repo.listSessions();
    expect(session).toMatchObject({ id: h.c.sessionId, kind: 'training', phase: 'w1', appVersion: '0.1.0-test', startedAt: new Date(T0).toISOString() });
    expect(session?.endedAt).toBe(h.clock.now().toISOString());
    expect((await repo.listBlocks()).map((b) => b.module)).toEqual([
      'pzmr',
      'szmr',
      'szmr',
      'gonogo',
      'gonogo',
      'gorbov',
      'gorbov',
      'gorbov',
      'schulte',
      'schulte',
      'numseries',
      'numseries',
      'numseries',
      'numseries',
    ]);
    expect(expectStep(h.c, 'done')).toEqual({ kind: 'done', sessionId: h.c.sessionId, diagnostic: null, seriesTotal: null });
  });

  it('free session ends with done, no wellbeing', async () => {
    const h = await begin(planFree('rdo', 3));
    const seen = await drive(h, { blockMs: 100_000 });
    expect(seen).toEqual([
      'instruction:rdo',
      'reaction_block:rdo',
      'summary',
      'reaction_block:rdo',
      'summary',
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
    const t = await begin(planTraining((await new MemoryRepository().getModuleStates()), T0, 1));
    expect(expectStep(t.c, 'instruction')).toEqual({
      kind: 'instruction',
      module: 'pzmr',
      text: pzmr.instruction('keyboard', pzmr.params(0)),
      keysHint: 'Пробел',
    });

    const sz = await begin(planFree('szmr', 1), { layout: 'pult' });
    expect(expectStep(sz.c, 'instruction')).toMatchObject({ text: szmr.instruction('pult', szmr.params(0)), keysHint: '←, →' });
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
      text: 'Найди закономерность и введи следующее число. На задачу до 40 секунд, на трудных уровнях меньше: остаток времени показывает полоса.',
      keysHint: 'Цифры и Enter',
    });

    const dg = await begin({ ...planDiagnostic(1), segments: [planDiagnostic(1).segments[5] as SessionPlan['segments'][number]] });
    expect(expectStep(dg.c, 'instruction')).toMatchObject({
      text: '20 задач, общее время — 10 минут. Найди закономерность и введи следующее число.',
    });
  });

  it('mouse layout falls back to the keyboard when the level needs more than 2 keys', async () => {
    const repo = new MemoryRepository();
    await repo.saveModuleState(stateWith('szmr', { lSaved: 18, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    const h = await begin(planFree('szmr', 1), { repo, layout: 'mouse' });
    const instr = expectStep(h.c, 'instruction');
    expect(instr.keysHint).toBe('D, F, J, K');
    expect(instr.text).toBe(szmr.instruction('mouse', szmr.params(16)));
    h.c.ackInstruction();
    expect(expectStep(h.c, 'reaction_block')).toMatchObject({ L: 16, keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'], layout: 'keyboard' });
  });

  it('shows the instruction again when the rules change mid-segment (СЗМР gets a third color)', async () => {
    const repo = new MemoryRepository();
    await repo.saveModuleState(stateWith('szmr', { lSaved: 9, lastTrainedAt: T0, lifetimeBlocks: 10 }));
    const h = await begin(planFree('szmr', 1), { repo });
    h.c.ackInstruction();
    const start = h.clock.ms;
    expect(expectStep(h.c, 'reaction_block').L).toBe(7);
    h.clock.advance(4 * MIN);
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    expect(expectStep(h.c, 'summary').view.lAfter).toBe(8);
    await h.c.continueAfterSummary();
    expect(expectStep(h.c, 'instruction').text).toBe(szmr.instruction('keyboard', szmr.params(8)));
    h.c.ackInstruction(); // does not restart the segment clock
    expect(expectStep(h.c, 'reaction_block').L).toBe(8);
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
    expect(() => {
      h.c.discardBlock('error');
    }).toThrow(/in progress/);
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
      changes: [{ label: 'Окно ответа', from: '1000 мс', to: '808 мс' }],
      score: 1,
      lines: ['Медиана: 300 мс', 'Среднее: 300 мс', 'Разброс (SD): 0 мс', 'Стабильность (CV): 0,00', 'Фальстарты: 0', 'Пропуски: 0'],
      flags: ['calibration'],
      showLevel: true,
    });
  });

  it('says why the level did not rise when the RT spread is above the stability threshold (I3)', async () => {
    const h = await begin(planFree('pzmr', 1));
    const rts = [150, 500];
    const { view } = await playReaction(h, (spec, idx) => ({ key: 'Space', rtMs: rts[idx % 2] as number }));
    expect(view.score).toBe(1);
    expect(view.lAfter).toBe(view.lBefore);
    const line = view.lines.find((l) => l.startsWith('Уровень не повышен'));
    expect(line).toMatch(/^Уровень не повышен: разброс выше порога \(CV 0,\d\d > 0,25\)$/);
    const cvLine = view.lines.find((l) => l.startsWith('Стабильность (CV): '));
    expect(line).toContain(`CV ${cvLine?.slice('Стабильность (CV): '.length) ?? ''} >`);
  });

  it('no stability line when the spread is within the threshold or the score is not above 0.8', async () => {
    const h = await begin(planFree('pzmr', 1));
    expect((await playReaction(h)).view.lines.some((l) => l.startsWith('Уровень не повышен'))).toBe(false);
    await h.c.continueAfterSummary();
    const rts = [150, 500];
    const weak = await playReaction(h, (spec, idx) => (idx % 3 === 0 ? null : { key: 'Space', rtMs: rts[idx % 2] as number }));
    expect(weak.view.score).toBeLessThanOrEqual(0.8);
    expect(weak.view.lines.some((l) => l.startsWith('Уровень не повышен'))).toBe(false);
  });

  it('segment starts at startLevel(lSaved, days since last training)', async () => {
    const at = async (lastTrainedAt: string | null, lSaved: number): Promise<number> => {
      const repo = new MemoryRepository();
      await repo.saveModuleState(stateWith('gonogo', { lSaved, lastTrainedAt, lifetimeBlocks: lastTrainedAt ? 9 : 0 }));
      const h = await begin(planFree('gonogo', 1), { repo });
      h.c.ackInstruction();
      return expectStep(h.c, 'reaction_block').L;
    };
    expect(await at(new Date(new Date(T0).getTime() - 2 * DAY).toISOString(), 10)).toBe(8);
    expect(await at(new Date(new Date(T0).getTime() - 6 * DAY).toISOString(), 10)).toBe(7);
    expect(await at(new Date(new Date(T0).getTime() + 3 * DAY).toISOString(), 10)).toBe(8); // clock went back
    expect(await at(null, 0)).toBe(0);
    expect(await at(new Date(T0).toISOString(), 1)).toBe(0);
  });

  it('calibration covers the first 3 blocks of a module ever', async () => {
    const repo = new MemoryRepository();
    await repo.saveModuleState(stateWith('pzmr', { lSaved: 4, lastTrainedAt: T0, lifetimeBlocks: 1 }));
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
    expect(JSON.parse(row.paramsJson)).toEqual(pzmr.params(0));
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
    expect(expectStep(h.c, 'reaction_block').specs).toEqual(gen('0:0:0', 0));
    h.c.discardBlock('focus_lost');
    expect(expectStep(h.c, 'reaction_block').specs).toEqual(gen('0:0:1', 0));
    await h.c.submitReaction(playTimeline(expectStep(h.c, 'reaction_block').specs, perfectPlayer));
    await h.c.continueAfterSummary();
    expect(expectStep(h.c, 'reaction_block').specs).toEqual(gen('0:1:0', 2));
  });

  it('discardBlock keeps level and writes nothing', async () => {
    const h = await begin(planFree('szmr', 5));
    await playReaction(h);
    await h.c.continueAfterSummary();
    const before = expectStep(h.c, 'reaction_block');
    const blocksBefore = await h.repo.listBlocks();
    const stateBefore = await h.repo.getModuleStates();
    h.c.discardBlock('focus_lost');
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
    t.c.discardBlock('user');
    expect(t.c.discards).toEqual([{ module: 'schulte', reason: 'user' }]);
    const again = expectStep(t.c, 'table_block');
    expect(again.seed).not.toBe(table.seed);
    expect(again.L).toBe(table.L);

    const n = await begin(planFree('numseries', 5));
    n.c.ackInstruction();
    const items = expectStep(n.c, 'numseries_block').items;
    n.c.discardBlock('error');
    expect(expectStep(n.c, 'numseries_block').items).not.toEqual(items);
    expect(await n.repo.listBlocks()).toEqual([]);
  });

  it('timing_unreliable block does not change L', async () => {
    const repo = new MemoryRepository();
    await repo.saveModuleState(stateWith('pzmr', { lSaved: 10, lastTrainedAt: T0, lifetimeBlocks: 10, sessionEndLevels: [10] }));
    const h = await begin(planFree('pzmr', 1), { repo });
    const unreliable = await playReaction(h, perfectPlayer, (idx) => idx < 2); // 2 of 15 onsets dropped > 5 %
    expect(unreliable.view.flags).toEqual(['timing_unreliable']);
    expect(unreliable.view.lBefore).toBe(8);
    expect(unreliable.view.lAfter).toBe(8);
    // Module state is re-derived from history: the block counts, but gives no session-end level.
    expect((await h.repo.getModuleStates()).pzmr).toMatchObject({ lifetimeBlocks: 1, sessionEndLevels: [], lSaved: 0 });

    // The unreliable s = 1 does not count as the previous score: g stays 1 for the next block.
    await h.c.continueAfterSummary();
    const next = await playReaction(h, (spec, idx) => (idx === 0 ? null : perfectPlayer(spec, idx)));
    expect(next.view.score).toBeCloseTo(14 / 15, 12);
    expect(next.view.lAfter).toBeCloseTo(8 + (14 / 15 - 0.8) / 0.2, 9);
  });

  it('state writes read the module levels, never the whole block history (R26); caches equal a rebuild', async () => {
    class SpyRepo extends MemoryRepository {
      listBlocksCalls = 0;
      override listBlocks(): Promise<BlockRow[]> {
        this.listBlocksCalls++;
        return super.listBlocks();
      }
    }
    const repo = new SpyRepo();
    const clock = new Clock();
    for (let day = 0; day < 2; day++) {
      const plan = planTraining(await repo.getModuleStates(), clock.now().toISOString(), 42 + day);
      await drive(await begin(plan, { repo, clock }), { blockMs: 150_000 });
      clock.advance(DAY);
    }
    expect(repo.listBlocksCalls).toBe(0);
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
      expect(again.specs).toEqual(real(pzmr.params(0), createRng(deriveSeed(1, '0:0:1')), 'keyboard', 15));
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
    expect(expectStep(b.c, 'reaction_block').L).toBe(Math.max(0, afterA.lSaved - 2));
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
    expect(third.specs).toEqual(pzmr.generateBlock(pzmr.params(2), createRng(deriveSeed(1, '0:2:0')), 'keyboard', 15));
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
    expect(next.specs).toEqual(pzmr.generateBlock(pzmr.params(2), createRng(deriveSeed(1, '0:1:0')), 'keyboard', 15));
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

  it('a run of another task or time limit is rejected', async () => {
    const h = await begin(planFree('gorbov', 4));
    h.c.ackInstruction();
    const step = expectStep(h.c, 'table_block');
    await expect(h.c.submitTable({ ...perfectTableRun(step), task: 'red_down', total: 25 })).rejects.toThrow(/task/);
    await expect(h.c.submitTable({ ...perfectTableRun(step), timeLimitMs: 1 })).rejects.toThrow(/time limit/);
    expectStep(h.c, 'table_block');
  });
});

describe('SessionController — number series', () => {
  it('numseries updates ratings', async () => {
    const h = await begin(planFree('numseries', 21));
    h.c.ackInstruction();
    const block = expectStep(h.c, 'numseries_block');
    expect(block.items).toHaveLength(10);
    // Starting ratings (R0) stay under every family's structural maximum: 40 s per item.
    expect(block.items.map((it) => it.timeLimitMs)).toEqual(Array<number>(10).fill(40_000));
    expect(block.totalLimitMs).toBeNull();
    const answers = perfectSeriesAnswers(block.items);
    // Right but too slow: not a success for Elo.
    answers[0] = { itemId: block.items[0]?.id ?? '', given: block.items[0]?.answer ?? 0, timeMs: 41_000 };
    // Wrong answer and no answer.
    answers[1] = { itemId: block.items[1]?.id ?? '', given: (block.items[1]?.answer ?? 0) + 1, timeMs: 9000 };
    answers[2] = { itemId: block.items[2]?.id ?? '', given: null, timeMs: 40_000 };
    await h.c.submitNumSeries(answers);

    const { view } = expectStep(h.c, 'summary');
    expect(view).toMatchObject({ module: 'numseries', title: 'Числовые ряды', lBefore: 0, lAfter: 0, changes: [], score: 0.7, flags: [], showLevel: false });
    expect(view.lines).toEqual(['Верно: 7 из 10', `Среднее время: ${String(Math.round((41 + 9 + 40 + 7 * 5) / 10))} с`]);

    const items = await h.repo.listLogicItems();
    expect(items).toHaveLength(10);
    expect(items.map((i) => i.correct)).toEqual([true, false, false, true, true, true, true, true, true, true]);
    expect(items[2]).toMatchObject({ given: null, timeMs: 40_000, family: block.items[2]?.family, seed: block.items[2]?.seed });
    expect(items.map((i) => i.timeLimitMs)).toEqual(Array<number>(10).fill(40_000));

    const ratings = await h.repo.getRatings();
    expect(ratings).toEqual(deriveRatings(items)); // incremental == rebuilt from history
    const total = [...ratings.values()].reduce((n, r) => n + r.n, 0);
    expect(total).toBe(10);
    const [blockRow] = await h.repo.listBlocks();
    expect(JSON.parse(blockRow?.summaryJson ?? '')).toMatchObject({ correct: 7, total: 10 });
    expect((await h.repo.getModuleStates()).numseries.lifetimeBlocks).toBe(1);
  });

  it('numseries stores per-item limits and names the shortest', async () => {
    const repo = new MemoryRepository();
    await repo.saveRatings(new Map(FAMILIES.map((f) => [f, { rating: 1900, n: 60 }])));
    const h = await begin(planFree('numseries', 21), { repo });
    h.c.ackInstruction();
    const block = expectStep(h.c, 'numseries_block');
    const limits = block.items.map((it) => it.timeLimitMs ?? Number.NaN);
    for (const limit of limits) {
      expect(limit).toBeLessThan(40_000);
      expect(limit).toBeGreaterThanOrEqual(8000);
    }
    await h.c.submitNumSeries(perfectSeriesAnswers(block.items));

    const shortest = Math.min(...limits) / 1000;
    const seconds = Number.isInteger(shortest) ? String(shortest) : shortest.toFixed(1).replace('.', ',');
    const { view } = expectStep(h.c, 'summary');
    expect(view.lines).toEqual(['Верно: 10 из 10', 'Среднее время: 5 с', `Самый короткий лимит: ${seconds} с`]);
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

describe('SessionController — diagnostics', () => {
  /** Fails every practice trial (no press), perfect otherwise. */
  const skipsPractice: Respond = (spec, idx) => (spec.practice ? null : perfectPlayer(spec, idx));

  it('diagnostic uses fixed L, ignores module state, writes diagnostic row', async () => {
    const repo = new MemoryRepository();
    const trained = stateWith('pzmr', { lSaved: 20, lastTrainedAt: T0, lifetimeBlocks: 30, sessionEndLevels: [20], savedHistory: [20] });
    await repo.saveModuleState(trained);
    const statesBefore = await repo.getModuleStates();
    const h = await begin(planDiagnostic(1), { repo });

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
        const segSeed = diagnosticSegmentSeed(1, 'numseries');
        const schedule = diagnosticSeriesSchedule();
        expect(s.items.map((it) => it.family)).toEqual(schedule.map((e) => e.family));
        expect(s.items.map((it) => it.seed)).toEqual(schedule.map((_, i) => deriveSeed(segSeed, 'item:' + String(i))));
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
      pzmrMedianRt: 300,
      szmrMedianRt: 300,
      gonogoScore: 100,
      rdoMeanAbsErrorMs: 0,
      gorbov: gorbovMetrics(7.2, 7.5, 14.7),
      numseriesCorrect: 20,
      unreliable: [],
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
      } else if (s.kind === 'summary') await h.c.continueAfterSummary();
      else throw new Error(`unexpected ${s.kind}`);
    }
    const done = expectStep(h.c, 'done');
    expect(done.diagnostic?.gorbov).toBeNull();
    expect(done.diagnostic?.numseriesCorrect).toBe(2);
    expect(done.seriesTotal).toBe(3);
  });

  it('the three diagnostic Gorbov tables come from different seeds', async () => {
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
    expect(seeds).toEqual([seg, deriveSeed(seg, 'run:1'), deriveSeed(seg, 'run:2')]);
    expect(tables.size).toBe(3);
  });

  it('a discarded diagnostic block is replaced by one from a derived seed, same L', async () => {
    const h = await begin(planDiagnostic(1));
    h.c.ackInstruction();
    const first = expectStep(h.c, 'reaction_block');
    h.c.discardBlock('focus_lost');
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

  it('family order of the series diagnostic matches FAMILIES (R16)', () => {
    expect(diagnosticSeriesSchedule().slice(0, 8).map((e) => e.family)).toEqual(FAMILIES);
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
    expect(expectStep(ds.c, 'instruction').text).toBe('3 задачи, общее время — 12 секунд. Найди закономерность и введи следующее число.');
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
