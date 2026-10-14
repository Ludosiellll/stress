import { describe, expect, it, vi } from 'vitest';
import type { ExportBundle } from '../data/bundleSchema';
import type { ImportPreview, ImportReport } from '../data/importBundle';
import { MemoryRepository } from '../data/memoryRepository';
import type { Repository } from '../data/repository';
import { block, session, trial } from '../data/repository.contract';
import { createFakePlatform } from '../testing/fakePlatform';
import { previewText, progressText, reportLines, RestoreBackupError, runRestore } from './restore';

const T1 = '2026-10-01T08:00:00.000Z';
const T2 = '2026-10-02T08:00:00.000Z';

/** The brief's texts write «1 234»; the screen keeps the groups together with a no-break space. */
const nb = (text: string): string => text.replace(/(\d) (\d)/g, '$1\u00a0$2');

function bundleOf(p: Partial<ExportBundle>): ExportBundle {
  return {
    appVersion: '0.2.0',
    exportedAt: T2,
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

const FILE = bundleOf({
  sessions: [session('s1', T1), session('s2', T2)],
  blocks: [block('b1', 's1', T1), block('b2', 's2', T2)],
  trials: [trial('t1', 'b1', 0), trial('t2', 'b2', 0)],
});

async function historyOf(repo: Repository) {
  return {
    sessions: await repo.listSessions(),
    blocks: await repo.listBlocks(),
    trials: await repo.listAllTrials(),
    log: await repo.listLog(50),
    settings: await repo.getSettings(),
    states: await repo.getModuleStates(),
  };
}

/** `repo` that notes every write method called, in order, in `calls`. */
function recording(repo: Repository, calls: string[]): Repository {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== 'string' || typeof value !== 'function' || !/^(add|save|create|append|finish)/.test(prop)) {
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
      return (...args: unknown[]) => {
        calls.push(prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describe('runRestore', () => {
  it('a failed backup stops the restore before any write', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('local', '2026-09-30T08:00:00.000Z'));
    const before = await historyOf(repo);
    const calls: string[] = [];
    const platform = createFakePlatform({ repo });
    platform.backupNow = () => Promise.reject(new Error('Отказано в доступе. (os error 5).'));
    const onProgress = vi.fn();

    const failed = runRestore({ repo: recording(repo, calls), platform, bundle: FILE, onProgress });
    await expect(failed).rejects.toBeInstanceOf(RestoreBackupError);
    await expect(failed).rejects.toThrow('Не удалось сделать резервную копию: Отказано в доступе. (os error 5). Восстановление не начато.');
    // Nothing at all is written, not even a log row.
    expect(calls).toEqual([]);
    expect(onProgress).not.toHaveBeenCalled();
    expect(await historyOf(repo)).toEqual(before);
  });

  it('a backup rejected with a plain string (the Tauri bridge) or with nothing still stops it', async () => {
    const repo = new MemoryRepository();
    const platform = createFakePlatform({ repo });
    // The Tauri bridge rejects with the command's Err string itself.
    platform.backupNow = vi.fn<() => Promise<string | null>>().mockRejectedValue('нет файла базы данных C:\\app\\trainer.db');
    await expect(runRestore({ repo, platform, bundle: FILE, onProgress: vi.fn() })).rejects.toThrow(
      'Не удалось сделать резервную копию: нет файла базы данных C:\\app\\trainer.db. Восстановление не начато.',
    );
    platform.backupNow = () => Promise.reject(new Error(''));
    await expect(runRestore({ repo, platform, bundle: FILE, onProgress: vi.fn() })).rejects.toThrow(
      'Не удалось сделать резервную копию: причина неизвестна. Восстановление не начато.',
    );
    expect(await repo.listIds('sessions')).toEqual(new Set());
  });

  it('backs up, imports and logs the counts', async () => {
    const repo = new MemoryRepository();
    const calls: string[] = [];
    const platform = createFakePlatform({ repo });
    const backupNow = vi.fn(() => {
      calls.push('backupNow');
      return Promise.resolve('C:\\app\\backups\\trainer-1790000001.db');
    });
    platform.backupNow = backupNow;
    const progress: [number, number][] = [];

    const result = await runRestore({ repo: recording(repo, calls), platform, bundle: FILE, onProgress: (d, t) => progress.push([d, t]) });

    expect(calls[0]).toBe('backupNow');
    expect(calls).toContain('addBlock');
    expect(backupNow).toHaveBeenCalledTimes(1);
    expect(result.backupPath).toBe('C:\\app\\backups\\trainer-1790000001.db');
    expect(result.report).toMatchObject({ sessions: { imported: 2, skipped: 0 }, blocks: { imported: 2, skipped: 0, failed: 0 }, error: null });
    expect(progress).toEqual([
      [0, 2],
      [2, 2],
    ]);
    expect(await repo.listIds('blocks')).toEqual(new Set(['b1', 'b2']));
    const [log] = await repo.listLog(1);
    expect(log).toMatchObject({
      level: 'info',
      message:
        'Восстановление из файла: добавлено сессий 2, блоков 2, диагностик 0, записей самочувствия 0; ' +
        'пропущено сессий 0, блоков 0, диагностик 0, записей самочувствия 0. Резервная копия: C:\\app\\backups\\trainer-1790000001.db',
    });
  });

  it('web: no copy (null), the restore goes on', async () => {
    const repo = new MemoryRepository();
    const result = await runRestore({ repo, platform: createFakePlatform({ repo }), bundle: FILE, onProgress: vi.fn() });
    expect(result.backupPath).toBeNull();
    expect((await repo.listLog(1))[0]?.message).toMatch(/Резервная копия: не делалась \(нет файла базы\)$/);
  });

  it('a stopped restore logs an error with the reason', async () => {
    const repo = new MemoryRepository();
    // A local block already holds trial t1: the file's block 1 (b1, with t1) cannot be written.
    await repo.createSession(session('local', T1));
    await repo.addBlock(block('local-b', 'local', T1), [trial('t1', 'local-b', 0)], []);
    const { report } = await runRestore({ repo, platform: createFakePlatform({ repo }), bundle: FILE, onProgress: vi.fn() });
    expect(report.error).toMatch(/^Блок 1 из 2 не записан/);
    const [log] = await repo.listLog(1);
    expect(log?.level).toBe('error');
    expect(log?.message).toContain('Остановлено: Блок 1 из 2 не записан');
  });

  it('a rejected import is logged and passed on', async () => {
    const repo = new MemoryRepository();
    const onProgress = (): void => {
      throw new Error('view gone');
    };
    await expect(runRestore({ repo, platform: createFakePlatform({ repo }), bundle: FILE, onProgress })).rejects.toThrow('view gone');
    expect((await repo.listLog(1))[0]).toMatchObject({ level: 'error', message: 'Восстановление из файла прервано: view gone' });
  });
});

function previewOf(p: Partial<ImportPreview>): ImportPreview {
  return {
    sessions: { total: 42, fresh: 40 },
    blocks: { total: 1234, fresh: 1200 },
    diagnostics: { total: 3, fresh: 3 },
    wellbeing: { total: 15, fresh: 15 },
    trials: 30_000,
    logicItems: 400,
    firstDate: '2026-10-01T08:00:00.000Z',
    lastDate: '2026-11-14T08:00:00.000Z',
    ...p,
  };
}

function reportOf(p: Partial<ImportReport>): ImportReport {
  return {
    sessions: { imported: 40, skipped: 2 },
    blocks: { imported: 1200, skipped: 34, failed: 0 },
    diagnostics: { imported: 3, skipped: 0 },
    wellbeing: { imported: 15, skipped: 0 },
    settingsFilled: [],
    settingsSkipped: [],
    error: null,
    ...p,
  };
}

describe('restore texts', () => {
  it('preview: sessions with their dates, new and stored rows', () => {
    expect(previewText(previewOf({}))).toBe(
      nb('В файле: 42 сессии с 01.10.2026 по 14.11.2026. Новых: 40, уже есть: 2. Блоков: 1 234, новых 1 200. Контрольных диагностик: 3, новых 3.'),
    );
    expect(previewText(previewOf({ sessions: { total: 1, fresh: 1 }, lastDate: '2026-10-01T09:00:00.000Z' }))).toMatch(
      /^В файле: 1 сессия за 01\.10\.2026\. Новых: 1, уже есть: 0\./,
    );
    expect(
      previewText(previewOf({ sessions: { total: 0, fresh: 0 }, blocks: { total: 0, fresh: 0 }, diagnostics: { total: 0, fresh: 0 }, firstDate: null, lastDate: null })),
    ).toBe('В файле: 0 сессий. Новых: 0, уже есть: 0. Блоков: 0, новых 0. Контрольных диагностик: 0, новых 0.');
    expect(previewText(previewOf({ sessions: { total: 5, fresh: 5 } }))).toMatch(/^В файле: 5 сессий с /);
  });

  it('progress', () => {
    expect(progressText(120, 1200)).toBe(nb('Записано блоков: 120 из 1 200'));
  });

  it('result: added, skipped and the settings taken from the file', () => {
    expect(reportLines(reportOf({}))).toEqual({
      alert: null,
      lines: [nb('Готово. Добавлено сессий: 40, блоков: 1 200, диагностик: 3, записей самочувствия: 15. Пропущено (уже были): сессий 2, блоков 34.')],
    });
    expect(reportLines(reportOf({ settingsFilled: ['testDate', 'layout'] })).lines[0]).toMatch(/блоков 34\. Из файла взяты: дата теста, раскладка\.$/);
    expect(reportLines(reportOf({ settingsFilled: ['layout'] })).lines[0]).toMatch(/ Из файла взяты: раскладка\.$/);
    // Nothing was stored before: no «Пропущено» sentence.
    const fresh = reportOf({ sessions: { imported: 2, skipped: 0 }, blocks: { imported: 2, skipped: 0, failed: 0 } });
    expect(reportLines(fresh).lines[0]).toBe('Готово. Добавлено сессий: 2, блоков: 2, диагностик: 3, записей самочувствия: 15.');
  });

  it('result: settings the file could not give', () => {
    expect(reportLines(reportOf({ settingsSkipped: ['testDate'] })).lines[1]).toBe('Настройка «дата теста» из файла не подошла и пропущена.');
    expect(reportLines(reportOf({ settingsSkipped: ['layout'] })).lines[1]).toBe('Настройка «раскладка» из файла не подошла и пропущена.');
    expect(reportLines(reportOf({ settingsSkipped: ['testDate', 'layout'] })).lines[1]).toBe(
      'Настройки «дата теста» и «раскладка» из файла не подошли и пропущены.',
    );
  });

  it('a stop: its reason, then what was added before it', () => {
    const error = 'Блок 3 из 10 не записан: disk full. Записанное раньше сохранено; запусти восстановление ещё раз — добавленное пропустится.';
    const stopped = reportOf({ blocks: { imported: 2, skipped: 0, failed: 1 }, sessions: { imported: 4, skipped: 0 }, error });
    expect(reportLines(stopped)).toEqual({
      alert: error,
      lines: ['Добавлено сессий: 4, блоков: 2, диагностик: 3, записей самочувствия: 15.'],
    });
  });
});
