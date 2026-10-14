import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticResults } from '../../engine/diagnostic';
import { MemoryRepository } from '../../data/memoryRepository';
import { session } from '../../data/repository.contract';
import { moduleTitles } from '../../modules/registry';
import { createFakePlatform } from '../../testing/fakePlatform';
import { localDate } from '../format';
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
  };
  return JSON.stringify({ ...base, ...over });
}

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

async function renderHome(repo = new MemoryRepository()) {
  const handlers = { onStart: vi.fn(), onFree: vi.fn(), onProgress: vi.fn(), onSettings: vi.fn() };
  renderWithApp(<Home {...handlers} />, createFakePlatform({ repo }), repo);
  await screen.findByRole('button', { name: 'Начать тренировку' });
  return { repo, ...handlers };
}

async function seedDiagnostic(repo: MemoryRepository, number: number, at: Date, resultsJson: string): Promise<void> {
  const id = `diag-${String(number)}`;
  await repo.createSession(session(id, at.toISOString(), { kind: 'diagnostic', endedAt: at.toISOString() }));
  await repo.addDiagnostic({ id: `d${String(number)}`, sessionId: id, number, at: at.toISOString(), resultsJson });
}

describe('Home without history', () => {
  it('shows the six plan segments with minutes', async () => {
    await renderHome();
    expect(screen.getByRole('heading', { name: 'Сегодня' })).toBeTruthy();
    const items = within(screen.getByRole('list', { name: 'План на сегодня' })).getAllByRole('listitem');
    expect(items).toHaveLength(6);
    expect(items[0]?.textContent).toBe(`${moduleTitles.pzmr} — 2 мин`);
    expect(items[3]?.textContent).toBe(`${moduleTitles.gorbov} — 6 мин`);
    expect(items[4]?.textContent).toBe(`${moduleTitles.schulte} — 4 мин`);
    expect(items[5]?.textContent).toBe(`${moduleTitles.numseries} — 10 мин`);
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
  });
});

describe('Home actions', () => {
  it('Enter starts the training with the plan that is on screen', async () => {
    const { onStart } = await renderHome();
    const shown = within(screen.getByRole('list', { name: 'План на сегодня' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onStart).toHaveBeenCalledTimes(1);
    const plan = onStart.mock.calls[0]?.[0] as { kind: string; segments: { module: keyof typeof moduleTitles; budgetMs: number }[] };
    expect(plan.kind).toBe('training');
    expect(plan.segments.map((s) => `${moduleTitles[s.module]} — ${String(s.budgetMs / 60000)} мин`)).toEqual(shown);
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
