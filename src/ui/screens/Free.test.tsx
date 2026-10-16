import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../../data/memoryRepository';
import { session } from '../../data/repository.contract';
import type { SessionPlan } from '../../engine/planner';
import { localDate } from '../format';
import { MODULE_IDS } from '../../engine/types';
import { moduleTitles } from '../../modules/registry';
import { createFakePlatform } from '../../testing/fakePlatform';
import { nextTask } from '../../testing/domFakes';
import { renderWithApp } from '../testUtils';
import Free from './Free';

async function renderFree(repo = new MemoryRepository()) {
  const onStart = vi.fn();
  const onBack = vi.fn();
  renderWithApp(<Free onStart={onStart} onBack={onBack} />, createFakePlatform({ repo }), repo);
  await screen.findByRole('button', { name: moduleTitles.rdo });
  return { onStart, onBack };
}

describe('Free', () => {
  it('lists every module', async () => {
    await renderFree();
    const list = screen.getByRole('list', { name: 'Модули' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(MODULE_IDS.map((m) => moduleTitles[m]));
    expect(within(list).getByRole('button', { name: 'Струп' })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe(moduleTitles.pzmr);
  });

  it('starts a 5-minute free plan of the chosen module; the seed changes with the session count', async () => {
    const repo = new MemoryRepository();
    const first = await renderFree(repo);
    fireEvent.click(screen.getByRole('button', { name: moduleTitles.rdo }));
    const plan = first.onStart.mock.calls[0]?.[0] as SessionPlan;
    expect(plan.kind).toBe('free');
    expect(plan.segments).toEqual([{ module: 'rdo', budgetMs: 300_000, purpose: 'free' }]);

    cleanup();
    await repo.createSession(session('s1', new Date().toISOString(), { kind: 'free' }));
    const second = await renderFree(repo);
    fireEvent.click(screen.getByRole('button', { name: moduleTitles.rdo }));
    await waitFor(() => {
      expect(second.onStart).toHaveBeenCalled();
    });
    expect((second.onStart.mock.calls[0]?.[0] as SessionPlan).seed).not.toBe(plan.seed);
  });

  it('the free plan carries the mark rate of the phase of the day (F15)', async () => {
    // No sessions yet: day 1, «База», a mark after every trial.
    const first = await renderFree();
    fireEvent.click(screen.getByRole('button', { name: moduleTitles.szmr }));
    expect((first.onStart.mock.calls[0]?.[0] as SessionPlan).feedback).toBe('every');

    // The test in 5 days: «Подводка», no marks.
    cleanup();
    const repo = new MemoryRepository();
    await repo.saveSettings({ testDate: localDate(new Date(Date.now() + 5 * 86_400_000)) });
    const taper = await renderFree(repo);
    fireEvent.click(screen.getByRole('button', { name: moduleTitles.szmr }));
    expect((taper.onStart.mock.calls[0]?.[0] as SessionPlan).feedback).toBe('none');
  });

  it('the free plan plays the layout of the day, as Home plans it (F9, Р10)', async () => {
    const repo = new MemoryRepository();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    await repo.createSession(session('y', yesterday, { endedAt: yesterday }));
    const day2 = await renderFree(repo);
    fireEvent.click(screen.getByRole('button', { name: moduleTitles.pzmr }));
    expect((day2.onStart.mock.calls[0]?.[0] as SessionPlan).layout).toBe('pult');

    cleanup();
    await repo.saveSettings({ layout: 'mouse' });
    const mouse = await renderFree(repo);
    fireEvent.click(screen.getByRole('button', { name: moduleTitles.pzmr }));
    expect((mouse.onStart.mock.calls[0]?.[0] as SessionPlan).layout).toBe('keyboard');

    cleanup();
    await repo.saveSettings({ layoutRotation: false });
    const off = await renderFree(repo);
    fireEvent.click(screen.getByRole('button', { name: moduleTitles.pzmr }));
    expect((off.onStart.mock.calls[0]?.[0] as SessionPlan).layout).toBe('mouse');
  });

  it('a diagnostic is no training day: the day after it plays the primary (T-R64)', async () => {
    const repo = new MemoryRepository();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    await repo.createSession(session('d', yesterday, { kind: 'diagnostic', endedAt: yesterday }));
    const first = await renderFree(repo);
    fireEvent.click(screen.getByRole('button', { name: moduleTitles.pzmr }));
    expect((first.onStart.mock.calls[0]?.[0] as SessionPlan).layout).toBe('keyboard');
  });

  it('a failed load is shown and logged; «Назад» still works', async () => {
    const repo = new MemoryRepository();
    repo.listSessions = () => Promise.reject(new Error('база занята'));
    const onBack = vi.fn();
    renderWithApp(<Free onStart={vi.fn()} onBack={onBack} />, createFakePlatform({ repo }), repo);
    expect(await screen.findByText('Не удалось загрузить данные: база занята')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await waitFor(async () => {
      expect((await repo.listLog(5)).map((l) => l.message)).toContain('Свободная тренировка: база занята');
    });
  });

  it('«Назад» and Escape go back', async () => {
    const { onBack } = await renderFree();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await nextTask();
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(2);
  });
});
