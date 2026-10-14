import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticResults } from '../../engine/diagnostic';
import { MemoryRepository } from '../../data/memoryRepository';
import { session } from '../../data/repository.contract';
import type { SessionPlan } from '../../engine/planner';
import { settleUntil } from '../../testing/domFakes';
import { createFakePlatform } from '../../testing/fakePlatform';
import { localDate } from '../format';
import { planLine } from '../homeModel';
import { renderWithApp } from '../testUtils';
import Home from './Home';

function noResults(over: Partial<DiagnosticResults>): string {
  const base: DiagnosticResults = {
    pzmrMedianRt: null,
    szmrMedianRt: null,
    gonogoScore: null,
    rdoMeanAbsErrorMs: null,
    gorbov: null,
    numseriesCorrect: null,
    unreliable: [],
  };
  return JSON.stringify({ ...base, ...over });
}

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

const planLines = (): (string | null)[] =>
  within(screen.getByRole('list', { name: 'План на сегодня' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);

async function renderHome(repo = new MemoryRepository()) {
  const handlers = { onStart: vi.fn(), onFree: vi.fn(), onProgress: vi.fn(), onSettings: vi.fn() };
  renderWithApp(<Home {...handlers} />, createFakePlatform({ repo }), repo);
  // Not findByRole + an empty act: findByRole can resolve as soon as the DOM is committed, while React's
  // scheduler has yet to run Home's passive keydown effect, and an empty act does not flush that scheduler.
  await settleUntil(() => screen.queryByRole('button', { name: 'Начать тренировку' }) !== null, 'Home');
  return { repo, ...handlers };
}

async function seedDiagnostic(repo: MemoryRepository, number: number, at: Date, resultsJson: string): Promise<void> {
  const id = `diag-${String(number)}`;
  await repo.createSession(session(id, at.toISOString(), { kind: 'diagnostic', endedAt: at.toISOString() }));
  await repo.addDiagnostic({ id: `d${String(number)}`, sessionId: id, number, at: at.toISOString(), resultsJson });
}

describe('Home without history', () => {
  it('shows the six plan segments with minutes and the base phase', async () => {
    await renderHome();
    expect(screen.getByRole('heading', { name: 'Сегодня' })).toBeTruthy();
    expect(planLines()).toEqual([
      'ПЗМР — 2 мин',
      'Сложная реакция (СЗМР) — 5 мин',
      'Go/No-Go — 5 мин',
      'Красно-чёрные таблицы Горбова — 5 мин',
      'Память — 5 мин',
      'Числовые ряды — 10 мин',
    ]);
    expect(screen.getByText('Фаза: база')).toBeTruthy();
    expect(screen.getByText('День 1 из 14: калибровка уровней и стартовая диагностика.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Напоминания' })).toBeNull();
  });

  it('asks for the first diagnostic and shows the due banner', async () => {
    await renderHome();
    expect(screen.getByText('Пройди диагностику, чтобы увидеть индекс')).toBeTruthy();
    expect(screen.getByText('Пора пройти контрольную диагностику (раз в 2 недели)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Пройти диагностику' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Контрольная диагностика' })).toBeTruthy();
    expect(screen.getByText('Серия: 0 дн.')).toBeTruthy();
    expect(screen.queryByText(/До теста/)).toBeNull();
  });

  it('shows days to the test when a date is set', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ testDate: localDate(daysFromNow(10)) });
    await renderHome(repo);
    expect(screen.getByText('До теста: 10 дн.')).toBeTruthy();
    expect(screen.getByText('Фаза: перегрузка')).toBeTruthy();
    // Nothing is calibrated yet: no finisher in the plan, none in the reason.
    expect(screen.getByText('До теста 10 дн.: модули реакции по 6 мин.')).toBeTruthy();
    expect(planLines()[1]).toBe('Сложная реакция (СЗМР) — 6 мин');
    expect(planLines()).toHaveLength(6);
  });

  it('the overload reason names the finisher that is in the plan', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ testDate: localDate(daysFromNow(10)) });
    // РДО is calibrated (3 blocks) and not among today's reaction picks, so it becomes the finisher.
    await repo.saveModuleState({
      module: 'rdo',
      lSaved: 10,
      sessionEndLevels: [10],
      savedHistory: [10],
      plateau: false,
      lastTrainedAt: daysFromNow(-1).toISOString(),
      lifetimeBlocks: 3,
    });
    await renderHome(repo);
    expect(screen.getByText('До теста 10 дн.: финишер 5 мин, модули реакции по 6 мин.')).toBeTruthy();
    expect(planLines()[6]).toBe('Реакция на движущийся объект — 5 мин — финишер с перегрузкой');
  });

  it('on the test day the reason says the test is today', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ testDate: localDate(new Date()) });
    await renderHome(repo);
    expect(screen.getByText('Фаза: подводка')).toBeTruthy();
    expect(screen.getByText('Сегодня тест: объём меньше на 40 %, без финишера и новых модулей.')).toBeTruthy();
    expect(screen.queryByText(/До теста 0 дн\./)).toBeNull();
  });
});

describe('Home in the taper', () => {
  it('a test date in 5 days: the taper phase, both hints and the rehearsal banner', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ testDate: localDate(daysFromNow(5)) });
    // A diagnostic 3 days ago: the regular one is not due, the rehearsal is (one of two, last one ≥ 2 days ago).
    await seedDiagnostic(repo, 1, daysFromNow(-3), noResults({}));
    const { onStart } = await renderHome(repo);
    expect(screen.getByText('Фаза: подводка')).toBeTruthy();
    expect(screen.getByText('До теста 5 дн.: объём меньше на 40 %, без финишера и новых модулей.')).toBeTruthy();
    const hints = within(screen.getByRole('list', { name: 'Напоминания' })).getAllByRole('listitem');
    expect(hints.map((li) => li.textContent)).toEqual([
      'Тренируйся утром, в то же время, на которое назначен тест.',
      'Перед тестом спи не меньше 8 часов.',
    ]);
    expect(planLines()).toEqual([
      'ПЗМР — 1 мин',
      'Сложная реакция (СЗМР) — 3 мин',
      'Go/No-Go — 3 мин',
      'Красно-чёрные таблицы Горбова — 3 мин',
      'Память — 3 мин',
      'Числовые ряды — 6 мин',
    ]);
    expect(screen.getByText('Генеральная репетиция: пройди контрольную диагностику (в подводке — 2 раза)')).toBeTruthy();
    expect(screen.queryByText(/Пора пройти/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Пройти диагностику' }));
    expect(onStart.mock.calls[0]?.[0]).toMatchObject({ kind: 'diagnostic', diagnosticNumber: 2 });
  });

  it('the regular diagnostic banner is shown instead of the rehearsal one when a diagnostic is due', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ testDate: localDate(daysFromNow(5)) });
    await renderHome(repo);
    expect(screen.getByText('Фаза: подводка')).toBeTruthy();
    expect(screen.getByText('Пора пройти контрольную диагностику (раз в 2 недели)')).toBeTruthy();
    expect(screen.queryByText(/Генеральная репетиция/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Пройти диагностику' })).toHaveLength(1);
  });

  it('no rehearsal banner after a diagnostic yesterday', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ testDate: localDate(daysFromNow(5)) });
    await seedDiagnostic(repo, 1, daysFromNow(-1), noResults({}));
    await renderHome(repo);
    expect(screen.getByText('Фаза: подводка')).toBeTruthy();
    expect(screen.queryByText(/Генеральная репетиция/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Пройти диагностику' })).toBeNull();
  });
});

describe('Home actions', () => {
  it('Enter starts the training with the plan that is on screen', async () => {
    const { onStart } = await renderHome();
    const shown = planLines();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onStart).toHaveBeenCalledTimes(1);
    const plan = onStart.mock.calls[0]?.[0] as SessionPlan;
    expect(plan.kind).toBe('training');
    expect(plan.segments.map(planLine)).toEqual(shown);
  });

  it('the start button gives the same plan', async () => {
    const { onStart } = await renderHome();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Начать тренировку' }));
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onStart.mock.calls[1]?.[0]).toEqual(onStart.mock.calls[0]?.[0]);
  });

  it('Enter on another focused button does not start the training', async () => {
    const { onStart, onSettings } = await renderHome();
    const settings = screen.getByRole('button', { name: 'Настройки' });
    fireEvent.keyDown(settings, { key: 'Enter' });
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.click(settings);
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('ignores a held Enter', async () => {
    const { onStart } = await renderHome();
    fireEvent.keyDown(document.body, { key: 'Enter', repeat: true });
    expect(onStart).not.toHaveBeenCalled();
  });

  it('opens free training and progress', async () => {
    const { onFree, onProgress } = await renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Свободная тренировка' }));
    fireEvent.click(screen.getByRole('button', { name: 'Прогресс' }));
    expect(onFree).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('starts diagnostic number 1 from the banner button', async () => {
    const { onStart } = await renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Пройти диагностику' }));
    const plan = onStart.mock.calls[0]?.[0] as { kind: string; diagnosticNumber: number };
    expect(plan).toMatchObject({ kind: 'diagnostic', diagnosticNumber: 1 });
  });
});

describe('Home with history', () => {
  it('counts the streak from finished training sessions only', async () => {
    const repo = new MemoryRepository();
    const today = new Date();
    const iso = (n: number): string => daysFromNow(n).toISOString();
    await repo.createSession(session('a', iso(0), { endedAt: iso(0) }));
    await repo.createSession(session('b', iso(-1), { endedAt: iso(-1) }));
    await repo.createSession(session('c', iso(-2))); // not finished
    await repo.createSession(session('d', today.toISOString(), { kind: 'free', endedAt: today.toISOString() }));
    await renderHome(repo);
    expect(screen.getByText('Серия: 2 дн.')).toBeTruthy();
  });

  it('hides the banner after a fresh diagnostic, keeps the secondary button, numbers the next one', async () => {
    const repo = new MemoryRepository();
    await seedDiagnostic(repo, 1, new Date(), noResults({}));
    await seedDiagnostic(repo, 2, new Date(), noResults({}));
    const { onStart } = await renderHome(repo);
    expect(screen.queryByText(/Пора пройти/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Пройти диагностику' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Контрольная диагностика' }));
    expect(onStart.mock.calls[0]?.[0]).toMatchObject({ kind: 'diagnostic', diagnosticNumber: 3 });
  });

  it('shows the banner again after 14 days', async () => {
    const repo = new MemoryRepository();
    await seedDiagnostic(repo, 1, daysFromNow(-14), noResults({}));
    await renderHome(repo);
    expect(screen.getByText('Пора пройти контрольную диагностику (раз в 2 недели)')).toBeTruthy();
  });

  it('shows readiness numbers after two diagnostics', async () => {
    const repo = new MemoryRepository();
    await seedDiagnostic(
      repo,
      1,
      daysFromNow(-20),
      noResults({ pzmrMedianRt: 400, szmrMedianRt: 600, rdoMeanAbsErrorMs: 50, gonogoScore: 80, numseriesCorrect: 10, gorbov: { V: 60, P: 100, Pi: 40 } }),
    );
    await seedDiagnostic(
      repo,
      2,
      new Date(),
      noResults({ pzmrMedianRt: 300, szmrMedianRt: 450, rdoMeanAbsErrorMs: 40, gonogoScore: 90, numseriesCorrect: 14, gorbov: { V: 30, P: 60, Pi: 10 } }),
    );
    await renderHome(repo);
    const value = (label: string): string | null => screen.getByText(label).nextElementSibling?.textContent ?? null;
    expect(value('Реакция')).toBe('97');
    expect(value('Внимание')).toBe('89');
    expect(value('Переключение')).toBe('98');
    expect(value('Логика')).toBe('100');
    expect(value('Память')).toBe('появится позже');
    expect(screen.getByText('Общий индекс: 96')).toBeTruthy();
    expect(screen.getByText('Для большинства показателей 60 — уровень первой диагностики; таблица Горбова оценивается по опубликованным нормам.')).toBeTruthy();
    expect(screen.queryByText('Пройди диагностику, чтобы увидеть индекс')).toBeNull();
  });

  it('writes "нет данных" for abilities without a result', async () => {
    const repo = new MemoryRepository();
    await seedDiagnostic(repo, 1, new Date(), noResults({ pzmrMedianRt: 300 }));
    await renderHome(repo);
    expect(screen.getByText('Внимание').nextElementSibling?.textContent).toBe('нет данных');
    expect(screen.getByText('Логика').nextElementSibling?.textContent).toBe('нет данных');
    expect(screen.getByText('Реакция').nextElementSibling?.textContent).toBe('60');
  });

  it('does not fail on a damaged diagnostic record', async () => {
    const repo = new MemoryRepository();
    await seedDiagnostic(repo, 1, new Date(), '{не json');
    await renderHome(repo);
    expect(screen.getByText('Реакция').nextElementSibling?.textContent).toBe('нет данных');
  });
});

describe('Home keys', () => {
  it('ignores Enter with a modifier or after preventDefault', async () => {
    const { onStart } = await renderHome();
    for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
      fireEvent.keyDown(document.body, { key: 'Enter', [mod]: true });
    }
    const prevented = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    prevented.preventDefault();
    document.body.dispatchEvent(prevented);
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});

describe('Home day change', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('recomputes the date when the window gets focus after midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 14, 23, 50) });
    const repo = new MemoryRepository();
    await repo.saveSettings({ testDate: '2026-10-24' });
    await renderHome(repo);
    expect(screen.getByText('До теста: 10 дн.')).toBeTruthy();
    vi.setSystemTime(new Date(2026, 9, 15, 0, 10));
    fireEvent.focus(window);
    await screen.findByText('До теста: 9 дн.');
  });
});

describe('Home load failure', () => {
  it('logs the error and keeps «Повторить» and «Настройки» available', async () => {
    const repo = new MemoryRepository();
    const getSettings = vi.spyOn(repo, 'getSettings').mockRejectedValueOnce(new Error('плохая дата'));
    const handlers = { onStart: vi.fn(), onFree: vi.fn(), onProgress: vi.fn(), onSettings: vi.fn() };
    renderWithApp(<Home {...handlers} />, createFakePlatform({ repo }), repo);
    await screen.findByText(/Не удалось загрузить данные: плохая дата/);
    await vi.waitFor(async () => {
      expect((await repo.listLog(5)).some((r) => r.level === 'error' && r.message.includes('плохая дата'))).toBe(true);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
    expect(handlers.onSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await screen.findByRole('button', { name: 'Начать тренировку' });
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it('reaches the error state from a damaged session date', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('bad', '2026-10-01T08:00:00.000Z', { endedAt: 'вчера' }));
    renderWithApp(<Home onStart={vi.fn()} onFree={vi.fn()} onProgress={vi.fn()} onSettings={vi.fn()} />, createFakePlatform({ repo }), repo);
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Настройки' })).toBeTruthy();
  });
});
