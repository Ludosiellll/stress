import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../data/memoryRepository';
import { block, item, session } from '../data/repository.contract';
import { deriveRatings } from '../engine/derive';
import { moduleTitles } from '../modules/registry';
import { settleUntil } from '../testing/domFakes';
import { createFakePlatform, type FakePlatformOptions } from '../testing/fakePlatform';
import App from './App';

async function renderApp(options: FakePlatformOptions = {}) {
  const platform = createFakePlatform(options);
  render(<App platform={platform} />);
  // Not findByRole: Home must be idle, its Enter listener attached, before a test presses a key.
  await settleUntil(() => screen.queryByRole('button', { name: 'Начать тренировку' }) !== null, 'Home');
  return platform;
}

describe('App', () => {
  it('renders the title and the home screen', async () => {
    await renderApp();
    expect(screen.getByRole('heading', { level: 1, name: 'Тренажёр отбора' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Сегодня' })).toBeTruthy();
  });

  // Регрессия: без cleanup между тестами DOM накапливается и getByRole находит два заголовка.
  it('starts each test with a clean DOM', async () => {
    await renderApp();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('goes to settings and back', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
    expect(await screen.findByRole('heading', { name: 'Настройки' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findByRole('button', { name: 'Начать тренировку' })).toBeTruthy();
  });

  it('Enter on Home opens the session screen, which starts with the pre-session check', async () => {
    await renderApp();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    const session = await screen.findByRole('region', { name: 'Сессия' });
    expect(within(session).getByText('Проверка экрана и питания…')).toBeTruthy();
  });

  it('opens the progress screen and free training and returns home', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Прогресс' }));
    expect(screen.getByRole('region', { name: 'Прогресс' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Контрольные диагностики' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Свободная тренировка' }));
    expect(await screen.findByRole('region', { name: 'Свободная тренировка' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findByRole('button', { name: 'Начать тренировку' })).toBeTruthy();
  });

  it('a module chosen in free training opens the session screen', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Свободная тренировка' }));
    fireEvent.click(await screen.findByRole('button', { name: moduleTitles.rdo }));
    expect(await screen.findByRole('region', { name: 'Сессия' })).toBeTruthy();
  });

  it('shows why the database did not open', async () => {
    const platform = createFakePlatform();
    platform.openRepository = () => Promise.reject(new Error('файл занят'));
    render(<App platform={platform} />);
    expect(await screen.findByText(/Не удалось открыть базу данных.*файл занят/)).toBeTruthy();
  });

  it('retries opening the database on «Повторить»', async () => {
    const platform = createFakePlatform();
    let calls = 0;
    platform.openRepository = () => (++calls === 1 ? Promise.reject(new Error('файл занят')) : Promise.resolve(platform.repo));
    render(<App platform={platform} />);
    await screen.findByText(/файл занят/);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('button', { name: 'Начать тренировку' })).toBeTruthy();
    expect(calls).toBe(2);
  });
});

describe('startup', () => {
  async function logOf(repo: MemoryRepository) {
    return repo.listLog(20);
  }

  it('logs a failed backup as an error', async () => {
    const repo = new MemoryRepository();
    await renderApp({ repo, kind: 'tauri', backup: { ok: false, path: null, error: 'disk full', at: 1 } });
    const log = await logOf(repo);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ level: 'error', message: 'Резервная копия: disk full' });
  });

  it('logs a successful backup as info with its path', async () => {
    const repo = new MemoryRepository();
    await renderApp({ repo, kind: 'tauri', backup: { ok: true, path: 'C:\\b\\trainer.db', error: null, at: 1 } });
    expect((await logOf(repo))[0]).toMatchObject({ level: 'info', message: 'Резервная копия: C:\\b\\trainer.db' });
  });

  it('logs "копия не нужна" when no copy was made', async () => {
    const repo = new MemoryRepository();
    await renderApp({ repo, kind: 'tauri', backup: { ok: true, path: null, error: null, at: 1 } });
    expect((await logOf(repo))[0]).toMatchObject({ level: 'info', message: 'Резервная копия: новая копия не понадобилась' });
  });

  it('writes nothing about a backup on the web', async () => {
    const repo = new MemoryRepository();
    await renderApp({ repo, backup: null });
    expect(await logOf(repo)).toEqual([]);
  });

  it('installs the error log', async () => {
    const repo = new MemoryRepository();
    await renderApp({ repo });
    window.dispatchEvent(new ErrorEvent('error', { message: 'стартовый тест', error: new Error('стартовый тест') }));
    await expect.poll(async () => (await logOf(repo)).length).toBe(1);
  });

  it('rebuilds the caches from history before Home loads (R30)', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('s1', '2026-10-01T08:00:00.000Z', { endedAt: '2026-10-01T08:30:00.000Z' }));
    await repo.addBlock(block('b1', 's1', '2026-10-01T08:01:00.000Z', { module: 'numseries' }), [], [
      item('i1', 'b1', '2026-10-01T08:02:00.000Z', { family: 'arith', correct: true }),
      item('i2', 'b1', '2026-10-01T08:03:00.000Z', { family: 'geom', correct: false }),
    ]);
    await repo.saveRatings(new Map([['powers', { rating: 1500, n: 7 }]])); // stale: disagrees with the items
    const expected = deriveRatings(await repo.listLogicItems());
    expect(expected.has('powers')).toBe(false);

    await renderApp({ repo });

    expect(await repo.getRatings()).toEqual(expected);
  });

  it('logs a failed rebuild and still opens Home', async () => {
    const repo = new MemoryRepository();
    repo.listLogicItems = () => Promise.reject(new Error('база повреждена'));
    await renderApp({ repo });
    const log = await logOf(repo);
    expect(log.some((r) => r.level === 'error' && r.message.includes('база повреждена'))).toBe(true);
  });
});
