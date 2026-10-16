import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../../data/memoryRepository';
import { rebuildCaches } from '../../data/export';
import { block, session } from '../../data/repository.contract';
import { EMPTY_RESULTS, type DiagnosticResults } from '../../engine/diagnostic';
import { L_NORM } from '../../engine/planner';
import { MODULE_IDS, type ModuleId } from '../../engine/types';
import { createFakePlatform } from '../../testing/fakePlatform';
import { moduleTitles } from '../../modules/registry';
import { diagnosticCharts } from '../progressModel';
import { renderWithApp } from '../testUtils';
import Progress from './Progress';

const base: DiagnosticResults = {
  ...EMPTY_RESULTS,
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

describe('Progress: Горбов on one table after three (F10)', () => {
  it('names the three-table diagnostics under the Горбов chart; the other charts have no such line', async () => {
    const repo = new MemoryRepository();
    await seedDiagnostic(repo, 1, {});
    await seedDiagnostic(repo, 2, { gorbovOneTable: true, gorbov: { V: 40, P: 80, Pi: 20 } });
    await renderProgress(repo);
    const note = 'Диагностика №1 — на трёх разных таблицах (до 0.3.0). Тренд и полоса шума — только по диагностикам на одной таблице.';
    expect(within(chartOf('Таблица Горбова: V, P, Π, с')).getByText(note)).toBeTruthy();
    expect(within(chartOf('ПЗМР, медиана, мс')).queryByText(/на трёх разных таблицах/)).toBeNull();
    // One table for the three tasks: V, P and Π are named by the tasks.
    expect(screen.getByText('V — среднее время первых двух заданий, P — время третьего, Π — разница между третьим и суммой первых двух.')).toBeTruthy();
  });
});

describe('Progress: the index chart at the change of formats (T-R78)', () => {
  it('marks the first diagnostic of the 0.3.0 formats on the index chart and explains a dip there', async () => {
    const repo = new MemoryRepository();
    await seedDiagnostic(repo, 1, {});
    await seedDiagnostic(repo, 2, { gorbovOneTable: true, seriesForm: 'v2' });
    await renderProgress(repo);
    const card = chartOf('Общий индекс готовности');
    expect(within(card).getByText('0.3.0: новый формат')).toBeTruthy();
    expect(card.querySelector('line.chart-marker')).not.toBeNull();
    expect(
      within(card).getByText(
        'Диагностика №2 — первая в формате 0.3.0: Горбов на одной таблице, новые числовые ряды. Π и «Логика» с неё считаются от новой базы, поэтому индекс в этой точке может снизиться из-за смены формата.',
      ),
    ).toBeTruthy();
    // The other charts have no marker.
    expect(chartOf('ПЗМР, медиана, мс').querySelector('line.chart-marker')).toBeNull();
  });
});

describe('Progress: number series of the forms v2 after the old ones (F12)', () => {
  it('names the old diagnostics under the series chart; the other charts have no such line', async () => {
    const repo = new MemoryRepository();
    await seedDiagnostic(repo, 1, {});
    await seedDiagnostic(repo, 2, { seriesForm: 'v2', numseriesCorrect: 8 });
    await renderProgress(repo);
    const note = 'Диагностика №1 — с прежними задачами (до 0.3.0). Тренд и полоса шума — только по диагностикам с новыми задачами.';
    expect(within(chartOf('Числовые ряды, верно из 20')).getByText(note)).toBeTruthy();
    expect(within(chartOf('ПЗМР, медиана, мс')).queryByText(/с прежними задачами/)).toBeNull();
  });
});

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

  it('«Прерванные блоки по неделям»: eight weeks, newest first, with the columns of the reference (F11)', async () => {
    const repo = new MemoryRepository();
    // A moment ago: this week, whatever today is.
    const now = new Date(Date.now() - 1).toISOString();
    await repo.createSession(session('s', now, { endedAt: now }));
    const summaryJson = JSON.stringify({ discarded: { reason: 'user', progress: 0.45 }, restarts: [{ reason: 'user', progress: 0.1 }, { reason: 'focus_lost', progress: 0.3 }] });
    await repo.addBlock(block('x', 's', now, { flags: ['discarded'], score: 0, summaryJson }), [], []);
    await renderProgress(repo);
    const table = screen.getByRole('table', { name: 'Прерванные блоки по неделям' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Неделя',
      'Прервано вручную',
      'Из них засчитано как 0',
      'Из-за потери фокуса',
    ]);
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(rows).toHaveLength(8);
    expect(rows[0]?.[0]).toMatch(/^\d\d\.\d\d–\d\d\.\d\d$/);
    expect(rows.map((r) => r.slice(1))).toEqual([['2', '1', '1'], ...Array<string[]>(7).fill(['0', '0', '0'])]);
  });

  it('«РДО: смещение по скоростям за 28 дней»: the mean bias at each speed with its blocks (F14)', async () => {
    const repo = new MemoryRepository();
    const at = (h: number): string => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
    await repo.createSession(session('s', at(30), { endedAt: at(1) }));
    const rdo = (id: string, h: number, periodMs: number, meanSignedErrorMs: number): Promise<void> =>
      repo.addBlock(block(id, 's', at(h), { module: 'rdo', paramsJson: JSON.stringify({ periodMs }), summaryJson: JSON.stringify({ meanSignedErrorMs }) }), [], []);
    for (const [i, e] of [-20, -16, -12, -12, -10].entries()) await rdo(`a${String(i)}`, 20 - i, 1500, e);
    for (const [i, e] of [2, 4, 3, 3.4].entries()) await rdo(`b${String(i)}`, 10 - i, 3000, e);
    await rdo('c', 2, 4000, 11);
    await renderProgress(repo);
    const heading = screen.getByRole('heading', { name: 'РДО: смещение по скоростям за 28 дней' });
    expect(heading.closest('section')?.getAttribute('aria-labelledby')).toBe('levels-title');
    // Units stay with their numbers (T-R26).
    const NB = '\u00a0';
    expect(heading.nextElementSibling?.textContent).toBe(`1,5${NB}с: −14${NB}мс (5 блоков) · 2${NB}с: — · 3${NB}с: +3${NB}мс (4 блока) · 4${NB}с: +11${NB}мс (1 блок)`);
  });

  it('«РДО: смещение по скоростям» without РДО blocks: a dash at every speed', async () => {
    await renderProgress();
    const NB = '\u00a0';
    const heading = screen.getByRole('heading', { name: 'РДО: смещение по скоростям за 28 дней' });
    expect(heading.nextElementSibling?.textContent).toBe(`1,5${NB}с: — · 2${NB}с: — · 3${NB}с: — · 4${NB}с: —`);
  });

  describe('the cost of re-adaptation (F9)', () => {
    const at = (h: number): string => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
    /** A session whose СЗМР segment opens with a block marked readapt (s 0.8, median 400 ms), then two at 0.86 and 365 ms. */
    async function segment(repo: MemoryRepository, id: string, h: number): Promise<void> {
      await repo.createSession(session(id, at(h), { endedAt: at(h - 1) }));
      const played = [
        { score: 0.8, rts: [400], readapt: true },
        { score: 0.86, rts: [365] },
        { score: 0.86, rts: [360, 365, 370] },
      ];
      for (const [i, b] of played.entries()) {
        const summaryJson = JSON.stringify({ cleanHitRts: b.rts, ...(b.readapt === true ? { readapt: true } : {}) });
        await repo.addBlock(block(`${id}${String(i)}`, id, at(h - i / 10), { module: 'szmr', score: b.score, summaryJson }), [], []);
      }
    }

    it('three СЗМР segments in 28 days: the line by module, units kept with their numbers', async () => {
      const repo = new MemoryRepository();
      for (const [id, h] of [['a', 100], ['b', 50], ['c', 10]] as const) await segment(repo, id, h);
      await renderProgress(repo);
      const shown = screen.getByText(/после смены клавиш/);
      expect(shown.textContent).toBe('Сложная реакция (СЗМР) — после смены клавиш: точность −6\u00a0%, время +35\u00a0мс в первом блоке');
      expect(shown.closest('section')?.getAttribute('aria-labelledby')).toBe('levels-title');
    });

    it('two segments: no line', async () => {
      const repo = new MemoryRepository();
      for (const [id, h] of [['a', 100], ['b', 50]] as const) await segment(repo, id, h);
      await renderProgress(repo);
      expect(screen.queryByText(/после смены клавиш/)).toBeNull();
    });
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
    // …and the form-of-day chart and the index chart.
    expect(screen.getAllByText('Нет данных')).toHaveLength(diagnosticCharts([]).length + levelModules + 2);
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
    expect(card.querySelector('p.muted.chart-note')).toBeNull();
  });

  it('«Форма дня» names the days of another warm-up band under the chart (T-R78)', async () => {
    const repo = new MemoryRepository();
    const day = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();
    // Three days ago the warm-up played L 3 (band 0), yesterday L 8 (band 2).
    for (const [d, lBefore] of [[3, 3], [1, 8]] as const) {
      await repo.createSession(session(`s${String(d)}`, day(d), { endedAt: day(d) }));
      await repo.addBlock(
        block(`w${String(d)}`, `s${String(d)}`, day(d), { lBefore, lAfter: lBefore, flags: ['warmup'], summaryJson: JSON.stringify({ cleanHitRts: [300] }) }),
        [],
        [],
      );
    }
    await renderProgress(repo);
    const card = chartOf('Разминка ПЗМР: медиана по дням, мс');
    const marked = new Date(Date.now() - 3 * 86_400_000);
    const label = `${String(marked.getDate()).padStart(2, '0')}.${String(marked.getMonth() + 1).padStart(2, '0')}`;
    expect(card.querySelector('p.muted.chart-note')?.textContent).toBe(
      `Разминка ${label} — на другой нагрузке. Тренд и полоса шума — только по разминкам на текущей нагрузке.`,
    );
    expect(card.querySelector('p.chart-trend')?.textContent).toBe('Полоса шума и тренд появятся после 3 дней разминки на текущей нагрузке.');
    expect([...card.querySelectorAll('circle title')].map((t) => t.textContent)).toEqual([`${label}: 300 (другая нагрузка)`, expect.stringMatching(/^\d\d\.\d\d: 300$/)]);
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

  it('the РДО note under «Лучшие результаты» shows only when there is an РДО row (T-R54)', async () => {
    const repo = new MemoryRepository();
    const at = new Date(Date.now() - 86_400_000).toISOString();
    await repo.createSession(session('a', at, { endedAt: at }));
    const summaryJson = JSON.stringify({ testFormat: { mean: 262, sd: 31, errors: 1, falseStarts: 0, thirds: [262, 262, 262] } });
    await repo.addBlock(block('a', 'a', at, { module: 'pzmr', flags: ['test_format'], summaryJson }), [], []);
    await renderProgress(repo);
    const table = screen.getByRole('table', { name: 'Лучшие результаты' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    // Nor the note on dropped frames without such a run.
    expect(table.nextElementSibling).toBeNull();
    expect(screen.queryByText('У РДО в колонке «Среднее» — среднее отклонение от отметки.')).toBeNull();
  });

  it('a run with dropped frames is named under its charts, left out of the best and noted under the table (T-R78)', async () => {
    const repo = new MemoryRepository();
    const day = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();
    const summaryJson = (mean: number): string => JSON.stringify({ testFormat: { mean, sd: 30, errors: 1, falseStarts: 0, thirds: [mean, mean, mean] } });
    for (const [id, d, module, flags, mean] of [
      ['a', 3, 'pzmr', ['test_format'], 262],
      ['b', 1, 'pzmr', ['test_format', 'timing_unreliable'], 200],
      ['c', 2, 'szmr', ['test_format', 'timing_unreliable'], 400],
    ] as const) {
      await repo.createSession(session(id, day(d), { endedAt: day(d) }));
      await repo.addBlock(block(id, id, day(d), { module, flags: [...flags], summaryJson: summaryJson(mean) }), [], []);
    }
    await renderProgress(repo);
    const dm = (d: number): string => {
      const t = new Date(Date.now() - d * 86_400_000);
      return `${String(t.getDate()).padStart(2, '0')}.${String(t.getMonth() + 1).padStart(2, '0')}`;
    };
    for (const title of ['ПЗМР: среднее, мс', 'ПЗМР: SD, мс']) {
      expect(within(chartOf(title)).getByText(`Замер ненадёжен (пропуски кадров): ${dm(1)}`)).toBeTruthy();
    }
    expect(within(chartOf('СЗМР: среднее, мс')).getByText(`Замер ненадёжен (пропуски кадров): ${dm(2)}`)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Лучшие результаты' });
    const rows = within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    // The best of ПЗМР is the run without dropped frames; СЗМР has none, but its run is counted.
    expect(rows).toEqual([
      ['ПЗМР', '262\u00a0мс', '30\u00a0мс', '1', '0', '2'],
      ['СЗМР', '—', '—', '—', '—', '1'],
    ]);
    expect(table.nextElementSibling?.textContent).toBe('Прогоны с пропусками кадров не входят в лучший результат.');
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

describe('Progress: noise band and trend (F7)', () => {
  /** Diagnostics a week apart, the ПЗМР median of each as given. */
  async function weekly(repo: MemoryRepository, medians: readonly number[]): Promise<void> {
    for (const [i, pzmrMedianRt] of medians.entries()) {
      const at = new Date(2026, 6, 1 + 7 * i, 10).toISOString();
      await repo.createSession(session(`diag-${String(i)}`, at, { kind: 'diagnostic', endedAt: at }));
      await repo.addDiagnostic({ id: `d${String(i)}`, sessionId: `diag-${String(i)}`, number: i + 1, at, resultsJson: JSON.stringify({ ...base, pzmrMedianRt }) });
    }
  }

  it('under a chart: the trend line with its noise band; Горбов has a line per series', async () => {
    const repo = new MemoryRepository();
    await weekly(repo, [300, 298, 295, 292, 290, 288]);
    await renderProgress(repo);
    const card = chartOf('ПЗМР, медиана, мс');
    // A number keeps its unit on its line (T-R26).
    expect(card.querySelector('p.chart-trend')?.textContent).toBe('Тренд: −12\u00a0мс за 5 недель — лучше (шум ±3\u00a0мс)');
    expect(card.querySelectorAll('polygon.chart-band')).toHaveLength(1);
    const gorbov = chartOf('Таблица Горбова: V, P, Π, с');
    expect([...gorbov.querySelectorAll('p.chart-trend')].map((p) => p.textContent)).toEqual([
      'V: тренд 0\u00a0с за 5 недель — в пределах шума (шум ±0,0\u00a0с)',
      'P: тренд 0\u00a0с за 5 недель — в пределах шума (шум ±0,0\u00a0с)',
      'Π: тренд 0\u00a0с за 5 недель — в пределах шума (шум ±0,0\u00a0с)',
    ]);
    expect(gorbov.querySelectorAll('polygon.chart-band')).toHaveLength(3);
  });

  it('the index chart comes first among the diagnostics, with its trend', async () => {
    const repo = new MemoryRepository();
    await weekly(repo, [300, 298, 295]);
    await renderProgress(repo);
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    const at = headings.indexOf('Контрольные диагностики');
    expect(headings[at + 1]).toBe('Общий индекс готовности');
    const card = chartOf('Общий индекс готовности');
    expect(card.closest('section')?.getAttribute('aria-labelledby')).toBe('diagnostics-title');
    expect(within(card).getByText('больше — лучше')).toBeTruthy();
    expect(card.querySelectorAll('circle')).toHaveLength(3);
    expect(card.querySelectorAll('p.chart-trend')).toHaveLength(1);
    expect(card.querySelector('p.chart-trend')?.textContent).toMatch(/^Тренд: [+−]?\d+ за 2 недели — /);
  });

  it('with fewer than 3 points the line says when the band comes, once per chart; an empty chart has none', async () => {
    const repo = new MemoryRepository();
    await weekly(repo, [300, 298]);
    await renderProgress(repo);
    expect([...chartOf('ПЗМР, медиана, мс').querySelectorAll('p.chart-trend')].map((p) => p.textContent)).toEqual([
      'Полоса шума и тренд появятся после 3 точек.',
    ]);
    // Three short series, one line, which counts diagnostics on one table (T-R62).
    expect([...chartOf('Таблица Горбова: V, P, Π, с').querySelectorAll('p.chart-trend')].map((p) => p.textContent)).toEqual([
      'Полоса шума и тренд появятся после 3 диагностик на одной таблице.',
    ]);
    expect(chartOf('ПЗМР, медиана, мс').querySelector('polygon')).toBeNull();
    // No warm-ups: «Нет данных», no trend line.
    expect(chartOf('Разминка ПЗМР: медиана по дням, мс').querySelector('p.chart-trend')).toBeNull();
  });

  it('the run charts and the form of the day have their trend lines', async () => {
    const repo = new MemoryRepository();
    const day = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();
    const run = (mean: number): string => JSON.stringify({ testFormat: { mean, sd: 30, errors: 0, falseStarts: 0, thirds: [mean, mean, mean] } });
    for (const [d, mean] of [[22, 300], [15, 298], [8, 295], [1, 292]] as const) {
      await repo.createSession(session(`s${String(d)}`, day(d), { endedAt: day(d) }));
      await repo.addBlock(block(`r${String(d)}`, `s${String(d)}`, day(d), { module: 'szmr', flags: ['test_format'], summaryJson: run(mean) }), [], []);
      await repo.addBlock(block(`w${String(d)}`, `s${String(d)}`, day(d), { flags: ['warmup'], summaryJson: JSON.stringify({ cleanHitRts: [mean] }) }), [], []);
    }
    await renderProgress(repo);
    for (const title of ['СЗМР: среднее, мс', 'Разминка ПЗМР: медиана по дням, мс']) {
      const card = chartOf(title);
      expect(card.querySelector('p.chart-trend')?.textContent).toMatch(/^Тренд: −\d+\u00a0мс за 3 недели — /);
      expect(card.querySelectorAll('polygon.chart-band')).toHaveLength(1);
    }
    expect(chartOf('СЗМР: SD, мс').querySelector('p.chart-trend')?.textContent).toBe('Тренд: 0\u00a0мс за 3 недели — в пределах шума (шум ±0\u00a0мс)');
  });
});
