import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../../data/memoryRepository';
import { rebuildCaches } from '../../data/export';
import { block, session } from '../../data/repository.contract';
import { EMPTY_METRICS, type DiagnosticResults } from '../../engine/diagnostic';
import { L_NORM } from '../../engine/planner';
import { MODULE_IDS, type ModuleId } from '../../engine/types';
import { createFakePlatform } from '../../testing/fakePlatform';
import { moduleTitles } from '../../modules/registry';
import { diagnosticCharts } from '../progressModel';
import { renderWithApp } from '../testUtils';
import Progress from './Progress';

const base: DiagnosticResults = {
  ...EMPTY_METRICS,
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
      ['РДО, средняя ошибка по модулю, мс', 'меньше — лучше', 2],
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
    await seedLevels(repo, 'pzmr', [3, 5, 6.5].map((lAfter) => ({ lAfter, paramsJson: '{"band":1}' })));
    await renderProgress(repo);
    const card = chartOf(moduleTitles.pzmr);
    expect(card.querySelectorAll('circle')).toHaveLength(3);
    expect(card.querySelector('line.chart-ref')).not.toBeNull();
    expect(within(card).getByText('≈ формат теста')).toBeTruthy();
    const ticks = [...card.querySelectorAll('text.y-tick')].map((t) => Number(t.textContent));
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(L_NORM.pzmr);
    expect(screen.getAllByText('≈ формат теста')).toHaveLength(1);
    expect(within(card).getByText('сессия с этим модулем')).toBeTruthy();
    // No session before the load bands: no break.
    expect(card.querySelector('line.chart-marker')).toBeNull();
    expect(within(card).queryByText(BREAK_NOTE)).toBeNull();
  });
});

const BREAK_NOTE = 'До черты уровень — окно ответа по старым правилам, после — полосы нагрузки';

/** One training session per level, hours apart and ending an hour ago; the module's block of each at that level. */
async function seedLevels(repo: MemoryRepository, module: ModuleId, levels: readonly { lAfter: number; paramsJson: string }[]): Promise<void> {
  for (const [i, { lAfter, paramsJson }] of levels.entries()) {
    const at = new Date(Date.now() - (levels.length - i) * 60 * 60 * 1000).toISOString();
    const id = `${module}-${String(i)}`;
    await repo.createSession(session(id, at, { endedAt: at }));
    await repo.addBlock(block(id, id, at, { module, lAfter, paramsJson }), [], []);
  }
}

describe('Progress after the load bands (F3, spec §3.1.6)', () => {
  it('marks the first session of the load bands on the level chart, with the note under it', async () => {
    const repo = new MemoryRepository();
    const old = '{"windowMs":300}';
    await seedLevels(repo, 'pzmr', [
      { lAfter: 14, paramsJson: old },
      { lAfter: 15, paramsJson: old },
      { lAfter: 9, paramsJson: '{"band":2}' },
      { lAfter: 10, paramsJson: '{"band":2}' },
    ]);
    await rebuildCaches(repo);
    await renderProgress(repo);
    const card = chartOf(moduleTitles.pzmr);
    // The points as recorded.
    expect([...card.querySelectorAll('circle > title')].map((t) => t.textContent)).toEqual(['1: 14', '2: 15', '3: 9', '4: 10']);
    expect(card.querySelector('line.chart-marker')).not.toBeNull();
    expect(within(card).getByText('0.3.0: уровень — это нагрузка')).toBeTruthy();
    expect(within(card).getByText(BREAK_NOTE)).toBeTruthy();
    // The norm line steps from the old 14 to the new 8.
    expect(card.querySelectorAll('line.chart-ref')).toHaveLength(2);
    // Only the chart with a break has the note.
    expect(screen.getAllByText(BREAK_NOTE)).toHaveLength(1);
  });

  it('says the mean score of the overload blocks of the last 28 days', async () => {
    const repo = new MemoryRepository();
    const at = (h: number): string => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
    const counts = (hit: number, miss: number): string =>
      JSON.stringify({ counts: { hit, wrong: 0, miss, late: 0, false_start: 0, commission: 0, correct_reject: 0, early: 0, timing_late: 0 } });
    await repo.createSession(session('s', at(5), { endedAt: at(4) }));
    await repo.addBlock(block('o1', 's', at(5), { module: 'szmr', flags: ['overload'], summaryJson: counts(14, 6) }), [], []);
    await repo.addBlock(block('o2', 's', at(4), { module: 'stroop', flags: ['overload'], summaryJson: counts(39, 11) }), [], []);
    await renderProgress(repo);
    const line = screen.getByText('Средний балл блоков перегрузки за 28 дней: 0,74 (блоков: 2)');
    expect(line.closest('section')?.getAttribute('aria-labelledby')).toBe('levels-title');
  });

  it('says there were no overload blocks', async () => {
    await renderProgress();
    expect(screen.getByText('Блоков перегрузки за 28 дней не было.').closest('section')?.getAttribute('aria-labelledby')).toBe('levels-title');
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
    // …and the form-of-day chart.
    expect(screen.getAllByText('Нет данных')).toHaveLength(diagnosticCharts([]).length + levelModules + 1);
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

  it('«Оценка по модулям» comes right under the readiness index', async () => {
    const repo = new MemoryRepository();
    const t = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await repo.createSession(session('s1', t, { kind: 'training', endedAt: t }));
    await repo.addBlock(block('b1', 's1', t, { module: 'pzmr', lBefore: 3, lAfter: 3.5, summaryJson: '{"meanRt":262.4,"sdRt":50,"counts":{"hit":15,"miss":0,"late":0}}' }), [], []);
    await rebuildCaches(repo);
    await renderProgress(repo);

    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    const at = headings.indexOf('Оценка по модулям');
    expect(at).toBe(headings.indexOf('Индекс готовности') + 1);
    expect(at).toBe(headings.indexOf('Форма дня') - 1);

    const table = screen.getByRole('table', { name: 'Оценка по модулям' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Модуль',
      'Ступень',
      'Последний / лучший за 30 дней',
      'Ориентир',
      'Цель',
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(11);
    const cells = (r: HTMLElement): string[] => within(r).getAllByRole('cell').map((c) => c.textContent);
    // A number never breaks from its unit (A-R22).
    expect(cells(rows[0] as HTMLElement)).toEqual(['ПЗМР', '1 — начальная (ур. 3,5; формат теста — 8)', '262\u00a0мс / 262\u00a0мс', 'средний', 'ур. 4 (+0,5)']);
    expect(cells(rows[1] as HTMLElement)).toEqual(['Сложная реакция (СЗМР)', '—', 'ещё не тренировался', '—', '—']);
    // Only the number column is right-aligned; «Ориентир» and «Цель» are text (A-R12).
    const first = within(rows[0] as HTMLElement).getAllByRole('cell');
    expect(first.map((c) => c.classList.contains('num'))).toEqual([false, false, true, false, false]);
    // …and it never breaks a cell («ещё не тренировался») over two lines; the e2e screens test measures it.
    expect(first.map((c) => c.classList.contains('nowrap'))).toEqual([false, false, true, false, false]);
    expect(table.nextElementSibling?.textContent).toBe(
      'Ступень — по сохранённому уровню. Ориентир — опубликованные нормы, ориентировочно; источники — в руководстве.',
    );
  });

  it('«Форма дня» follows «Оценка по модулям»: the daily median of the ПЗМР warm-up (F5)', async () => {
    const repo = new MemoryRepository();
    const day = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();
    for (const d of [3, 1]) {
      await repo.createSession(session(`s${String(d)}`, day(d), { endedAt: day(d) }));
      await repo.addBlock(
        block(`w${String(d)}`, `s${String(d)}`, day(d), { flags: ['warmup'], summaryJson: JSON.stringify({ cleanHitRts: [300 - d, 310 - d] }) }),
        [],
        [],
      );
    }
    await renderProgress(repo);
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    const at = headings.indexOf('Форма дня');
    expect(at).toBe(headings.indexOf('Оценка по модулям') + 1);
    expect(headings[at + 1]).toBe('Разминка ПЗМР: медиана по дням, мс');
    const card = chartOf('Разминка ПЗМР: медиана по дням, мс');
    expect(within(card).getByText('меньше — лучше')).toBeTruthy();
    expect(card.querySelectorAll('circle')).toHaveLength(2);
  });

  it('«Прогоны в формате теста» follows «Форма дня»: the mean and the SD of each format by run, the best results (F4)', async () => {
    const repo = new MemoryRepository();
    const day = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();
    const run = (mean: number, sd: number | null, errors: number): string =>
      JSON.stringify({ testFormat: { mean, sd, errors, falseStarts: 0, thirds: [mean, mean, mean] } });
    for (const [id, d, module, summaryJson] of [
      ['a', 9, 'pzmr', run(262.4, 31, 1)],
      ['b', 6, 'szmr', run(401, 55, 2)],
      ['c', 3, 'rdo', run(18, 22, 4)],
      ['e', 1, 'pzmr', run(250, null, 0)],
    ] as const) {
      await repo.createSession(session(id, day(d), { endedAt: day(d) }));
      await repo.addBlock(block(id, id, day(d), { module, flags: ['test_format'], summaryJson }), [], []);
    }
    await renderProgress(repo);
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    const at = headings.indexOf('Прогоны в формате теста');
    expect(at).toBeGreaterThan(headings.indexOf('Форма дня'));
    expect(at).toBeLessThan(headings.indexOf('Контрольные диагностики'));
    expect(headings.slice(at + 1, at + 7)).toEqual(['ПЗМР: среднее, мс', 'ПЗМР: SD, мс', 'СЗМР: среднее, мс', 'СЗМР: SD, мс', 'РДО: отклонение, мс', 'РДО: SD, мс']);
    const mean = chartOf('ПЗМР: среднее, мс');
    expect(within(mean).getByText('меньше — лучше')).toBeTruthy();
    expect([...mean.querySelectorAll('circle > title')].map((t) => t.textContent)).toEqual([expect.stringMatching(/: 262$/), expect.stringMatching(/: 250$/)]);
    // A run without an SD is a gap.
    expect(chartOf('ПЗМР: SD, мс').querySelectorAll('circle')).toHaveLength(1);

    const table = screen.getByRole('table', { name: 'Лучшие результаты' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Формат', 'Среднее', 'SD', 'Ошибки', 'Фальстарты', 'Прогонов']);
    const rows = within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(rows).toEqual([
      ['ПЗМР', '250\u00a0мс', '31\u00a0мс', '0', '0', '2'],
      ['СЗМР', '401\u00a0мс', '55\u00a0мс', '2', '0', '1'],
      ['РДО', '18\u00a0мс', '22\u00a0мс', '4', '0', '1'],
    ]);
    expect(table.nextElementSibling?.textContent).toBe('У РДО в колонке «Среднее» — среднее отклонение от отметки.');
  });

  it('«Прогоны в формате теста» without runs says when they start', async () => {
    await renderProgress();
    const note = screen.getByText('Прогонов пока не было. Они начнутся с 15-го дня.');
    expect(note.closest('section')?.getAttribute('aria-labelledby')).toBe('test-format-title');
    expect(screen.queryByRole('table', { name: 'Лучшие результаты' })).toBeNull();
  });

  it('«Оценка по модулям» shows a band module by the band of its latest block (Р29, T-R7)', async () => {
    const repo = new MemoryRepository();
    const t = (h: number): string => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
    await repo.createSession(session('s1', t(30), { kind: 'training', endedAt: t(30) }));
    await repo.createSession(session('s2', t(2), { kind: 'free', endedAt: t(2) }));
    const szmrBlock = (id: string, sessionId: string, at: string, paramsJson: string, meanRt: number) =>
      block(id, sessionId, at, { module: 'szmr', lBefore: 9, lAfter: 9.5, paramsJson, summaryJson: JSON.stringify({ meanRt, counts: { miss: 0, late: 0 } }) });
    await repo.addBlock(szmrBlock('b0', 's1', t(30), '{"windowMs":500}', 380), [], []);
    await repo.addBlock(szmrBlock('b1', 's1', t(29), '{"band":1}', 400), [], []);
    await repo.addBlock(szmrBlock('b2', 's2', t(2), '{"band":2}', 455.4), [], []);
    await rebuildCaches(repo);
    await renderProgress(repo);
    const table = screen.getByRole('table', { name: 'Оценка по модулям' });
    const szmrRow = within(table).getAllByRole('row')[2] as HTMLElement;
    // Only band 2: neither the 380 of the old rows nor the 400 of band 1 is its best.
    expect(within(szmrRow).getAllByRole('cell').map((c) => c.textContent).slice(0, 3)).toEqual([
      'Сложная реакция (СЗМР)',
      '3 — формат теста (ур. 9,5; формат теста — 8)',
      '455\u00a0мс / 455\u00a0мс',
    ]);
  });

  it('a failing block history read shows the error and the retry, never a broken screen', async () => {
    const repo = new MemoryRepository();
    vi.spyOn(repo, 'listBlocks').mockRejectedValueOnce(new Error('база занята'));
    renderWithApp(<Progress onBack={vi.fn()} />, createFakePlatform({ repo }), repo);
    expect((await screen.findByRole('alert')).textContent).toContain('база занята');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('table', { name: 'Оценка по модулям' })).toBeTruthy();
    expect((await repo.listLog(10)).some((l) => l.message.includes('база занята'))).toBe(true);
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
