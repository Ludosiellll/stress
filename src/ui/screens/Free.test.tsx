import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../../data/memoryRepository';
import { session } from '../../data/repository.contract';
import type { SessionPlan } from '../../engine/planner';
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
