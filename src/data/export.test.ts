import { describe, expect, it } from 'vitest';
import { deriveModuleStates, deriveRatings, MODULE_IDS } from '../engine/derive';
import { ITEM_TIME_LIMIT_MS } from '../modules/numseries/generate';
import { NUMSERIES_ITEM_LIMIT_MS } from '../engine/derive';
import { exportBundle, rebuildCaches, toCsv } from './export';
import { MemoryRepository } from './memoryRepository';
import { block, item, session, trial } from './repository.contract';

describe('toCsv', () => {
  it('is empty for no rows', () => {
    expect(toCsv([])).toBe('');
  });

  it('uses the union of keys in first-seen order, ";" and CRLF', () => {
    const csv = toCsv([
      { a: 1, b: 'x' },
      { b: 'y', c: true },
    ]);
    expect(csv).toBe('a;b;c\r\n1;x;\r\n;y;true');
  });

  it('quotes fields with ;, quotes, CR or LF and doubles inner quotes', () => {
    const csv = toCsv([{ v: 'a;b' }, { v: 'say "hi"' }, { v: 'line1\nline2' }, { v: 'cr\rx' }, { v: 'plain text' }]);
    expect(csv).toBe('v\r\n"a;b"\r\n"say ""hi"""\r\n"line1\nline2"\r\n"cr\rx"\r\nplain text');
  });

  it('writes null and undefined as empty, objects as JSON', () => {
    const csv = toCsv([{ n: null, u: undefined, o: { k: 'a;b' }, arr: ['x', 1], num: -1.5 }]);
    expect(csv).toBe('n;u;o;arr;num\r\n;;"{""k"":""a;b""}";"[""x"",1]";-1.5');
  });

  it('quotes header names that need it', () => {
    expect(toCsv([{ 'a;b': 1 }])).toBe('"a;b"\r\n1');
  });
});

describe('exportBundle', () => {
  it('contains every table and the app version', async () => {
    const repo = new MemoryRepository();
    const s = session('s1', '2026-10-01T08:00:00.000Z');
    await repo.createSession(s);
    const b1 = block('b1', 's1', '2026-10-01T08:01:00.000Z');
    const b2 = block('b2', 's1', '2026-10-01T08:02:00.000Z', { module: 'numseries' });
    await repo.addBlock(b1, [trial('t1', 'b1', 0), trial('t2', 'b1', 1)], []);
    await repo.addBlock(b2, [], [item('i1', 'b2', '2026-10-01T08:02:30.000Z')]);
    const d = { id: 'd1', sessionId: 's1', number: 1, at: '2026-10-01T09:00:00.000Z', resultsJson: '{}' };
    await repo.addDiagnostic(d);
    const w = { id: 'w1', date: '2026-10-01', sleepH: 7, caffeine: false, mood: 3 as const };
    await repo.addWellbeing(w);
    await repo.saveSettings({ testDate: '2026-12-01' });

    const parsed = JSON.parse(await exportBundle(repo, '0.3.1')) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'appVersion',
      'exportedAt',
      'sessions',
      'blocks',
      'trials',
      'logicItems',
      'diagnostics',
      'wellbeing',
      'settings',
    ]);
    expect(parsed.appVersion).toBe('0.3.1');
    expect(new Date(parsed.exportedAt as string).toISOString()).toBe(parsed.exportedAt);
    expect(parsed.sessions).toEqual([s]);
    expect(parsed.blocks).toEqual([b1, b2]);
    expect(parsed.trials).toEqual([trial('t1', 'b1', 0), trial('t2', 'b1', 1)]);
    expect(parsed.logicItems).toEqual([item('i1', 'b2', '2026-10-01T08:02:30.000Z')]);
    expect(parsed.diagnostics).toEqual([d]);
    expect(parsed.wellbeing).toEqual([w]);
    expect(parsed.settings).toEqual({ layout: 'keyboard', testDate: '2026-12-01', lastSelfCheckJson: null });
  });
});

describe('rebuildCaches', () => {
  it('recomputes module states and ratings from history, leaving diagnostics out (R19)', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('t1', '2026-10-01T08:00:00.000Z'));
    await repo.createSession(session('diag', '2026-10-02T08:00:00.000Z', { kind: 'diagnostic' }));
    await repo.createSession(session('f1', '2026-10-03T08:00:00.000Z', { kind: 'free' }));
    await repo.addBlock(block('b1', 't1', '2026-10-01T08:01:00.000Z', { lAfter: 4 }), [], []);
    await repo.addBlock(block('b2', 't1', '2026-10-01T08:02:00.000Z', { module: 'numseries', lAfter: 1 }), [], [
      item('i1', 'b2', '2026-10-01T08:02:10.000Z', { family: 'fib', difficulty: 1200 }),
      item('i2', 'b2', '2026-10-01T08:02:20.000Z', { family: 'fib', difficulty: 1250, correct: false }),
    ]);
    await repo.addBlock(block('b3', 'diag', '2026-10-02T08:01:00.000Z', { module: 'numseries', lAfter: 9 }), [], [
      item('i3', 'b3', '2026-10-02T08:02:10.000Z', { family: 'fib', difficulty: 900 }),
      item('i4', 'b3', '2026-10-02T08:02:20.000Z', { family: 'geom', difficulty: 900 }),
    ]);
    await repo.addBlock(block('b4', 'f1', '2026-10-03T08:01:00.000Z', { module: 'numseries', lAfter: 2 }), [], [
      item('i5', 'b4', '2026-10-03T08:02:10.000Z', { family: 'arith', difficulty: 800, timeMs: 50_000 }),
    ]);
    // Stale caches that the rebuild must overwrite.
    await repo.saveRatings(new Map([['fib', { rating: 5, n: 99 }], ['powers', { rating: 5, n: 99 }]]));
    await repo.saveModuleState({ ...(await repo.getModuleStates()).pzmr, lSaved: 77, lifetimeBlocks: 99 });

    await rebuildCaches(repo);

    const sessions = await repo.listSessions();
    const blocks = await repo.listBlocks();
    const items = await repo.listLogicItems();
    const expectedStates = deriveModuleStates(sessions, blocks);
    const states = await repo.getModuleStates();
    for (const m of MODULE_IDS) expect(states[m]).toEqual(expectedStates[m]);
    expect(states.pzmr.lSaved).toBe(4);
    expect(states.numseries.sessionEndLevels).toEqual([1, 2]);

    const nonDiagnostic = items.filter((i) => i.blockId !== 'b3');
    expect(await repo.getRatings()).toEqual(deriveRatings(nonDiagnostic));
    expect((await repo.getRatings()).has('geom')).toBe(false);
    expect((await repo.getRatings()).has('powers')).toBe(false);
    expect((await repo.getRatings()).get('fib')?.n).toBe(2);
    expect((await repo.getRatings()).get('arith')?.rating).toBeLessThan(1000);
  });
});

describe('numseries time limit', () => {
  it('engine copy equals the module constant', () => {
    expect(NUMSERIES_ITEM_LIMIT_MS).toBe(ITEM_TIME_LIMIT_MS);
  });
});
