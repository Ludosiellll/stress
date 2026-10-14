import { beforeAll, describe, expect, it, vi } from 'vitest';
import { deriveModuleStates, deriveRatings, isCountedSession } from '../engine/derive';
import { recordHistory } from '../testing/history';
import { applyMigrations, openSqlJs, sqlJsExecutor } from '../testing/sqlJsExecutor';
import { parseExportBundle, type ExportBundle } from './bundleSchema';
import { exportBundle, rebuildCaches } from './export';
import { IMPORT_CHUNK, importBundle, previewImport, YIELD_EVERY_BLOCKS, type ImportReport } from './importBundle';
import { MemoryRepository } from './memoryRepository';
import type { Repository } from './repository';
import { block, item, session, trial } from './repository.contract';
import type { DiagnosticRow, WellbeingRow } from './rows';
import { SqliteRepository } from './sqliteRepository';

const T1 = '2026-10-01T08:00:00.000Z';
const noPause = (): Promise<void> => Promise.resolve();

async function sqliteRepo(): Promise<Repository> {
  const db = await openSqlJs();
  applyMigrations(db);
  return new SqliteRepository(sqlJsExecutor(db));
}

const TARGETS: [string, () => Promise<Repository>][] = [
  ['MemoryRepository', () => Promise.resolve(new MemoryRepository())],
  ['SqliteRepository (sql.js, all migrations)', sqliteRepo],
];

function parse(text: string): ExportBundle {
  const r = parseExportBundle(text);
  if (!r.ok) throw new Error(r.error);
  return r.bundle;
}

function bundleOf(p: Partial<ExportBundle>): ExportBundle {
  return {
    appVersion: '0.2.0',
    exportedAt: T1,
    sessions: [],
    blocks: [],
    trials: [],
    logicItems: [],
    diagnostics: [],
    wellbeing: [],
    settings: {},
    settingsSkipped: [],
    ...p,
  };
}

async function history(repo: Repository) {
  return {
    sessions: await repo.listSessions(),
    blocks: await repo.listBlocks(),
    trials: await repo.listAllTrials(),
    logicItems: await repo.listLogicItems(),
    diagnostics: await repo.listDiagnostics(),
    wellbeing: await repo.listWellbeing(),
  };
}

type Writer = 'addBlock' | 'addSessions' | 'addDiagnostics' | 'addWellbeingRows' | 'saveSettings' | 'saveRatings';

/** `repo` whose `method` goes through `around` (its arguments and the original call); every other call is untouched. */
function wrap(repo: Repository, method: Writer, around: (args: unknown[], original: () => Promise<void>) => Promise<void>): Repository {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== method || typeof value !== 'function') return value;
      return (...args: unknown[]) => around(args, () => (value as (...a: unknown[]) => Promise<void>).apply(target, args));
    },
  });
}

/** `repo` whose `method` rejects with `reason` on its `n`-th call (1-based) and writes nothing then. */
function failOnCall(repo: Repository, method: Writer, n: number, reason: string): Repository {
  let calls = 0;
  return wrap(repo, method, (_args, original) => (++calls === n ? Promise.reject(new Error(reason)) : original()));
}

/** The ids of `rows`, sorted. */
const ids = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id).sort();

const diagnostic = (id: string, sessionId: string, number: number): DiagnosticRow => ({ id, sessionId, number, at: T1, resultsJson: '{}' });
const wellbeing = (id: string, date = '2026-10-01'): WellbeingRow => ({ id, date, sleepH: 7, caffeine: false, mood: 3 });

const counts = (imported: number, skipped: number) => ({ imported, skipped });

let source: Repository;
let file: ExportBundle;

beforeAll(async () => {
  source = await recordHistory();
  file = parse(await exportBundle(source, '0.2.0'));
  // The caches a restore must reproduce: rebuilt from the source history.
  await rebuildCaches(source);
});

describe.each(TARGETS)('importBundle into %s', (_name, make) => {
  it('round trip into an empty repository gives identical history and caches', async () => {
    // The caches to compare are not the defaults: levels, block counts and number-series ratings.
    expect(Object.values(await source.getModuleStates()).filter((s) => s.lifetimeBlocks > 0).length).toBeGreaterThan(3);
    expect((await source.getRatings()).size).toBeGreaterThan(0);
    const target = await make();
    const report = await importBundle(target, file, { pause: noPause });
    expect(await history(target)).toEqual(await history(source));
    expect(await target.getModuleStates()).toEqual(await source.getModuleStates());
    expect(await target.getRatings()).toEqual(await source.getRatings());
    expect(report).toEqual<ImportReport>({
      sessions: counts(file.sessions.length, 0),
      blocks: { ...counts(file.blocks.length, 0), failed: 0 },
      diagnostics: counts(file.diagnostics.length, 0),
      wellbeing: counts(file.wellbeing.length, 0),
      settingsFilled: [],
      settingsSkipped: [],
      error: null,
    });
  });

  it('re-import is a no-op', async () => {
    const target = await make();
    await importBundle(target, file, { pause: noPause });
    const before = await history(target);
    // A stale cache shows whether anything is rebuilt: nothing is added, so nothing should be.
    const states = await target.getModuleStates();
    await target.saveModuleState({ ...states.pzmr, lSaved: 77 });
    const report = await importBundle(target, file, { pause: noPause });
    expect(report).toEqual<ImportReport>({
      sessions: counts(0, file.sessions.length),
      blocks: { ...counts(0, file.blocks.length), failed: 0 },
      diagnostics: counts(0, file.diagnostics.length),
      wellbeing: counts(0, file.wellbeing.length),
      settingsFilled: [],
      settingsSkipped: [],
      error: null,
    });
    expect(await history(target)).toEqual(before);
    expect((await target.getModuleStates()).pzmr.lSaved).toBe(77);
  });

  it('merge into a non-empty repository', async () => {
    const target = await make();
    // Local history of its own, plus the file's first session with its first block (as if restored before).
    const own = session('local-s', '2026-09-30T08:00:00.000Z');
    const ownBlock = block('local-b', 'local-s', '2026-09-30T08:01:00.000Z');
    await target.createSession(own);
    await target.addBlock(ownBlock, [trial('local-t', 'local-b', 0)], []);
    const shared = file.sessions[0];
    const sharedBlock = file.blocks.find((b) => b.sessionId === shared?.id);
    if (shared === undefined || sharedBlock === undefined) throw new Error('the history has a session with a block');
    await target.createSession(shared);
    await target.addBlock(
      sharedBlock,
      file.trials.filter((t) => t.blockId === sharedBlock.id),
      file.logicItems.filter((i) => i.blockId === sharedBlock.id),
    );

    const report = await importBundle(target, file, { pause: noPause });
    expect(report).toEqual<ImportReport>({
      sessions: counts(file.sessions.length - 1, 1),
      blocks: { ...counts(file.blocks.length - 1, 1), failed: 0 },
      diagnostics: counts(file.diagnostics.length, 0),
      wellbeing: counts(file.wellbeing.length, 0),
      settingsFilled: [],
      settingsSkipped: [],
      error: null,
    });
    const merged = await history(target);
    // The union, each row once.
    expect(ids(merged.sessions)).toEqual(ids([own, ...file.sessions]));
    expect(ids(merged.blocks)).toEqual(ids([ownBlock, ...file.blocks]));
    expect(ids(merged.trials)).toEqual(ids([{ id: 'local-t' }, ...file.trials]));
    expect(ids(merged.logicItems)).toEqual(ids(file.logicItems));
    expect(merged.diagnostics).toEqual(file.diagnostics);
    expect(merged.wellbeing).toEqual(file.wellbeing);
    // The file's rows arrive unchanged, the local ones stay as they were.
    expect(merged.sessions.filter((s) => s.id !== own.id)).toEqual(file.sessions);
    expect(merged.blocks.find((b) => b.id === ownBlock.id)).toEqual(ownBlock);
    expect(await target.getModuleStates()).toEqual(deriveModuleStates(merged.sessions, merged.blocks));
  });

  it('a failure in block N keeps blocks before N whole and nothing of block N', async () => {
    const target = await make();
    const report = await importBundle(failOnCall(target, 'addBlock', 3, 'disk I/O error'), file, { pause: noPause });
    const n = file.blocks.length;
    expect(report).toEqual<ImportReport>({
      sessions: counts(file.sessions.length, 0),
      blocks: { ...counts(2, 0), failed: 1 },
      diagnostics: counts(0, 0),
      wellbeing: counts(0, 0),
      settingsFilled: [],
      settingsSkipped: [],
      error: `Блок 3 из ${String(n)} не записан: disk I/O error. Записанное раньше сохранено; запусти восстановление ещё раз — добавленное пропустится.`,
    });
    const written = await history(target);
    const [b1, b2, b3] = file.blocks;
    expect(written.blocks).toEqual([b1, b2]);
    const ofBlocks = <T extends { blockId: string }>(rows: readonly T[], keep: readonly (string | undefined)[]): T[] =>
      rows.filter((r) => keep.includes(r.blockId));
    expect(written.trials).toEqual(ofBlocks(file.trials, [b1?.id, b2?.id]));
    expect(written.logicItems).toEqual(ofBlocks(file.logicItems, [b1?.id, b2?.id]));
    expect(ofBlocks(file.trials, [b3?.id]).length + ofBlocks(file.logicItems, [b3?.id]).length).toBeGreaterThan(0);
    expect(written.diagnostics).toEqual([]);
    expect(written.wellbeing).toEqual([]);
    // Caches are rebuilt from what was written.
    const states = await target.getModuleStates();
    expect(states).toEqual(deriveModuleStates(written.sessions, written.blocks));
    expect(Object.values(states).reduce((sum, s) => sum + s.lifetimeBlocks, 0)).toBe(2);
    const counted = new Set(written.sessions.filter((s) => isCountedSession(s.kind)).map((s) => s.id));
    const countedBlocks = new Set(written.blocks.filter((b) => counted.has(b.sessionId)).map((b) => b.id));
    expect(await target.getRatings()).toEqual(deriveRatings(written.logicItems.filter((i) => countedBlocks.has(i.blockId))));

    // A second run goes on from there.
    const again = await importBundle(target, file, { pause: noPause });
    expect(again.blocks).toEqual({ ...counts(n - 2, 2), failed: 0 });
    expect(again.error).toBeNull();
    expect(await history(target)).toEqual(await history(source));
  });

  it('settings: fills testDate and layout only when never saved locally', async () => {
    const withSettings = bundleOf({ settings: { testDate: '2026-12-01', layout: 'pult' } });
    const fresh = await make();
    expect((await importBundle(fresh, withSettings, { pause: noPause })).settingsFilled).toEqual(['testDate', 'layout']);
    expect(await fresh.getSettings()).toMatchObject({ testDate: '2026-12-01', layout: 'pult' });

    const ownLayout = await make();
    await ownLayout.saveSettings({ layout: 'mouse', stressVolume: 30 });
    expect((await importBundle(ownLayout, withSettings, { pause: noPause })).settingsFilled).toEqual(['testDate']);
    expect(await ownLayout.getSettings()).toEqual({ layout: 'mouse', testDate: '2026-12-01', lastSelfCheckJson: null, stressVolume: 30 });

    // A date cleared on this computer counts as saved.
    const cleared = await make();
    await cleared.saveSettings({ testDate: null });
    expect((await importBundle(cleared, withSettings, { pause: noPause })).settingsFilled).toEqual(['layout']);
    expect((await cleared.getSettings()).testDate).toBeNull();

    // The file's defaults change nothing and are not reported.
    const defaults = await make();
    const report = await importBundle(defaults, bundleOf({ settings: { testDate: null, layout: 'keyboard' } }), { pause: noPause });
    expect(report.settingsFilled).toEqual([]);
    expect(await defaults.storedSettingKeys()).toEqual(new Set());
  });

  it('previewImport counts new and present rows and the date range', async () => {
    const target = await make();
    const empty = await previewImport(target, bundleOf({}));
    expect(empty).toEqual({
      sessions: { total: 0, fresh: 0 },
      blocks: { total: 0, fresh: 0 },
      diagnostics: { total: 0, fresh: 0 },
      wellbeing: { total: 0, fresh: 0 },
      trials: 0,
      logicItems: 0,
      firstDate: null,
      lastDate: null,
    });

    await target.addSessions([session('s1', '2026-10-01T21:00:00.000Z')]);
    await target.addBlock(block('b1', 's1', '2026-10-01T21:01:00.000Z'), [], []);
    await target.addWellbeingRows([wellbeing('w1')]);
    const b = bundleOf({
      // Compared as times, not as text: 01:00 at +05:00 is 20:00 UTC of the day before.
      sessions: [session('s1', '2026-10-01T21:00:00.000Z'), session('s2', '2026-10-02T01:00:00+05:00'), session('s3', '2026-10-05T09:00:00.000Z', { kind: 'diagnostic' })],
      blocks: [block('b1', 's1', '2026-10-01T21:01:00.000Z'), block('b2', 's2', T1), block('b3', 's2', T1)],
      trials: [trial('t1', 'b1', 0), trial('t2', 'b2', 0), trial('t3', 'b2', 1)],
      logicItems: [item('i1', 'b3', T1)],
      diagnostics: [diagnostic('d1', 's3', 1)],
      wellbeing: [wellbeing('w1'), wellbeing('w2', '2026-10-02')],
    });
    expect(await previewImport(target, b)).toEqual({
      sessions: { total: 3, fresh: 2 },
      blocks: { total: 3, fresh: 2 },
      diagnostics: { total: 1, fresh: 1 },
      wellbeing: { total: 2, fresh: 1 },
      trials: 3,
      logicItems: 1,
      firstDate: '2026-10-02T01:00:00+05:00',
      lastDate: '2026-10-05T09:00:00.000Z',
    });
    // A preview writes nothing.
    expect(ids(await target.listSessions())).toEqual(['s1']);
  });

  it('reports progress and yields every 20 blocks', async () => {
    expect(YIELD_EVERY_BLOCKS).toBe(20);
    const target = await make();
    const blocks = Array.from({ length: 45 }, (_, k) => block(`b${String(k)}`, 's1', `2026-10-01T08:${String(k).padStart(2, '0')}:00.000Z`));
    const b = bundleOf({ sessions: [session('s1', T1)], blocks, trials: blocks.map((x) => trial(`t-${x.id}`, x.id, 0)) });
    const events: string[] = [];
    const pause = vi.fn(() => {
      events.push('pause');
      return Promise.resolve();
    });
    const report = await importBundle(target, b, { pause, onProgress: (done, total) => events.push(`${String(done)}/${String(total)}`) });
    expect(report.blocks).toEqual({ ...counts(45, 0), failed: 0 });
    expect(pause).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['0/45', '20/45', 'pause', '40/45', 'pause', '45/45']);
    expect(await target.listAllTrials()).toHaveLength(45);
  });

  it('writes sessions, diagnostics and wellbeing in batches of 200', async () => {
    expect(IMPORT_CHUNK).toBe(200);
    const target = await make();
    const sessions = Array.from({ length: 450 }, (_, k) => session(`s${String(k)}`, T1));
    const b = bundleOf({
      sessions,
      diagnostics: Array.from({ length: 201 }, (_, k) => diagnostic(`d${String(k)}`, 's0', k + 1)),
      wellbeing: Array.from({ length: 3 }, (_, k) => wellbeing(`w${String(k)}`)),
    });
    const batches: string[] = [];
    const log = (label: string) => (args: unknown[], original: () => Promise<void>): Promise<void> => {
      batches.push(`${label} ${String((args[0] as unknown[]).length)}`);
      return original();
    };
    const spied = wrap(wrap(wrap(target, 'addSessions', log('sessions')), 'addDiagnostics', log('diagnostics')), 'addWellbeingRows', log('wellbeing'));
    const report = await importBundle(spied, b, { pause: noPause });
    expect(batches).toEqual(['sessions 200', 'sessions 200', 'sessions 50', 'diagnostics 200', 'diagnostics 1', 'wellbeing 3']);
    expect(report.error).toBeNull();
    expect(await target.listSessions()).toHaveLength(450);
    expect(await target.listDiagnostics()).toHaveLength(201);
  });

  it.each([
    ['addSessions', 'Не удалось записать сессии: disk full.'],
    ['addDiagnostics', 'Не удалось записать контрольные диагностики: disk full.'],
    ['addWellbeingRows', 'Не удалось сохранить записи самочувствия: disk full.'],
  ] as const)('a failed %s batch stops the restore with its reason; earlier batches stay', async (method, message) => {
    const target = await make();
    const sessions = Array.from({ length: 250 }, (_, k) => session(`s${String(k)}`, T1));
    const b = bundleOf({
      sessions,
      blocks: [block('b1', 's0', T1)],
      diagnostics: [diagnostic('d1', 's0', 1)],
      wellbeing: [wellbeing('w1')],
    });
    // Sessions fail on their second batch (the first stays), the others on their only one.
    const failing = failOnCall(target, method, method === 'addSessions' ? 2 : 1, 'disk full.');
    const report = await importBundle(failing, b, { pause: noPause });
    expect(report.error).toBe(message);
    if (method === 'addSessions') {
      expect(report.sessions).toEqual(counts(200, 0));
      expect(report.blocks).toEqual({ ...counts(0, 0), failed: 0 });
      expect(await target.listSessions()).toHaveLength(200);
      expect(await target.listBlocks()).toEqual([]);
    } else if (method === 'addDiagnostics') {
      expect(report.blocks).toEqual({ ...counts(1, 0), failed: 0 });
      expect(report.diagnostics).toEqual(counts(0, 0));
      expect(await target.listWellbeing()).toEqual([]);
      // The block that was written is in the caches.
      expect((await target.getModuleStates()).pzmr.lifetimeBlocks).toBe(1);
    } else {
      expect(report.diagnostics).toEqual(counts(1, 0));
      expect(report.wellbeing).toEqual(counts(0, 0));
    }
  });
});

describe('importBundle', () => {
  it('a bundle with a broken row writes nothing', async () => {
    const target = await sqliteRepo();
    await target.createSession(session('local', T1));
    const before = await history(target);
    const broken = JSON.parse(await exportBundle(source, '0.2.0')) as ExportBundle;
    // The last trial names a block that is not in the file: the whole file is refused before any write.
    broken.trials.push(trial('stray', 'not-in-file', 0));
    const parsed = parseExportBundle(JSON.stringify(broken));
    expect(parsed).toEqual({ ok: false, error: `Запись trials[${String(broken.trials.length - 1)}]: блок not-in-file не найден в файле.` });
    if (parsed.ok) await importBundle(target, parsed.bundle, { pause: noPause });
    expect(await history(target)).toEqual(before);
  });

  it('SQLite: a block whose last row fails inside the transaction leaves none of its rows', async () => {
    const target = await sqliteRepo();
    // A local trial already holds the id of block 3's last trial: block 3's INSERTs fail on that row.
    const third = file.blocks[2];
    const lastTrial = file.trials.filter((t) => t.blockId === third?.id).at(-1);
    if (third === undefined || lastTrial === undefined) throw new Error('block 3 has trials');
    await target.createSession(session('local', '2026-09-30T08:00:00.000Z'));
    await target.addBlock(block('local-b', 'local', '2026-09-30T08:01:00.000Z'), [{ ...lastTrial, blockId: 'local-b' }], []);

    const report = await importBundle(target, file, { pause: noPause });
    expect(report.blocks).toEqual({ ...counts(2, 0), failed: 1 });
    expect(report.error).toMatch(/^Блок 3 из \d+ не записан: .*UNIQUE.*\. Записанное раньше сохранено/);
    expect(await target.listIds('blocks')).toEqual(new Set(['local-b', file.blocks[0]?.id, file.blocks[1]?.id]));
    expect(await target.listTrials(third.id)).toEqual([]);
    expect((await target.listLogicItems()).filter((i) => i.blockId === third.id)).toEqual([]);
  });

  it('a Tauri rejection (a plain string) is the reason; an empty one reads as unknown', async () => {
    const tauri = vi.fn<() => Promise<void>>().mockRejectedValue('statement 2: UNIQUE constraint failed: trials.id');
    const b = bundleOf({ sessions: [session('s1', T1)], blocks: [block('b1', 's1', T1)] });
    const report = await importBundle(wrap(new MemoryRepository(), 'addBlock', tauri), b, { pause: noPause });
    expect(report.error).toBe(
      'Блок 1 из 1 не записан: statement 2: UNIQUE constraint failed: trials.id. Записанное раньше сохранено; запусти восстановление ещё раз — добавленное пропустится.',
    );
    const silent = vi.fn<() => Promise<void>>().mockRejectedValue(new Error(' '));
    expect((await importBundle(wrap(new MemoryRepository(), 'addSessions', silent), b, { pause: noPause })).error).toBe(
      'Не удалось записать сессии: причина неизвестна.',
    );
  });

  it('a failed settings write is reported; the history stays and the caches are rebuilt', async () => {
    const target = new MemoryRepository();
    const b = bundleOf({ sessions: [session('s1', T1)], blocks: [block('b1', 's1', T1)], settings: { layout: 'pult' } });
    const report = await importBundle(failOnCall(target, 'saveSettings', 1, 'database is locked'), b, { pause: noPause });
    expect(report).toMatchObject({ settingsFilled: [], error: 'Не удалось записать настройки: database is locked.' });
    expect(report.blocks).toEqual({ ...counts(1, 0), failed: 0 });
    expect(await target.storedSettingKeys()).toEqual(new Set());
    expect((await target.getModuleStates()).pzmr.lifetimeBlocks).toBe(1);
  });

  it('W2-R32: settings the file could not give are reported, and the rest is restored', async () => {
    const parsedFile = parseExportBundle(
      JSON.stringify({ ...JSON.parse(await exportBundle(source, '0.2.0')), settings: { testDate: '14.12.2026', layout: 'pult' } }),
    );
    if (!parsedFile.ok) throw new Error(parsedFile.error);
    const target = new MemoryRepository();
    const report = await importBundle(target, parsedFile.bundle, { pause: noPause });
    expect(report).toMatchObject({ settingsFilled: ['layout'], settingsSkipped: ['testDate'], error: null });
    expect(report.sessions).toEqual(counts(file.sessions.length, 0));
    expect((await target.getSettings()).testDate).toBeNull();
  });

  it('W2-R32: a failed cache rebuild is folded into the report; counts and earlier errors are kept', async () => {
    const b = bundleOf({ sessions: [session('s1', T1)], blocks: [block('b1', 's1', T1)] });
    const target = new MemoryRepository();
    const report = await importBundle(failOnCall(target, 'saveRatings', 1, 'disk I/O error.'), b, { pause: noPause });
    expect(report.error).toBe(
      'Уровни и рейтинги не пересчитаны: disk I/O error. Записанное сохранено, они пересчитаются при следующем запуске.',
    );
    expect(report.sessions).toEqual(counts(1, 0));
    expect(report.blocks).toEqual({ ...counts(1, 0), failed: 0 });
    expect(await target.listIds('blocks')).toEqual(new Set(['b1']));

    // A stop and a failed rebuild: both are told, the stop first.
    const stopped = failOnCall(failOnCall(new MemoryRepository(), 'saveRatings', 1, 'disk I/O error'), 'addDiagnostics', 1, 'locked');
    const both = await importBundle(stopped, { ...b, diagnostics: [diagnostic('d1', 's1', 1)] }, { pause: noPause });
    expect(both.error).toBe(
      'Не удалось записать контрольные диагностики: locked. ' +
        'Уровни и рейтинги не пересчитаны: disk I/O error. Записанное сохранено, они пересчитаются при следующем запуске.',
    );
    expect(both.blocks).toEqual({ ...counts(1, 0), failed: 0 });
  });

  it('W2-R32: a throwing callback still rejects with its own error when the rebuild fails too', async () => {
    const target = failOnCall(new MemoryRepository(), 'saveRatings', 1, 'disk I/O error');
    const onProgress = (): void => {
      throw new Error('view unmounted');
    };
    const b = bundleOf({ sessions: [session('s1', T1)], blocks: [block('b1', 's1', T1)] });
    await expect(importBundle(target, b, { pause: noPause, onProgress })).rejects.toThrow('view unmounted');
  });

  it('blocks go to addBlock in file order, each with its own trials by idx and its own items', async () => {
    const b = bundleOf({
      sessions: [session('s1', T1)],
      blocks: [block('b2', 's1', '2026-10-01T09:00:00.000Z'), block('b1', 's1', T1)],
      trials: [trial('t3', 'b1', 2), trial('u0', 'b2', 0), trial('t1', 'b1', 0), trial('t2', 'b1', 1)],
      logicItems: [item('i1', 'b2', T1), item('i2', 'b2', T1)],
    });
    const calls: string[] = [];
    const spied = wrap(new MemoryRepository(), 'addBlock', (args, original) => {
      const [blk, trials, items] = args as [{ id: string }, { id: string }[], { id: string }[]];
      calls.push(`${blk.id}: ${trials.map((t) => t.id).join(' ')} | ${items.map((i) => i.id).join(' ')}`);
      return original();
    });
    await importBundle(spied, b, { pause: noPause });
    expect(calls).toEqual(['b2: u0 | i1 i2', 'b1: t1 t2 t3 | ']);
  });

  it('a throwing progress callback stops the restore, and the caches still cover the blocks written', async () => {
    const target = new MemoryRepository();
    const blocks = Array.from({ length: 30 }, (_, k) => block(`b${String(k)}`, 's1', T1));
    const onProgress = (done: number): void => {
      if (done === 20) throw new Error('view unmounted');
    };
    await expect(importBundle(target, bundleOf({ sessions: [session('s1', T1)], blocks }), { pause: noPause, onProgress })).rejects.toThrow(
      'view unmounted',
    );
    expect(await target.listBlocks()).toHaveLength(20);
    expect((await target.getModuleStates()).pzmr.lifetimeBlocks).toBe(20);
  });

  it('the default pause yields to the event loop', async () => {
    const target = new MemoryRepository();
    const blocks = Array.from({ length: YIELD_EVERY_BLOCKS }, (_, k) => block(`b${String(k)}`, 's1', T1));
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 0);
    await importBundle(target, bundleOf({ sessions: [session('s1', T1)], blocks }));
    expect(timerRan).toBe(true);
  });

  it('without fresh blocks progress is 0 of 0 and nothing pauses', async () => {
    const pause = vi.fn(noPause);
    const progress: [number, number][] = [];
    await importBundle(new MemoryRepository(), bundleOf({}), { pause, onProgress: (d, t) => progress.push([d, t]) });
    expect(progress).toEqual([[0, 0]]);
    expect(pause).not.toHaveBeenCalled();
  });
});
