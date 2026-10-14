import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { exportBundle } from '../../data/export';
import { MemoryRepository } from '../../data/memoryRepository';
import type { Repository } from '../../data/repository';
import { block, session, trial } from '../../data/repository.contract';
import { settleUntil } from '../../testing/domFakes';
import { createAudioOut } from '../../runtime/audio/audioOut';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { AppContext } from '../AppContext';
import RestoreSection from './RestoreSection';

const T1 = '2026-10-01T08:00:00.000Z';
const T2 = '2026-10-02T08:00:00.000Z';
const CHOOSE = 'Восстановить из файла экспорта';

/** An export file of `blocks` blocks: the first in session s1, the others in s2. */
async function exportFile(blocks = 2, edit: (file: Record<string, unknown>) => void = () => undefined): Promise<string> {
  const source = new MemoryRepository();
  await source.createSession(session('s1', T1));
  await source.createSession(session('s2', T2));
  for (let k = 0; k < blocks; k++) {
    const id = `b${String(k + 1)}`;
    await source.addBlock(block(id, k === 0 ? 's1' : 's2', k === 0 ? T1 : T2), [trial(`t${String(k + 1)}`, id, 0)], []);
  }
  const file = JSON.parse(await exportBundle(source, '0.2.0')) as Record<string, unknown>;
  edit(file);
  return JSON.stringify(file);
}

async function history(repo: Repository) {
  return { sessions: await repo.listSessions(), blocks: await repo.listBlocks(), trials: await repo.listAllTrials(), log: await repo.listLog(20) };
}

const audio = createAudioOut(null);

function Harness(p: { repo: Repository; platform: FakePlatform; busy: boolean; onBusy: (on: boolean) => void }) {
  return (
    <AppContext.Provider value={{ platform: p.platform, repo: p.repo, audio }}>
      <RestoreSection busy={p.busy} onBusy={p.onBusy} />
    </AppContext.Provider>
  );
}

function renderSection(o: { repo?: Repository; busy?: boolean; platform?: FakePlatform } = {}) {
  const repo = o.repo ?? new MemoryRepository();
  const platform = o.platform ?? createFakePlatform({ repo });
  const onBusy = vi.fn<(on: boolean) => void>();
  const view = render(<Harness repo={repo} platform={platform} busy={o.busy ?? false} onBusy={onBusy} />);
  /** The same section with another `busy`. */
  const setBusy = (busy: boolean): void => {
    view.rerender(<Harness repo={repo} platform={platform} busy={busy} onBusy={onBusy} />);
  };
  return { repo, platform, onBusy, setBusy };
}

async function chooseFile(text: string): Promise<void> {
  const input = screen.getByLabelText<HTMLInputElement>('Файл экспорта');
  expect(input.type).toBe('file');
  expect(input.accept).toBe('.json');
  fireEvent.change(input, { target: { files: [new File([text], 'trainer-export-2026-10-14.json', { type: 'application/json' })] } });
  await settleUntil(() => screen.queryByText(/^Чтение файла/) === null, 'reading the file');
}

const button = (name: string) => screen.queryByRole<HTMLButtonElement>('button', { name });

describe('RestoreSection', () => {
  it('shows the title, the explanation and the button; the backup is promised only where there is a database file', () => {
    const repo = new MemoryRepository();
    renderSection({ repo, platform: createFakePlatform({ repo, kind: 'tauri' }) });
    expect(screen.getByRole('heading', { name: 'Восстановление из файла экспорта' })).toBeTruthy();
    expect(
      screen.getByText(
        'Загрузит сессии из файла, который сохранила кнопка «Экспорт данных». Записи на этом компьютере не меняются и не удаляются: ' +
          'те, что уже есть, из файла пропускаются. Перед загрузкой делается резервная копия базы.',
      ),
    ).toBeTruthy();
    expect(button(CHOOSE)?.disabled).toBe(false);
    cleanup();
    renderSection();
    expect(screen.getByText(/из файла пропускаются\.$/)).toBeTruthy();
  });

  it('choosing a file shows the preview with its numbers; nothing is written yet', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('s1', T1));
    const before = await history(repo);
    const { platform } = renderSection({ repo });
    const backupNow = vi.spyOn(platform, 'backupNow');
    await chooseFile(await exportFile());
    expect(
      screen.getByText('В файле: 2 сессии с 01.10.2026 по 02.10.2026. Новых: 1, уже есть: 1. Блоков: 2, новых 2. Контрольных диагностик: 0, новых 0.'),
    ).toBeTruthy();
    expect(button('Восстановить')).toBeTruthy();
    expect(button('Отмена')).toBeTruthy();
    expect(backupNow).not.toHaveBeenCalled();
    expect(await history(repo)).toEqual(before);
  });

  it('«Отмена» goes back to the start and writes nothing', async () => {
    const { repo, platform, onBusy } = renderSection();
    const backupNow = vi.spyOn(platform, 'backupNow');
    await chooseFile(await exportFile());
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByText(/^В файле:/)).toBeNull();
    expect(button('Восстановить')).toBeNull();
    expect(button(CHOOSE)?.disabled).toBe(false);
    expect(backupNow).not.toHaveBeenCalled();
    expect(onBusy).not.toHaveBeenCalled();
    expect(await history(repo)).toEqual({ sessions: [], blocks: [], trials: [], log: [] });
  });

  it('«Восстановить» shows the backup step, the progress and the result', async () => {
    const memory = new MemoryRepository();
    // The 21st block waits: the screen must show the progress after 20 blocks.
    let releaseBlock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    let blocks = 0;
    const repo = new Proxy(memory, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        const fn = (value as (...a: unknown[]) => Promise<unknown>).bind(target);
        return prop === 'addBlock' ? async (...a: unknown[]) => (++blocks === 21 ? gate.then(() => fn(...a)) : fn(...a)) : fn;
      },
    });
    const platform = createFakePlatform({ repo });
    let releaseBackup: (path: string) => void = () => undefined;
    platform.backupNow = () =>
      new Promise((resolve) => {
        releaseBackup = resolve;
      });
    const { onBusy } = renderSection({ repo, platform });
    await chooseFile(await exportFile(25));
    expect(screen.getByText(/Блоков: 25, новых 25\./)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
    await settleUntil(() => screen.queryByText('Резервная копия…') !== null, 'the backup step');
    expect(onBusy).toHaveBeenLastCalledWith(true);
    expect(button('Восстановить')).toBeNull();
    expect(button(CHOOSE)).toBeNull();
    expect(blocks).toBe(0);

    releaseBackup('C:\\app\\backups\\trainer-1790000001.db');
    await settleUntil(() => screen.queryByText('Записано блоков: 20 из 25') !== null, 'the progress');
    const bar = screen.getByRole<HTMLProgressElement>('progressbar');
    expect([bar.value, bar.max]).toEqual([20, 25]);

    releaseBlock();
    await settleUntil(() => screen.queryByText(/^Готово\./) !== null, 'the result');
    expect(screen.getByRole('status').textContent).toContain('Готово. Добавлено сессий: 2, блоков: 25, диагностик: 0, записей самочувствия: 0.');
    expect(screen.getByText('Резервная копия базы: C:\\app\\backups\\trainer-1790000001.db')).toBeTruthy();
    expect(onBusy.mock.calls).toEqual([[true], [false]]);
    expect(await memory.listIds('blocks')).toHaveProperty('size', 25);
    // Another file can be chosen.
    expect(button(CHOOSE)?.disabled).toBe(false);
  });

  it('a damaged file shows its error and no «Восстановить»', async () => {
    const { repo } = renderSection();
    await chooseFile('{"sessions": [');
    expect(screen.getByRole('alert').textContent).toBe('Файл не читается как JSON.');
    expect(button('Восстановить')).toBeNull();
    await chooseFile(await exportFile(2, (f) => Object.assign((f.blocks as Record<string, unknown>[])[1] ?? {}, { score: 'x' })));
    expect(screen.getByRole('alert').textContent).toBe('Запись blocks[1]: поле score должно быть числом.');
    expect(button('Восстановить')).toBeNull();
    expect(button(CHOOSE)?.disabled).toBe(false);
    expect(await history(repo)).toEqual({ sessions: [], blocks: [], trials: [], log: [] });
  });

  it('a failed backup shows its reason and writes nothing', async () => {
    const repo = new MemoryRepository();
    const platform = createFakePlatform({ repo });
    platform.backupNow = () => Promise.reject(new Error('Нет места на диске. (os error 112)'));
    const { onBusy } = renderSection({ repo, platform });
    await chooseFile(await exportFile());
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
    await settleUntil(() => screen.queryByRole('alert') !== null, 'the backup error');
    expect(screen.getByRole('alert').textContent).toBe(
      'Не удалось сделать резервную копию: Нет места на диске. (os error 112). Восстановление не начато.',
    );
    expect(onBusy.mock.calls).toEqual([[true], [false]]);
    expect(await history(repo)).toEqual({ sessions: [], blocks: [], trials: [], log: [] });
  });

  it('a stop shows its reason and what was added before it', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('local', T1));
    // A local block holds trial t2: the file's second block cannot be written.
    await repo.addBlock(block('local-b', 'local', T1), [trial('t2', 'local-b', 0)], []);
    renderSection({ repo });
    await chooseFile(await exportFile(3));
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
    await settleUntil(() => screen.queryByRole('alert') !== null, 'the stop');
    expect(screen.getByRole('alert').textContent).toMatch(/^Блок 2 из 3 не записан: .*запусти восстановление ещё раз/);
    expect(screen.getByText('Добавлено сессий: 2, блоков: 1, диагностик: 0, записей самочувствия: 0.')).toBeTruthy();
  });

  it('names a setting the file could not give', async () => {
    renderSection();
    await chooseFile(await exportFile(1, (f) => (f.settings = { testDate: '14.12.2026', layout: 'pult' })));
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
    await settleUntil(() => screen.queryByText(/^Готово\./) !== null, 'the result');
    expect(screen.getByText(/Из файла взяты: раскладка\.$/)).toBeTruthy();
    expect(screen.getByText('Настройка «дата теста» из файла не подошла и пропущена.')).toBeTruthy();
  });

  it('while another action runs, choosing a file and «Восстановить» are locked', async () => {
    const { setBusy, onBusy } = renderSection({ busy: true });
    expect(button(CHOOSE)?.disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Файл экспорта').disabled).toBe(true);
    setBusy(false);
    await chooseFile(await exportFile());
    setBusy(true);
    expect(button('Восстановить')?.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
    expect(onBusy).not.toHaveBeenCalled();
    expect(button('Отмена')?.disabled).toBe(false);
  });
});
