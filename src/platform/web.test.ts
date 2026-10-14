import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlatform } from '.';
import { createWebPlatform } from './web';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('getPlatform', () => {
  it('is the web platform without __TAURI_INTERNALS__', () => {
    expect(getPlatform().kind).toBe('web');
  });

  it('is the Tauri platform when the Tauri bridge is present', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    expect(getPlatform().kind).toBe('tauri');
  });
});

describe('web platform', () => {
  it('reports the package version injected by Vite', async () => {
    expect(await createWebPlatform().appVersion()).toBe(__APP_VERSION__);
    expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('opens an empty repository on every call', async () => {
    const platform = createWebPlatform();
    const a = await platform.openRepository();
    await a.saveSettings({ layout: 'pult' });
    const b = await platform.openRepository();
    expect((await b.getSettings()).layout).toBe('keyboard');
  });

  it('keeps fullscreen a no-op', async () => {
    await expect(createWebPlatform().setFullscreen(true)).resolves.toBeUndefined();
  });

  it('has no startup backup', async () => {
    expect(await createWebPlatform().backupStatus()).toBeNull();
  });

  it('backupNow resolves null: there is no database file to copy', async () => {
    expect(await createWebPlatform().backupNow()).toBeNull();
  });

  it('downloads an export through a Blob and returns the file name, bytes intact (BOM)', async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:test';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const clicked: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });

    const name = await createWebPlatform().exportFile('blocks-2026-10-14.csv', '\uFEFFпривет');

    expect(name).toBe('blocks-2026-10-14.csv');
    expect(clicked).toEqual([{ download: 'blocks-2026-10-14.csv', href: 'blob:test' }]);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    const blob = blobs[0];
    if (blob === undefined) throw new Error('no blob was created');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('reads charging state from navigator.getBattery', async () => {
    vi.stubGlobal('navigator', { getBattery: () => Promise.resolve({ charging: true }) });
    expect(await createWebPlatform().powerCharging()).toBe(true);
    vi.stubGlobal('navigator', { getBattery: () => Promise.resolve({ charging: false }) });
    expect(await createWebPlatform().powerCharging()).toBe(false);
  });

  it('answers null when the Battery API is missing or fails', async () => {
    vi.stubGlobal('navigator', {});
    expect(await createWebPlatform().powerCharging()).toBeNull();
    vi.stubGlobal('navigator', { getBattery: () => Promise.reject(new Error('denied')) });
    expect(await createWebPlatform().powerCharging()).toBeNull();
  });
});
