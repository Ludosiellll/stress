import { describe, expect, it } from 'vitest';
import { deriveModuleStates } from '../engine/derive';
import type { ModuleState } from '../engine/planner';
import { LOG_LIMIT, type Repository } from './repository';
import type { BlockRow, DiagnosticRow, LogicItemRow, LogRow, SessionRow, TrialRow, WellbeingRow } from './rows';

export function session(id: string, startedAt: string, over: Partial<SessionRow> = {}): SessionRow {
  return { id, startedAt, endedAt: null, kind: 'training', phase: 'base', appVersion: '0.1.0', ...over };
}

export function block(id: string, sessionId: string, startedAt: string, over: Partial<BlockRow> = {}): BlockRow {
  return {
    id,
    sessionId,
    module: 'pzmr',
    lBefore: 3,
    lAfter: 3.5,
    paramsJson: '{"windowMs":512}',
    score: 0.85,
    flags: [],
    startedAt,
    summaryJson: '{"medianRt":301.5}',
    ...over,
  };
}

export function trial(id: string, blockId: string, idx: number, over: Partial<TrialRow> = {}): TrialRow {
  return {
    id,
    blockId,
    idx,
    stimulusJson: '{"color":"red"}',
    responseJson: '{"key":"Space"}',
    onsetTs: 1000.25,
    responseTs: 1301.75,
    rtMs: 301.5,
    outcome: 'hit',
    frameDropped: false,
    ...over,
  };
}

export function item(id: string, blockId: string, at: string, over: Partial<LogicItemRow> = {}): LogicItemRow {
  return {
    id,
    blockId,
    family: 'arith',
    seed: 4_000_000_000,
    difficulty: 850,
    answer: -12,
    given: -12,
    correct: true,
    timeMs: 12_345.5,
    timeLimitMs: null,
    at,
    ...over,
  };
}

function logRow(n: number): LogRow {
  return { id: `log-${String(n)}`, at: `2026-10-14T10:00:00.${String(n % 1000).padStart(3, '0')}Z`, level: 'info', message: `m${String(n)}`, detail: '' };
}

const T1 = '2026-10-01T08:00:00.000Z';
const T2 = '2026-10-02T08:00:00.000Z';
const T3 = '2026-10-03T08:00:00.000Z';

export function repositoryContract(make: () => Promise<Repository>): void {
  describe('sessions', () => {
    it('round-trips and lists by startedAt', async () => {
      const repo = await make();
      const late = session('s2', T2, { kind: 'diagnostic', phase: 'peak', appVersion: '0.2.0' });
      const early = session('s1', T1, { kind: 'free' });
      await repo.createSession(late);
      await repo.createSession(early);
      expect(await repo.listSessions()).toEqual([early, late]);
    });

    it('finishSession sets endedAt; an unknown id is a no-op', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1));
      await repo.finishSession('s1', T2);
      await repo.finishSession('nope', T3);
      expect(await repo.listSessions()).toEqual([session('s1', T1, { endedAt: T2 })]);
    });

    it('rejects a duplicate id and keeps the original', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1));
      await expect(repo.createSession(session('s1', T2))).rejects.toThrow();
      expect(await repo.listSessions()).toEqual([session('s1', T1)]);
    });
  });

  describe('blocks, trials, logic items', () => {
    it('round-trips every field, including flags, nulls, fractions and text', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1));
      const b = block('b1', 's1', T1, {
        module: 'numseries',
        flags: ['fatigued', 'timing_unreliable', 'calibration'],
        paramsJson: '{"q":"a;b\\"c\\nd","ru":"Числовые ряды"}',
        lBefore: 0,
        lAfter: 2.75,
        score: 0,
      });
      const trials = [
        trial('t1', 'b1', 0),
        trial('t2', 'b1', 1, { onsetTs: null, responseTs: null, rtMs: null, outcome: 'miss', frameDropped: true }),
      ];
      const items = [
        item('i1', 'b1', T1, { timeLimitMs: 11_900 }),
        item('i2', 'b1', T2, { family: 'opcycle', given: null, correct: false, timeMs: 40_000, answer: 99_999, seed: 0, timeLimitMs: null }),
      ];
      await repo.addBlock(b, trials, items);
      expect(await repo.listBlocks()).toEqual([b]);
      expect(await repo.listTrials('b1')).toEqual(trials);
      expect(await repo.listLogicItems()).toEqual(items);
    });

    it('lists blocks by startedAt, items by at, trials of one block by idx', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1));
      await repo.addBlock(block('b2', 's1', T3), [trial('t3', 'b2', 1), trial('t2', 'b2', 0)], [item('i2', 'b2', T3)]);
      await repo.addBlock(block('b1', 's1', T1), [trial('t1', 'b1', 0)], [item('i1', 'b1', T2)]);
      await repo.addBlock(block('b3', 's1', T3), [], []);
      expect((await repo.listBlocks()).map((x) => x.id)).toEqual(['b1', 'b2', 'b3']);
      expect((await repo.listTrials('b2')).map((x) => x.id)).toEqual(['t2', 't3']);
      expect((await repo.listTrials('b1')).map((x) => x.id)).toEqual(['t1']);
      expect(await repo.listTrials('none')).toEqual([]);
      expect((await repo.listLogicItems()).map((x) => x.id)).toEqual(['i1', 'i2']);
    });

    it('listAllTrials returns every trial by block startedAt, then idx (R20)', async () => {
      const repo = await make();
      expect(await repo.listAllTrials()).toEqual([]);
      await repo.createSession(session('s1', T1));
      await repo.addBlock(block('b2', 's1', T3), [trial('t3', 'b2', 1), trial('t2', 'b2', 0)], []);
      await repo.addBlock(block('b1', 's1', T1), [trial('t1b', 'b1', 1), trial('t1a', 'b1', 0)], []);
      await repo.addBlock(block('b3', 's1', T3), [trial('t4', 'b3', 0)], []);
      await repo.addBlock(block('b0', 's1', T2), [], []);
      const all = await repo.listAllTrials();
      expect(all.map((x) => x.id)).toEqual(['t1a', 't1b', 't2', 't3', 't4']);
      expect(all[0]).toEqual(trial('t1a', 'b1', 0));
      if (all[0]) all[0].outcome = 'mutated';
      expect((await repo.listAllTrials())[0]).toEqual(trial('t1a', 'b1', 0));
    });

    it('addBlock is atomic: a duplicate trial id stores nothing', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1));
      await expect(
        repo.addBlock(block('b1', 's1', T1), [trial('t1', 'b1', 0), trial('t1', 'b1', 1)], [item('i1', 'b1', T1)]),
      ).rejects.toThrow();
      expect(await repo.listBlocks()).toEqual([]);
      expect(await repo.listTrials('b1')).toEqual([]);
      expect(await repo.listLogicItems()).toEqual([]);
    });

    it('addBlock is atomic: a logic item id already stored rejects the whole block', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1));
      await repo.addBlock(block('b1', 's1', T1), [], [item('i1', 'b1', T1)]);
      await expect(
        repo.addBlock(block('b2', 's1', T2), [trial('t1', 'b2', 0)], [item('i2', 'b2', T2), item('i1', 'b2', T2)]),
      ).rejects.toThrow();
      expect((await repo.listBlocks()).map((x) => x.id)).toEqual(['b1']);
      expect(await repo.listTrials('b2')).toEqual([]);
      expect((await repo.listLogicItems()).map((x) => x.id)).toEqual(['i1']);
    });

    it('rejects a duplicate block id and keeps the original', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1));
      await repo.addBlock(block('b1', 's1', T1), [trial('t1', 'b1', 0)], []);
      await expect(repo.addBlock(block('b1', 's1', T2, { score: 0.1 }), [trial('t9', 'b1', 0)], [])).rejects.toThrow();
      expect(await repo.listBlocks()).toEqual([block('b1', 's1', T1)]);
      expect((await repo.listTrials('b1')).map((x) => x.id)).toEqual(['t1']);
    });

    it('hasBlock tells whether a block id is stored (M8)', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1));
      expect(await repo.hasBlock('b1')).toBe(false);
      await repo.addBlock(block('b1', 's1', T1), [trial('t1', 'b1', 0)], []);
      expect(await repo.hasBlock('b1')).toBe(true);
      expect(await repo.hasBlock('b2')).toBe(false);
      await expect(repo.addBlock(block('b2', 's1', T1), [trial('t1', 'b2', 0)], [])).rejects.toThrow();
      expect(await repo.hasBlock('b2')).toBe(false);
    });

    it('rejects a block of an unknown session', async () => {
      const repo = await make();
      await expect(repo.addBlock(block('b1', 'ghost', T1), [], [])).rejects.toThrow();
      expect(await repo.listBlocks()).toEqual([]);
    });

    it('rejects non-finite numbers anywhere in the payload and stores nothing (R23)', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1));
      const bad: [string, () => Promise<void>][] = [
        ['score', () => repo.addBlock(block('b1', 's1', T1, { score: Number.NaN }), [], [])],
        ['lBefore', () => repo.addBlock(block('b1', 's1', T1, { lBefore: Number.POSITIVE_INFINITY }), [], [])],
        ['lAfter', () => repo.addBlock(block('b1', 's1', T1, { lAfter: Number.NaN }), [], [])],
        ['idx', () => repo.addBlock(block('b1', 's1', T1), [trial('t1', 'b1', Number.NaN)], [])],
        ['rtMs', () => repo.addBlock(block('b1', 's1', T1), [trial('t1', 'b1', 0, { rtMs: Number.NaN })], [])],
        ['onsetTs', () => repo.addBlock(block('b1', 's1', T1), [trial('t1', 'b1', 0, { onsetTs: Number.NEGATIVE_INFINITY })], [])],
        ['responseTs', () => repo.addBlock(block('b1', 's1', T1), [trial('t1', 'b1', 0, { responseTs: Number.NaN })], [])],
        ['timeMs', () => repo.addBlock(block('b1', 's1', T1), [], [item('i1', 'b1', T1, { timeMs: Number.POSITIVE_INFINITY })])],
        ['difficulty', () => repo.addBlock(block('b1', 's1', T1), [], [item('i1', 'b1', T1, { difficulty: Number.NaN })])],
        ['answer', () => repo.addBlock(block('b1', 's1', T1), [], [item('i1', 'b1', T1, { answer: Number.NaN })])],
        ['given', () => repo.addBlock(block('b1', 's1', T1), [], [item('i1', 'b1', T1, { given: Number.NaN })])],
        ['seed', () => repo.addBlock(block('b1', 's1', T1), [], [item('i1', 'b1', T1, { seed: Number.NaN })])],
        ['timeLimitMs', () => repo.addBlock(block('b1', 's1', T1), [], [item('i1', 'b1', T1, { timeLimitMs: Number.NaN })])],
      ];
      for (const [field, write] of bad) {
        await expect(write(), field).rejects.toThrow(new RegExp(`${field} is not a finite number`));
      }
      expect(await repo.listBlocks()).toEqual([]);
      expect(await repo.listAllTrials()).toEqual([]);
      expect(await repo.listLogicItems()).toEqual([]);
      // null stays allowed where the row type allows it.
      await repo.addBlock(
        block('b1', 's1', T1),
        [trial('t1', 'b1', 0, { rtMs: null, onsetTs: null, responseTs: null })],
        [item('i1', 'b1', T1, { given: null })],
      );
      expect(await repo.listBlocks()).toHaveLength(1);
    });

    it('rejects a per-item time limit that is not positive (R36) and stores nothing', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1));
      for (const timeLimitMs of [0, -100]) {
        await expect(repo.addBlock(block('b1', 's1', T1), [], [item('i1', 'b1', T1, { timeLimitMs })])).rejects.toThrow(
          /timeLimitMs is not positive/,
        );
      }
      expect(await repo.listBlocks()).toEqual([]);
      expect(await repo.listLogicItems()).toEqual([]);
    });

    it('listBlockLevels returns the light rows of one module by startedAt (R26)', async () => {
      const repo = await make();
      expect(await repo.listBlockLevels('pzmr')).toEqual([]);
      await repo.createSession(session('s1', T1));
      await repo.createSession(session('s2', T2, { kind: 'diagnostic' }));
      await repo.addBlock(block('b3', 's2', T3, { lAfter: 9, flags: ['timing_unreliable'] }), [trial('t1', 'b3', 0)], []);
      await repo.addBlock(block('b1', 's1', T1, { lAfter: 4, flags: ['calibration'] }), [], []);
      await repo.addBlock(block('bx', 's1', T2, { module: 'gorbov' }), [], []);
      await repo.addBlock(block('b2', 's1', T3, { lAfter: 5 }), [], []);
      const rows = await repo.listBlockLevels('pzmr');
      expect(rows).toEqual([
        { id: 'b1', sessionId: 's1', module: 'pzmr', lAfter: 4, flags: ['calibration'], startedAt: T1 },
        { id: 'b3', sessionId: 's2', module: 'pzmr', lAfter: 9, flags: ['timing_unreliable'], startedAt: T3 },
        { id: 'b2', sessionId: 's1', module: 'pzmr', lAfter: 5, flags: [], startedAt: T3 },
      ]);
      rows[0]?.flags.push('fatigued');
      expect((await repo.listBlockLevels('pzmr'))[0]?.flags).toEqual(['calibration']);
      // The light rows are enough for deriveModuleStates and agree with full rows.
      const sessions = await repo.listSessions();
      expect(deriveModuleStates(sessions, rows).pzmr).toEqual(deriveModuleStates(sessions, await repo.listBlocks()).pzmr);
    });

    it('rejects trials or items that name another block', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1));
      await expect(repo.addBlock(block('b1', 's1', T1), [trial('t1', 'other', 0)], [])).rejects.toThrow();
      await expect(repo.addBlock(block('b1', 's1', T1), [], [item('i1', 'other', T1)])).rejects.toThrow();
      expect(await repo.listBlocks()).toEqual([]);
    });
  });

  describe('diagnostics and wellbeing', () => {
    it('round-trips diagnostics ordered by number', async () => {
      const repo = await make();
      await repo.createSession(session('s1', T1, { kind: 'diagnostic' }));
      const d2: DiagnosticRow = { id: 'd2', sessionId: 's1', number: 2, at: T3, resultsJson: '{"pzmr":{"medianRt":250}}' };
      const d1: DiagnosticRow = { id: 'd1', sessionId: 's1', number: 1, at: T1, resultsJson: '{}' };
      await repo.addDiagnostic(d2);
      await repo.addDiagnostic(d1);
      expect(await repo.listDiagnostics()).toEqual([d1, d2]);
    });

    it('rejects a diagnostic of an unknown session', async () => {
      const repo = await make();
      await expect(repo.addDiagnostic({ id: 'd1', sessionId: 'ghost', number: 1, at: T1, resultsJson: '{}' })).rejects.toThrow();
      expect(await repo.listDiagnostics()).toEqual([]);
    });

    it('round-trips wellbeing ordered by date', async () => {
      const repo = await make();
      const w2: WellbeingRow = { id: 'w2', date: '2026-10-02', sleepH: 7.5, caffeine: true, mood: 5 };
      const w1: WellbeingRow = { id: 'w1', date: '2026-10-01', sleepH: 5, caffeine: false, mood: 1 };
      await repo.addWellbeing(w2);
      await repo.addWellbeing(w1);
      expect(await repo.listWellbeing()).toEqual([w1, w2]);
      await expect(repo.addWellbeing(w1)).rejects.toThrow();
    });
  });

  describe('caches', () => {
    it('returns defaults for all 7 modules, then saved states', async () => {
      const repo = await make();
      const initial = await repo.getModuleStates();
      expect(Object.keys(initial).sort()).toEqual(['gonogo', 'gorbov', 'numseries', 'pzmr', 'rdo', 'schulte', 'szmr']);
      expect(initial.rdo).toEqual({
        module: 'rdo',
        lSaved: 0,
        sessionEndLevels: [],
        savedHistory: [],
        plateau: false,
        lastTrainedAt: null,
        lifetimeBlocks: 0,
      });
      const s: ModuleState = {
        module: 'gorbov',
        lSaved: 4.5,
        sessionEndLevels: [3, 4.5, 6],
        savedHistory: [3, 3.75, 4.5],
        plateau: true,
        lastTrainedAt: T2,
        lifetimeBlocks: 12,
      };
      await repo.saveModuleState(s);
      await repo.saveModuleState({ ...s, module: 'pzmr', plateau: false, lastTrainedAt: null });
      await repo.saveModuleState({ ...s, lifetimeBlocks: 13 });
      const states = await repo.getModuleStates();
      expect(states.gorbov).toEqual({ ...s, lifetimeBlocks: 13 });
      expect(states.pzmr).toEqual({ ...s, module: 'pzmr', plateau: false, lastTrainedAt: null });
      expect(states.rdo).toEqual(initial.rdo);
    });

    it('ratings start empty; a save replaces the whole cache', async () => {
      const repo = await make();
      expect(await repo.getRatings()).toEqual(new Map());
      const both = new Map([
        ['geom', { rating: 1012.5, n: 3 }],
        ['arith', { rating: 990, n: 1 }],
      ] as const);
      await repo.saveRatings(both);
      expect(await repo.getRatings()).toEqual(both);
      await repo.saveRatings(new Map([['arith', { rating: 1001.25, n: 2 }]]));
      expect(await repo.getRatings()).toEqual(new Map([['arith', { rating: 1001.25, n: 2 }]]));
      await repo.saveRatings(new Map());
      expect(await repo.getRatings()).toEqual(new Map());
    });
  });

  describe('settings', () => {
    it('defaults to keyboard, null, null', async () => {
      const repo = await make();
      expect(await repo.getSettings()).toEqual({ layout: 'keyboard', testDate: null, lastSelfCheckJson: null });
    });

    it('merges partial saves over defaults and earlier saves', async () => {
      const repo = await make();
      await repo.saveSettings({ testDate: '2026-12-01' });
      expect(await repo.getSettings()).toEqual({ layout: 'keyboard', testDate: '2026-12-01', lastSelfCheckJson: null });
      await repo.saveSettings({ layout: 'pult', lastSelfCheckJson: '{"hz":60}' });
      await repo.saveSettings({});
      expect(await repo.getSettings()).toEqual({ layout: 'pult', testDate: '2026-12-01', lastSelfCheckJson: '{"hz":60}' });
      await repo.saveSettings({ testDate: null });
      expect(await repo.getSettings()).toEqual({ layout: 'pult', testDate: null, lastSelfCheckJson: '{"hz":60}' });
    });
  });

  describe('log', () => {
    it('lists newest first up to the limit', async () => {
      const repo = await make();
      for (let n = 0; n < 3; n++) await repo.appendLog(logRow(n));
      expect((await repo.listLog(2)).map((x) => x.id)).toEqual(['log-2', 'log-1']);
      expect(await repo.listLog(10)).toEqual([logRow(2), logRow(1), logRow(0)]);
      expect(await repo.listLog(0)).toEqual([]);
    });

    it('rejects a duplicate log id and keeps the log unchanged', async () => {
      const repo = await make();
      await repo.appendLog(logRow(1));
      await expect(repo.appendLog({ ...logRow(1), message: 'again' })).rejects.toThrow();
      expect(await repo.listLog(10)).toEqual([logRow(1)]);
    });

    it(`keeps exactly ${String(LOG_LIMIT)} entries: the ${String(LOG_LIMIT + 1)}th append drops the oldest`, async () => {
      const repo = await make();
      for (let n = 0; n < LOG_LIMIT; n++) await repo.appendLog(logRow(n));
      let all = await repo.listLog(10_000);
      expect(all).toHaveLength(LOG_LIMIT);
      expect(all.at(-1)?.id).toBe('log-0');
      await repo.appendLog(logRow(LOG_LIMIT));
      all = await repo.listLog(10_000);
      expect(all).toHaveLength(LOG_LIMIT);
      expect(all[0]?.id).toBe(`log-${String(LOG_LIMIT)}`);
      expect(all.at(-1)?.id).toBe('log-1');
    });
  });

  describe('copies', () => {
    it('stored rows are isolated from inputs and from returned values', async () => {
      const repo = await make();
      const s = session('s1', T1);
      const b = block('b1', 's1', T1, { flags: ['calibration'] });
      const t = trial('t1', 'b1', 0);
      const i = item('i1', 'b1', T1);
      await repo.createSession(s);
      await repo.addBlock(b, [t], [i]);
      s.phase = 'mutated';
      b.flags.push('fatigued');
      t.outcome = 'mutated';
      i.correct = false;

      const blocks = await repo.listBlocks();
      blocks[0]?.flags.push('timing_unreliable');
      const sessions = await repo.listSessions();
      if (sessions[0]) sessions[0].endedAt = T3;
      const trials = await repo.listTrials('b1');
      if (trials[0]) trials[0].rtMs = 1;
      const items = await repo.listLogicItems();
      if (items[0]) items[0].given = 0;

      expect(await repo.listSessions()).toEqual([session('s1', T1)]);
      expect(await repo.listBlocks()).toEqual([block('b1', 's1', T1, { flags: ['calibration'] })]);
      expect(await repo.listTrials('b1')).toEqual([trial('t1', 'b1', 0)]);
      expect(await repo.listLogicItems()).toEqual([item('i1', 'b1', T1)]);
    });

    it('caches, settings and log are isolated too', async () => {
      const repo = await make();
      const state: ModuleState = {
        module: 'szmr',
        lSaved: 2,
        sessionEndLevels: [2],
        savedHistory: [2],
        plateau: false,
        lastTrainedAt: T1,
        lifetimeBlocks: 1,
      };
      await repo.saveModuleState(state);
      state.sessionEndLevels.push(99);
      const states = await repo.getModuleStates();
      states.szmr.savedHistory.push(99);
      states.pzmr.sessionEndLevels.push(99);
      const again = await repo.getModuleStates();
      expect(again.szmr).toEqual({ ...state, sessionEndLevels: [2] });
      expect(again.pzmr.sessionEndLevels).toEqual([]);

      const rating = { rating: 1000, n: 0 };
      await repo.saveRatings(new Map([['fib', rating]]));
      rating.n = 50;
      const ratings = await repo.getRatings();
      const fib = ratings.get('fib');
      if (fib) fib.rating = 1;
      expect(await repo.getRatings()).toEqual(new Map([['fib', { rating: 1000, n: 0 }]]));

      const settings = await repo.getSettings();
      settings.layout = 'mouse';
      expect((await repo.getSettings()).layout).toBe('keyboard');

      const log = logRow(1);
      await repo.appendLog(log);
      log.message = 'mutated';
      const listed = await repo.listLog(1);
      if (listed[0]) listed[0].detail = 'mutated';
      expect(await repo.listLog(1)).toEqual([logRow(1)]);
    });
  });
}
