import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../data/memoryRepository';
import { LOG_LIMIT } from '../data/repository';
import { createFakePlatform } from '../testing/fakePlatform';
import { buildReport, installErrorLog } from './errorLog';

// jsdom reports an error event nobody cancelled as an uncaught exception; the tests dispatch them on purpose.
const swallow = (e: Event): void => {
  e.preventDefault();
};
beforeEach(() => {
  window.addEventListener('error', swallow);
});

let uninstall: (() => void) | undefined;
afterEach(() => {
  window.removeEventListener('error', swallow);
  uninstall?.();
  uninstall = undefined;
  vi.restoreAllMocks();
});

function rejection(reason: unknown): Event {
  return Object.assign(new Event('unhandledrejection'), { reason });
}

describe('installErrorLog', () => {
  it('writes a thrown error with its stack to the log', async () => {
    const repo = new MemoryRepository();
    uninstall = installErrorLog(repo, window);
    const error = new Error('сломалось');
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: сломалось', error }));
    await vi.waitFor(async () => {
      expect(await repo.listLog(10)).toHaveLength(1);
    });
    const [row] = await repo.listLog(10);
    expect(row?.level).toBe('error');
    expect(row?.message).toContain('сломалось');
    expect(row?.detail).toContain('Error: сломалось');
    expect(Number.isNaN(Date.parse(row?.at ?? ''))).toBe(false);
  });

  it('writes an unhandled rejection, also when the reason is not an Error', async () => {
    const repo = new MemoryRepository();
    uninstall = installErrorLog(repo, window);
    window.dispatchEvent(rejection(new Error('async беда')));
    window.dispatchEvent(rejection('просто строка'));
    await vi.waitFor(async () => {
      expect(await repo.listLog(10)).toHaveLength(2);
    });
    const messages = (await repo.listLog(10)).map((r) => r.message).join('\n');
    expect(messages).toContain('async беда');
    expect(messages).toContain('просто строка');
  });

  it('does not record the same error again within a few seconds', async () => {
    const repo = new MemoryRepository();
    uninstall = installErrorLog(repo, window);
    const error = new Error('в цикле');
    for (let i = 0; i < 5; i++) window.dispatchEvent(new ErrorEvent('error', { message: 'в цикле', error }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'другая', error: new Error('другая') }));
    await vi.waitFor(async () => {
      expect(await repo.listLog(10)).toHaveLength(2);
    });
  });

  it('stops listening after uninstall', async () => {
    const repo = new MemoryRepository();
    installErrorLog(repo, window)();
    window.dispatchEvent(new ErrorEvent('error', { message: 'после', error: new Error('после') }));
    await new Promise((r) => setTimeout(r, 10));
    expect(await repo.listLog(10)).toHaveLength(0);
  });

  it('survives a failing log write', async () => {
    const repo = new MemoryRepository();
    vi.spyOn(repo, 'appendLog').mockRejectedValue(new Error('disk'));
    const onUnhandled = vi.fn();
    window.addEventListener('unhandledrejection', onUnhandled);
    uninstall = installErrorLog(repo, window);
    window.dispatchEvent(new ErrorEvent('error', { message: 'x', error: new Error('x') }));
    await new Promise((r) => setTimeout(r, 10));
    window.removeEventListener('unhandledrejection', onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });
});

describe('buildReport', () => {
  it('has the version, the last self-check and the 200 newest log rows, newest first', async () => {
    const repo = new MemoryRepository();
    const platform = createFakePlatform({ repo, version: '1.4.0', kind: 'tauri' });
    await repo.saveSettings({ lastSelfCheckJson: JSON.stringify({ hz: 60, jitterMs: 0.4 }) });
    for (let i = 0; i < 250; i++) {
      await repo.appendLog({ id: `l${String(i)}`, at: `2026-10-14T10:00:${String(i % 60).padStart(2, '0')}.000Z`, level: 'info', message: `m${String(i)}`, detail: '' });
    }
    const report = JSON.parse(await buildReport(repo, platform)) as {
      appVersion: string;
      platform: string;
      lastSelfCheck: unknown;
      log: { message: string }[];
    };
    expect(report.appVersion).toBe('1.4.0');
    expect(report.platform).toBe('tauri');
    expect(report.lastSelfCheck).toEqual({ hz: 60, jitterMs: 0.4 });
    expect(report.log).toHaveLength(200);
    expect(report.log[0]?.message).toBe('m249');
    expect(LOG_LIMIT).toBeGreaterThanOrEqual(200);
  });

  it('has null lastSelfCheck when none was made, and never any wellbeing data', async () => {
    const repo = new MemoryRepository();
    await repo.createSession({ id: 's', startedAt: '2026-10-14T08:00:00.000Z', endedAt: null, kind: 'training', phase: 'base', appVersion: '0' });
    await repo.addWellbeing({ id: 'w', date: '2026-10-14', sleepH: 7.5, caffeine: true, mood: 4 });
    const report: unknown = JSON.parse(await buildReport(repo, createFakePlatform({ repo })));
    expect(report).toMatchObject({ lastSelfCheck: null, log: [] });
    expect(Object.keys(report as object).sort()).toEqual(['appVersion', 'generatedAt', 'lastSelfCheck', 'log', 'platform']);
    const keys = new Set<string>();
    const collect = (v: unknown): void => {
      if (typeof v !== 'object' || v === null) return;
      for (const [k, child] of Object.entries(v)) {
        keys.add(k);
        collect(child);
      }
    };
    collect(report);
    for (const key of ['sleepH', 'caffeine', 'mood', 'wellbeing', 'date']) expect(keys.has(key)).toBe(false);
  });

  it('still builds when the app version cannot be read', async () => {
    const repo = new MemoryRepository();
    const platform = createFakePlatform({ repo });
    platform.appVersion = () => Promise.reject(new Error('no version'));
    expect(JSON.parse(await buildReport(repo, platform))).toMatchObject({ appVersion: 'unknown' });
  });

  it('keeps a damaged self-check string as text instead of failing', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ lastSelfCheckJson: '{не json' });
    const report = JSON.parse(await buildReport(repo, createFakePlatform({ repo }))) as { lastSelfCheck: unknown };
    expect(report.lastSelfCheck).toBe('{не json');
  });
});
