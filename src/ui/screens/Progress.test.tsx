import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../../data/memoryRepository';
import { block, session } from '../../data/repository.contract';
import type { DiagnosticResults } from '../../engine/diagnostic';
import { defaultModuleState } from '../../engine/derive';
import { L_NORM } from '../../engine/planner';
import { MODULE_IDS } from '../../engine/types';
import { createFakePlatform } from '../../testing/fakePlatform';
import { moduleTitles } from '../../modules/registry';
import { diagnosticCharts } from '../progressModel';
import { renderWithApp } from '../testUtils';
import Progress from './Progress';

const base: DiagnosticResults = {
  pzmrMedianRt: 320,
  szmrMedianRt: 450,
  gonogoScore: 80,
  rdoMeanAbsErrorMs: 60,
  gorbov: { V: 50, P: 90, Pi: 30 },
  numseriesCorrect: 10,
  unreliable: [],
};

async function seedDiagnostic(repo: MemoryRepository, number: number, results: Partial<DiagnosticResults>): Promise<void> {
  const at = new Date(2026, 9, number, 10).toISOString();
  await repo.createSession(session(`diag-${String(number)}`, at, { kind: 'diagnostic', endedAt: at }));
  await repo.addDiagnostic({ id: `d${String(number)}`, sessionId: `diag-${String(number)}`, number, at, resultsJson: JSON.stringify({ ...base, ...results }) });
}

async function renderProgress(repo = new MemoryRepository()) {
  const onBack = vi.fn();
  renderWithApp(<Progress onBack={onBack} />, createFakePlatform({ repo }), repo);
  await screen.findByRole('heading', { name: 'Контрольные диагностики' });
  return { repo, onBack };
}

const chartOf = (title: string): HTMLElement => {
  const heading = screen.getByRole('heading', { name: title });
  const card = heading.closest('figure');
  if (card === null) throw new Error(`no chart card for ${title}`);
  return card;
};

describe('Progress with two diagnostics', () => {
  async function seeded() {
    const repo = new MemoryRepository();
    await seedDiagnostic(repo, 1, {});
    await seedDiagnostic(repo, 2, { pzmrMedianRt: 300, szmrMedianRt: 430, gonogoScore: 90, rdoMeanAbsErrorMs: 50, gorbov: { V: 45, P: 85, Pi: 25 }, numseriesCorrect: 13 });
    return renderProgress(repo);
  }

  it('shows the readiness block at the top', async () => {
    await seeded();
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings.indexOf('Индекс готовности')).toBeLessThan(headings.indexOf('Контрольные диагностики'));
    expect(screen.getByText(/Общий индекс: \d+/)).toBeTruthy();
  });

  it('draws one chart per metric with two points each and the direction under the title', async () => {
    await seeded();
    for (const [title, direction, points] of [
      ['ПЗМР, медиана, мс', 'меньше — лучше', 2],
      ['СЗМР, медиана, мс', 'меньше — лучше', 2],
      ['Go/No-Go, точность, %', 'больше — лучше', 2],
      ['РДО, средняя ошибка, мс', 'меньше — лучше', 2],
      ['Числовые ряды, верно из 20', 'больше — лучше', 2],
      ['Таблица Горбова: V, P, Π, с', 'меньше — лучше', 6],
    ] as const) {
      const card = chartOf(title);
      expect(within(card).getByText(direction)).toBeTruthy();
      expect(card.querySelectorAll('circle')).toHaveLength(points);
      expect(card.querySelector('svg')?.getAttribute('role')).toBe('img');
    }
    expect(chartOf('ПЗМР, медиана, мс').querySelector('svg')?.getAttribute('aria-label')).toMatch(/№1: 320.*№2: 300/);
  });

  it('draws the L_NORM line with its label on every module with a level', async () => {
    const repo = new MemoryRepository();
    await seedDiagnostic(repo, 1, {});
    await seedDiagnostic(repo, 2, {});
    await repo.saveModuleState({ ...defaultModuleState('pzmr'), sessionEndLevels: [3, 5, 6.5], lSaved: 6.5 });
    await renderProgress(repo);
    const card = chartOf(moduleTitles.pzmr);
    expect(card.querySelectorAll('circle')).toHaveLength(3);
    expect(card.querySelector('line.chart-ref')).not.toBeNull();
    expect(within(card).getByText('≈ формат теста')).toBeTruthy();
    const ticks = [...card.querySelectorAll('text.y-tick')].map((t) => Number(t.textContent));
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(L_NORM.pzmr);
    expect(screen.getAllByText('≈ формат теста')).toHaveLength(1);
    expect(within(card).getByText('сессия с этим модулем')).toBeTruthy();
  });
});

describe('Progress with an unreliable measurement', () => {
  it('marks the point, notes it under the chart and in the readiness block (I1)', async () => {
    const repo = new MemoryRepository();
    await seedDiagnostic(repo, 1, {});
    await seedDiagnostic(repo, 2, { pzmrMedianRt: 300, unreliable: ['pzmr'] });
    await renderProgress(repo);
    const card = chartOf('ПЗМР, медиана, мс');
    expect([...card.querySelectorAll('circle > title')].map((t) => t.textContent)).toEqual(['№1: 320', '№2: 300 (замер ненадёжен)']);
    expect(within(card).getByText('Замер ненадёжен (пропуски кадров): №2')).toBeTruthy();
    expect(within(chartOf('СЗМР, медиана, мс')).queryByText(/Замер ненадёжен/)).toBeNull();
    expect(screen.getByText('В последней диагностике замер ненадёжен: ПЗМР. Индекс учитывает эти значения.')).toBeTruthy();
  });
});

describe('Progress edge cases', () => {
  it('leaves gaps for metrics a diagnostic does not have', async () => {
    const repo = new MemoryRepository();
    await seedDiagnostic(repo, 1, { pzmrMedianRt: null });
    await seedDiagnostic(repo, 2, { pzmrMedianRt: 300 });
    await renderProgress(repo);
    const card = chartOf('ПЗМР, медиана, мс');
    expect(card.querySelectorAll('circle')).toHaveLength(1);
    expect(card.querySelector('circle > title')?.textContent).toBe('№2: 300');
    // The x slot of №1 stays; nothing is drawn at zero.
    expect([...card.querySelectorAll('text.x-tick')].map((t) => t.textContent)).toEqual(['№1', '№2']);
  });

  it('says «Нет данных» in every chart of an empty history, with the invitation to run a diagnostic', async () => {
    await renderProgress();
    expect(screen.getByText('Пройди диагностику, чтобы увидеть индекс')).toBeTruthy();
    // One chart per diagnostic metric + one level chart per module with a level (all but number series).
    const levelModules = MODULE_IDS.filter((m) => m !== 'numseries').length;
    expect(screen.getAllByText('Нет данных')).toHaveLength(diagnosticCharts([]).length + levelModules);
    expect(screen.getByText('Сессий пока нет')).toBeTruthy();
    expect(screen.queryByText('≈ формат теста')).toBeNull();
  });

  it('lists sessions newest first with date, type, duration and block count; unfinished ones say so', async () => {
    const repo = new MemoryRepository();
    const t = (day: number, h: number, m = 0): string => new Date(2026, 9, day, h, m).toISOString();
    await repo.createSession(session('s1', t(10, 9), { kind: 'training', endedAt: t(10, 9, 25) }));
    await repo.createSession(session('s2', t(12, 18), { kind: 'free', endedAt: t(12, 18, 5) }));
    await repo.createSession(session('s3', t(14, 8), { kind: 'training' }));
    await repo.addBlock(block('b1', 's1', t(10, 9, 1), { module: 'pzmr' }), [], []);
    await repo.addBlock(block('b2', 's1', t(10, 9, 5), { module: 'gorbov' }), [], []);
    await repo.addBlock(block('b3', 's1', t(10, 9, 15), { module: 'szmr' }), [], []);
    await repo.addBlock(block('b4', 's2', t(12, 18, 1), { module: 'schulte' }), [], []);
    await renderProgress(repo);

    const table = screen.getByRole('table', { name: 'История сессий' });
    const rows = within(table).getAllByRole('row').slice(1);
    const cells = rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(cells).toEqual([
      ['14.10.2026', 'Тренировка', 'не завершена', '0'],
      ['12.10.2026', 'Свободная', '5 мин', '1'],
      ['10.10.2026', 'Тренировка', '25 мин', '3'],
    ]);
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Дата', 'Тип', 'Длительность', 'Блоков']);
  });

  it('shows the error and retries when the data cannot be read', async () => {
    const repo = new MemoryRepository();
    const read = vi.spyOn(repo, 'listDiagnostics').mockRejectedValueOnce(new Error('диск занят'));
    const onBack = vi.fn();
    renderWithApp(<Progress onBack={onBack} />, createFakePlatform({ repo }), repo);
    expect((await screen.findByRole('alert')).textContent).toContain('диск занят');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { name: 'Контрольные диагностики' })).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    expect((await repo.listLog(10)).some((l) => l.message.includes('диск занят'))).toBe(true);
  });
});

describe('Progress navigation', () => {
  it('«Назад» and Escape go back', async () => {
    const { onBack } = await renderProgress();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 5));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(2);
  });
});
