import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const dbExecute = vi.fn();
const dbSelect = vi.fn();
const load = vi.fn();
const setFullscreen = vi.fn();
const getVersion = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) as unknown }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => getVersion() as unknown }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setFullscreen: (on: boolean) => setFullscreen(on) as unknown }),
}));
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: (path: string) => load(path) as unknown },
}));

const { backupStatus, createTauriExecutor, createTauriPlatform, DB_URL } = await import('./tauri');

beforeEach(() => {
  vi.resetAllMocks();
  load.mockResolvedValue({ execute: dbExecute, select: dbSelect });
  dbExecute.mockResolvedValue({ rowsAffected: 1 });
});

describe('tauri executor', () => {
  it('runs execute and select on the plugin database', async () => {
    dbSelect.mockResolvedValue([{ a: 1 }]);
    const ex = createTauriExecutor({ execute: dbExecute, select: dbSelect });
    await ex.execute('INSERT INTO t VALUES (?)', [1]);
    expect(dbExecute).toHaveBeenCalledWith('INSERT INTO t VALUES (?)', [1]);
    expect(await ex.select('SELECT a FROM t WHERE a = ?', [1])).toEqual([{ a: 1 }]);
    expect(dbSelect).toHaveBeenCalledWith('SELECT a FROM t WHERE a = ?', [1]);
  });

  it('sends a transaction as one db_batch with the collected statements', async () => {
    invoke.mockResolvedValue(undefined);
    const ex = createTauriExecutor({ execute: dbExecute, select: dbSelect });
    await ex.transaction(async (tx) => {
      await tx.execute('INSERT INTO a VALUES (?)', ['x']);
      await tx.execute('INSERT INTO b VALUES (?, ?)', [2, null]);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('db_batch', {
      db: 'sqlite:trainer.db',
      statements: [
        { sql: 'INSERT INTO a VALUES (?)', params: ['x'] },
        { sql: 'INSERT INTO b VALUES (?, ?)', params: [2, null] },
      ],
    });
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('rejects when db_batch fails and does not swallow select inside a transaction', async () => {
    invoke.mockRejectedValue('statement 0: boom');
    const ex = createTauriExecutor({ execute: dbExecute, select: dbSelect });
    await expect(ex.transaction((tx) => tx.execute('X'))).rejects.toBe('statement 0: boom');
    await expect(
      ex.transaction(async (tx) => {
        await tx.select('SELECT 1');
      }),
    ).rejects.toThrow('select');
  });
});

describe('tauri platform', () => {
  it('loads the database with the exact string db_batch uses', async () => {
    expect(DB_URL).toBe('sqlite:trainer.db');
    const repo = await createTauriPlatform().openRepository();
    expect(load).toHaveBeenCalledWith('sqlite:trainer.db');
    expect(typeof repo.getSettings).toBe('function');
  });

  it('reads the version, switches fullscreen, exports through export_file', async () => {
    getVersion.mockResolvedValue('1.2.3');
    setFullscreen.mockResolvedValue(undefined);
    invoke.mockResolvedValue('C:\\Users\\me\\Downloads\\x.json');
    const p = createTauriPlatform();
    expect(await p.appVersion()).toBe('1.2.3');
    await p.setFullscreen(true);
    expect(setFullscreen).toHaveBeenCalledWith(true);
    expect(await p.exportFile('x.json', '{}')).toBe('C:\\Users\\me\\Downloads\\x.json');
    expect(invoke).toHaveBeenCalledWith('export_file', { name: 'x.json', contents: '{}' });
  });

  it('backupNow invokes backup_now and returns the path', async () => {
    const copy = 'C:\\Users\\me\\AppData\\Roaming\\app\\backups\\trainer-1790000001.db';
    invoke.mockResolvedValue(copy);
    expect(await createTauriPlatform().backupNow()).toBe(copy);
    expect(invoke).toHaveBeenCalledWith('backup_now');
  });

  it('backupNow rejects with the command error; an unknown reason passes through unchanged', async () => {
    // invoke rejects with the command's Err string itself, not an Error.
    invoke.mockRejectedValue('Отказано в доступе. (os error 5)');
    const failed = createTauriPlatform().backupNow();
    await expect(failed).rejects.toBeInstanceOf(Error);
    await expect(failed).rejects.toThrow(/^Отказано в доступе\. \(os error 5\)$/);
    const bridge = new Error('IPC unavailable');
    invoke.mockRejectedValue(bridge);
    await expect(createTauriPlatform().backupNow()).rejects.toBe(bridge);
  });

  it.each([
    ['error returned from database: (code: 5) database is locked', 'база занята, попробуй ещё раз через минуту'],
    ['checkpoint: error returned from database: (code: 6) database table is locked', 'база занята, попробуй ещё раз через минуту'],
    ['database sqlite:trainer.db is not loaded', 'база не открыта — перезапусти приложение'],
    ['нет файла базы данных C:\\app\\trainer.db', 'файл базы не найден'],
    ['The system cannot find the file specified. (os error 2)', 'файл базы не найден'],
    ['No such file or directory (os error 2)', 'файл базы не найден'],
  ])('backupNow says a known reason in Russian: %s', async (raw, text) => {
    invoke.mockRejectedValue(raw);
    await expect(createTauriPlatform().backupNow()).rejects.toThrow(new RegExp(`^${text}$`));
    invoke.mockRejectedValue(new Error(raw));
    await expect(createTauriPlatform().backupNow()).rejects.toThrow(new RegExp(`^${text}$`));
  });

  it('an OS «busy» is not a busy database: it passes through unchanged (B7)', async () => {
    for (const raw of ['Device or resource busy (os error 16)', 'Resource busy: trainer.db']) {
      invoke.mockRejectedValue(raw);
      await expect(createTauriPlatform().backupNow()).rejects.toThrow(new RegExp(`^${raw.replace(/[()]/g, '\\$&')}$`));
    }
  });

  it('a reason said in Russian keeps the raw text as its cause (B7)', async () => {
    const raw = 'error returned from database: (code: 5) database is locked';
    invoke.mockRejectedValue(raw);
    const error: unknown = await createTauriPlatform().backupNow().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('база занята, попробуй ещё раз через минуту');
    expect((error as Error).cause).toBe(raw);
  });

  it('returns the startup backup status', async () => {
    const status = { ok: false, path: null, error: 'disk full', at: 5 };
    invoke.mockResolvedValue(status);
    expect(await backupStatus()).toEqual(status);
    expect(invoke).toHaveBeenCalledWith('backup_status');
    expect(await createTauriPlatform().backupStatus()).toEqual(status);
  });
});
