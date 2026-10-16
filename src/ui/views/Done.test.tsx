import { cleanup, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_RESULTS, parseResults, type DiagnosticResults } from '../../engine/diagnostic';
import { conditionLines, type BlockSummaryView, type DiagnosticComparison } from '../../session/steps';
import Done from './Done';

const RESULTS: DiagnosticResults = {
  ...EMPTY_RESULTS,
  pzmrMedianRt: 251.4,
  pzmrMeanRt: 262.4,
  szmrMedianRt: 402,
  szmrMeanRt: 401.6,
  gonogoScore: 93.3,
  rdoMeanAbsErrorMs: 18.6,
  gorbov: { V: 41.25, P: 70.5, Pi: -12 },
  numseriesCorrect: 14,
  pomehQuietRt: 300,
  pomehNoisyRt: 335.2,
  pomehDeltaMs: 35.2,
  stroopCongruentRt: 520,
  stroopIncongruentRt: 610,
  stroopInterferenceMs: 90,
  switchRepeatRt: 600,
  switchSwitchRt: 588,
  switchCostMs: -12,
  memorySpan: 7,
  // A row like one stored before F7: no spread or error counts.
  pzmrSdRt: null,
  szmrSdRt: null,
  pzmrIqrRt: null,
  szmrIqrRt: null,
  pzmrFalseStarts: null,
  szmrFalseStarts: null,
  szmrWrong: null,
  gonogoCommissions: null,
  gonogoOmissions: null,
  rdoEarly: null,
  rdoLate: null,
  rdoSignedBiasMs: null,
  unreliable: [],
  gorbovOneTable: true,
  seriesForm: 'v2',
};

/** The F7 values (Справочник F7). */
const F7 = {
  pzmrSdRt: 38.4,
  pzmrIqrRt: 41.2,
  pzmrFalseStarts: 1,
  szmrSdRt: 51.6,
  szmrIqrRt: 60,
  szmrFalseStarts: 0,
  szmrWrong: 2,
  gonogoCommissions: 3,
  gonogoOmissions: 1,
  rdoEarly: 12,
  rdoLate: 9,
  rdoSignedBiasMs: -6.2,
};

const PREVIOUS: DiagnosticResults = {
  ...RESULTS,
  pzmrMedianRt: 263.6,
  pzmrMeanRt: null,
  szmrMedianRt: 398,
  szmrMeanRt: null,
  gonogoScore: 90,
  rdoMeanAbsErrorMs: 25,
  gorbov: { V: 45, P: 70, Pi: -10 },
  numseriesCorrect: 12,
  stroopCongruentRt: 500,
  stroopIncongruentRt: 600,
  stroopInterferenceMs: 100,
  switchRepeatRt: null,
  switchSwitchRt: null,
  switchCostMs: null,
};

const PAST = { number: 3, at: '2026-10-12T09:00:00', metrics: PREVIOUS };

const WITH_PREVIOUS: DiagnosticComparison = {
  previous: PAST,
  readiness: 72.4,
  readinessPrevious: 65.2,
  earlierUnreadable: false,
};

function view(over: Partial<BlockSummaryView>): BlockSummaryView {
  return { module: 'pzmr', title: 'ПЗМР', lBefore: 0, lAfter: 0, changes: [], score: 1, lines: [], flags: [], showLevel: true, levelNote: null, ...over };
}

function headers(): string[] {
  const table = screen.getByRole('table', { name: 'Результаты диагностики' });
  return within(table)
    .getAllByRole('columnheader')
    .map((th) => th.textContent);
}

/** The cells as rendered: numbers keep their units with a no-break space (A-R22). */
function rawCells(): string[][] {
  const table = screen.getByRole('table', { name: 'Результаты диагностики' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell').map((td) => td.textContent));
}

/** The cells with plain spaces, as the tests write them, without the last column «Перезапуск» (restartCells reads it). */
function cells(): string[][] {
  return rawCells().map((r) => r.slice(0, -1).map((text) => text.replaceAll('\u00a0', ' ')));
}

/** The column «Перезапуск», row by row. */
function restartCells(): string[] {
  return rawCells().map((r) => r.at(-1) ?? '');
}

describe('Done', () => {
  it('lists the twelve diagnostic results, the W2 ones after the number series', () => {
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    expect(cells()).toEqual([
      ['ПЗМР — медиана времени реакции', '251 мс', 'по среднему 262 мс: средний'],
      ['Сложная реакция (СЗМР) — медиана времени реакции', '402 мс', 'по среднему 402 мс: ниже среднего'],
      ['Go/No-Go — верные ответы', '93 %', '—'],
      ['Реакция на движущийся объект — средняя ошибка по модулю', '19 мс', '—'],
      ['Горбов — V, среднее время 1-й и 2-й таблиц', '41,3 с', 'средний'],
      ['Горбов — P, время 3-й таблицы', '70,5 с', 'высокий'],
      ['Горбов — Π, переключение внимания', '−12,0 с', '—'],
      ['Числовые ряды — решено верно', '14 из 20', '—'],
      ['Помехоустойчивость — разница с помехами и без', '+35 мс', '—'],
      ['Струп — интерференция', '+90 мс', '—'],
      ['Переключение правил — цена переключения', '−12 мс', '—'],
      ['Память — объём', '7', 'средний'],
    ]);
  });

  it('«Перезапуск» is the last column: «да» for a restart with Esc, «фокус» for one after a focus loss (Р22, T-R57)', () => {
    const restarts = {
      pzmr: { user: 1, focus: 0 },
      gorbov: { user: 1, focus: 2 },
      szmr: { user: 0, focus: 3 },
      gonogo: { user: 0, focus: 1 },
      memory: { user: 2, focus: 1 },
      rdo: { user: 0, focus: 0 },
    };
    render(<Done diagnostic={{ ...RESULTS, restarts }} seriesTotal={20} summaries={[]} comparison={WITH_PREVIOUS} onHome={vi.fn()} />);
    expect(headers().at(-1)).toBe('Перезапуск');
    // Горбов: its three rows.
    expect(restartCells()).toEqual(['да', 'фокус ×3', 'фокус', '—', 'да; фокус ×2', 'да; фокус ×2', 'да; фокус ×2', '—', '—', '—', '—', 'да; фокус']);
  });

  it('«Перезапуск» reads «—» everywhere without restarts (a diagnostic stored before F11)', () => {
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    expect(restartCells()).toEqual(Array<string>(12).fill('—'));
  });

  it('«Подробности диагностики»: spread and errors as lines under the table, which keeps its twelve rows (F7, Р20)', () => {
    render(<Done diagnostic={{ ...RESULTS, ...F7 }} seriesTotal={20} summaries={[]} comparison={WITH_PREVIOUS} onHome={vi.fn()} />);
    expect(cells()).toHaveLength(12);
    const list = screen.getByRole('list', { name: 'Подробности диагностики' });
    const items = within(list).getAllByRole('listitem').map((li) => li.textContent);
    expect(items.map((t) => t.replaceAll('\u00a0', ' '))).toEqual([
      'ПЗМР: разброс (SD) 38 мс, IQR 41 мс, фальстарты 1',
      'СЗМР: разброс (SD) 52 мс, IQR 60 мс, фальстарты 0, неверная клавиша 2',
      'Go/No-Go: нажатия на no-go 3, пропуски 1',
      'РДО: рано 12, поздно 9, смещение −6 мс (раньше отметки)',
    ]);
    // A number keeps its unit (T-R26).
    expect(items[0]).toBe('ПЗМР: разброс (SD) 38\u00a0мс, IQR 41\u00a0мс, фальстарты 1');
    const table = screen.getByRole('table', { name: 'Результаты диагностики' });
    expect(table.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no «Подробности диагностики» when every F7 value is missing (a row stored before F7)', () => {
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={WITH_PREVIOUS} onHome={vi.fn()} />);
    expect(screen.queryByRole('list', { name: 'Подробности диагностики' })).toBeNull();
  });

  it('with a previous diagnostic: Прошлая, Изменение, Ориентир', () => {
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={WITH_PREVIOUS} onHome={vi.fn()} />);
    expect(headers()).toEqual(['Показатель', 'Результат', 'Прошлая (№3, 12.10.2026)', 'Изменение', 'Ориентир', 'Перезапуск']);
    expect(cells()).toEqual([
      ['ПЗМР — медиана времени реакции', '251 мс', '264 мс', '−13 мс, лучше', 'по среднему 262 мс: средний'],
      ['Сложная реакция (СЗМР) — медиана времени реакции', '402 мс', '398 мс', 'без изменений', 'по среднему 402 мс: ниже среднего'],
      ['Go/No-Go — верные ответы', '93 %', '90 %', '+3 %, лучше', '—'],
      ['Реакция на движущийся объект — средняя ошибка по модулю', '19 мс', '25 мс', '−6 мс, лучше', '—'],
      ['Горбов — V, среднее время 1-й и 2-й таблиц', '41,3 с', '45,0 с', '−3,7 с, лучше', 'средний'],
      ['Горбов — P, время 3-й таблицы', '70,5 с', '70,0 с', 'без изменений', 'высокий'],
      ['Горбов — Π, переключение внимания', '−12,0 с', '−10,0 с', '−2,0 с, лучше', '—'],
      ['Числовые ряды — решено верно', '14 из 20', '12 из 20', '+2, лучше', '—'],
      ['Помехоустойчивость — разница с помехами и без', '+35 мс', '+35 мс', 'без изменений', '—'],
      ['Струп — интерференция', '+90 мс', '+100 мс', '−10 мс, лучше', '—'],
      ['Переключение правил — цена переключения', '−12 мс', 'нет данных', '—', '—'],
      ['Память — объём', '7', '7', 'без изменений', 'средний'],
    ]);
    expect(screen.getByText('Индекс: 72 (прошлый — 65)')).toBeTruthy();
    expect(screen.queryByText(/Первая диагностика/)).toBeNull();
  });

  it('a diagnostic played on the mouse: no reference band for ПЗМР and СЗМР, their norms assume a keyboard (T-R23)', () => {
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} layout="mouse" onHome={vi.fn()} />);
    expect(cells().map((r) => r.at(-1))).toEqual(['—', '—', '—', '—', 'средний', 'высокий', '—', '—', '—', '—', '—', 'средний']);
  });

  it('a previous diagnostic on three tables: its Горбов values are marked and not compared (F10, Р25)', () => {
    const previous = { ...PAST, metrics: { ...PREVIOUS, gorbovOneTable: false } };
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={{ ...WITH_PREVIOUS, previous }} onHome={vi.fn()} />);
    const rows = cells();
    expect(rows.slice(4, 7)).toEqual([
      ['Горбов — V, среднее время 1-й и 2-й таблиц', '41,3 с', '45,0 с (3 разные таблицы, до 0.3.0)', 'несравнимо: формат изменён в 0.3.0', 'средний'],
      ['Горбов — P, время 3-й таблицы', '70,5 с', '70,0 с (3 разные таблицы, до 0.3.0)', 'несравнимо: формат изменён в 0.3.0', 'высокий'],
      ['Горбов — Π, переключение внимания', '−12,0 с', '−10,0 с (3 разные таблицы, до 0.3.0)', 'несравнимо: формат изменён в 0.3.0', '—'],
    ]);
    // The other rows compare as before.
    expect(rows[0]?.slice(2, 4)).toEqual(['264 мс', '−13 мс, лучше']);
    expect(screen.getByText('Горбов: первая диагностика на одной таблице — сравнение с прошлыми условное.')).toBeTruthy();
  });

  it('a previous diagnostic of the old number series: the change says the format changed (F12, Р25)', () => {
    const previous = { ...PAST, metrics: { ...PREVIOUS, seriesForm: null } };
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={{ ...WITH_PREVIOUS, previous }} onHome={vi.fn()} />);
    const rows = cells();
    expect(rows[7]).toEqual(['Числовые ряды — решено верно', '14 из 20', '12 из 20', 'несравнимо: формат изменён в 0.3.0', '—']);
    // The Горбов rows of the same format and the other rows compare as before.
    expect(rows[4]?.slice(2, 4)).toEqual(['45,0 с', '−3,7 с, лучше']);
    expect(rows[0]?.slice(2, 4)).toEqual(['264 мс', '−13 мс, лучше']);
    expect(screen.queryByText(/первая диагностика на одной таблице/)).toBeNull();
    // A previous result without a series value has no change, whatever its format.
    cleanup();
    const missing = { ...PAST, metrics: { ...PREVIOUS, seriesForm: null, numseriesCorrect: null } };
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={{ ...WITH_PREVIOUS, previous: missing }} onHome={vi.fn()} />);
    expect(cells()[7]?.slice(2, 4)).toEqual(['нет данных', '—']);
  });

  it('no Горбов note when the previous diagnostic had no Горбов result or played one table too (F10)', () => {
    const noGorbov = { ...PAST, metrics: { ...PREVIOUS, gorbovOneTable: false, gorbov: null } };
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={{ ...WITH_PREVIOUS, previous: noGorbov }} onHome={vi.fn()} />);
    expect(cells()[4]?.slice(2, 4)).toEqual(['нет данных', '—']);
    expect(screen.queryByText(/первая диагностика на одной таблице/)).toBeNull();
    cleanup();
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={WITH_PREVIOUS} onHome={vi.fn()} />);
    expect(cells()[4]?.slice(2, 4)).toEqual(['45,0 с', '−3,7 с, лучше']);
    expect(screen.queryByText(/первая диагностика на одной таблице/)).toBeNull();
    // A diagnostic without a Горбов result of its own says nothing either.
    cleanup();
    const previous = { ...PAST, metrics: { ...PREVIOUS, gorbovOneTable: false } };
    render(<Done diagnostic={{ ...RESULTS, gorbov: null }} seriesTotal={20} summaries={[]} comparison={{ ...WITH_PREVIOUS, previous }} onHome={vi.fn()} />);
    expect(screen.queryByText(/первая диагностика на одной таблице/)).toBeNull();
    expect(cells()[4]?.slice(1, 4)).toEqual(['нет данных', '45,0 с (3 разные таблицы, до 0.3.0)', '—']);
  });

  it('the first diagnostic says there is nothing to compare with', () => {
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={{ previous: null, readiness: 60, readinessPrevious: null, earlierUnreadable: false }} onHome={vi.fn()} />);
    expect(screen.getByText('Первая диагностика — сравнивать пока не с чем')).toBeTruthy();
    expect(screen.getByText('Индекс: 60')).toBeTruthy();
    expect(headers()).toEqual(['Показатель', 'Результат', 'Ориентир', 'Перезапуск']);
    expect(cells()[0]).toEqual(['ПЗМР — медиана времени реакции', '251 мс', 'по среднему 262 мс: средний']);
  });

  it('diagnostic №N > 1 whose earlier diagnostics cannot be read says so, not «Первая диагностика» (FW10)', () => {
    const comparison = { previous: null, readiness: 60, readinessPrevious: null, earlierUnreadable: true };
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={comparison} onHome={vi.fn()} />);
    expect(screen.getByText('Прошлые диагностики не прочитаны — сравнивать не с чем.')).toBeTruthy();
    expect(screen.queryByText(/Первая диагностика/)).toBeNull();
    expect(headers()).toEqual(['Показатель', 'Результат', 'Ориентир', 'Перезапуск']);
    expect(screen.getByText('Индекс: 60')).toBeTruthy();
  });

  it('a previous value that is missing reads «нет данных» and has no change', () => {
    render(
      <Done diagnostic={{ ...RESULTS, pzmrMeanRt: null }} seriesTotal={20} summaries={[]} comparison={WITH_PREVIOUS} onHome={vi.fn()} />,
    );
    const rows = cells();
    expect(rows.find(([name]) => name?.startsWith('Переключение правил') === true)).toEqual([
      'Переключение правил — цена переключения',
      '−12 мс',
      'нет данных',
      '—',
      '—',
    ]);
    // No mean RT (a diagnostic before 0.3.0 has none): no reference band.
    expect(rows[0]).toEqual(['ПЗМР — медиана времени реакции', '251 мс', '264 мс', '−13 мс, лучше', '—']);
  });

  it('a damaged previous diagnostic reads «нет данных» where it is damaged, never a broken screen (FW9)', () => {
    const metrics = parseResults({ resultsJson: '{"gorbov":{"V":40},"pzmrMedianRt":"281","szmrMedianRt":398}' });
    if (metrics === null) throw new Error('the damaged row is still an object');
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={{ ...WITH_PREVIOUS, previous: { ...PAST, metrics } }} onHome={vi.fn()} />);
    const rows = cells();
    expect(rows[0]).toEqual(['ПЗМР — медиана времени реакции', '251 мс', 'нет данных', '—', 'по среднему 262 мс: средний']);
    expect(rows[1]?.slice(1, 4)).toEqual(['402 мс', '398 мс', 'без изменений']);
    expect(rows.slice(4, 7).map((r) => r.slice(2, 4))).toEqual([
      ['нет данных', '—'],
      ['нет данных', '—'],
      ['нет данных', '—'],
    ]);
  });

  it('a current value that is missing has no change either', () => {
    render(<Done diagnostic={{ ...RESULTS, memorySpan: null }} seriesTotal={20} summaries={[]} comparison={WITH_PREVIOUS} onHome={vi.fn()} />);
    expect(cells().at(-1)).toEqual(['Память — объём', 'нет данных', '7', '—', '—']);
  });

  it('the previous column marks the values of its own unreliable measurements (I1)', () => {
    const previous = { ...PAST, metrics: { ...PREVIOUS, unreliable: ['pzmr' as const] } };
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={{ ...WITH_PREVIOUS, previous }} onHome={vi.fn()} />);
    expect(cells()[0]?.slice(1, 3)).toEqual(['251 мс', '264 мс, замер ненадёжен']);
  });

  it('no index line without a readiness; the previous one is left out when missing', () => {
    const { rerender } = render(
      <Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={{ ...WITH_PREVIOUS, readiness: null }} onHome={vi.fn()} />,
    );
    expect(screen.queryByText(/Индекс:/)).toBeNull();
    rerender(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={{ ...WITH_PREVIOUS, readinessPrevious: null }} onHome={vi.fn()} />);
    expect(screen.getByText('Индекс: 72')).toBeTruthy();
  });

  it('without a comparison: result and reference only, no index line', () => {
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={null} onHome={vi.fn()} />);
    expect(headers()).toEqual(['Показатель', 'Результат', 'Ориентир', 'Перезапуск']);
    expect(screen.queryByText(/Индекс:/)).toBeNull();
    expect(screen.queryByText(/Первая диагностика/)).toBeNull();
  });

  it('a number never breaks from its unit in a comparison cell (A-R22)', () => {
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={WITH_PREVIOUS} onHome={vi.fn()} />);
    const rows = rawCells();
    expect(rows[0]).toEqual(['ПЗМР — медиана времени реакции', '251\u00a0мс', '264\u00a0мс', '−13\u00a0мс, лучше', 'по среднему 262\u00a0мс: средний', '—']);
    expect(rows[4]?.slice(1)).toEqual(['41,3\u00a0с', '45,0\u00a0с', '−3,7\u00a0с, лучше', 'средний', '—']);
    expect(rows[2]?.slice(1, 4)).toEqual(['93\u00a0%', '90\u00a0%', '+3\u00a0%, лучше']);
  });

  it('only the number columns are right-aligned, not the text ones (A-R12)', () => {
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} comparison={WITH_PREVIOUS} onHome={vi.fn()} />);
    const table = screen.getByRole('table', { name: 'Результаты диагностики' });
    const first = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(within(first).getAllByRole('cell').map((td) => td.classList.contains('num'))).toEqual([false, true, true, false, false, false]);
    expect(within(table).getAllByRole('columnheader').map((th) => th.classList.contains('num'))).toEqual([false, true, true, false, false, false]);
  });

  it('a difference reads as in the block summary: from the rounded medians (B9)', () => {
    // 610 − 520,5 = 89,5: the stored cost rounds to 90, the summary read 521 and 610, so +89.
    const results = { ...RESULTS, stroopCongruentRt: 520.5, stroopIncongruentRt: 610, stroopInterferenceMs: 89.5 };
    render(<Done diagnostic={results} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    const stroopRow = cells().find(([name]) => name === 'Струп — интерференция');
    const summary = conditionLines('stroop', {
      congruent: { n: 8, errors: 0, medianRt: 520.5 },
      incongruent: { n: 12, errors: 0, medianRt: 610 },
    });
    expect(summary.at(-1)).toBe('Интерференция: +89 мс');
    expect(stroopRow?.[1]).toBe('+89 мс');
  });

  it('a difference falls back to the stored cost when a median is missing (B9)', () => {
    render(<Done diagnostic={{ ...RESULTS, pomehQuietRt: null, pomehDeltaMs: 35.6 }} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    expect(cells().find(([name]) => name?.startsWith('Помехоустойчивость') === true)?.[1]).toBe('+36 мс');
  });

  it('a 0.1.0-style result has no W2 values: «нет данных», never zero', () => {
    const w1 = {
      ...RESULTS,
      pomehQuietRt: null,
      pomehNoisyRt: null,
      pomehDeltaMs: null,
      stroopCongruentRt: null,
      stroopIncongruentRt: null,
      stroopInterferenceMs: null,
      switchRepeatRt: null,
      switchSwitchRt: null,
      switchCostMs: null,
      memorySpan: null,
      unreliable: ['stroop' as const],
    };
    render(<Done diagnostic={w1} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    expect(cells().slice(8).map((r) => r[1])).toEqual(['нет данных', 'нет данных', 'нет данных', 'нет данных']);
  });

  it('marks the W2 differences measured with dropped frames; a zero difference reads «0 мс»', () => {
    render(<Done diagnostic={{ ...RESULTS, stroopCongruentRt: 600, stroopIncongruentRt: 600, stroopInterferenceMs: 0, unreliable: ['pomeh', 'stroop', 'taskswitch'] }} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    expect(cells().slice(8)).toEqual([
      ['Помехоустойчивость — разница с помехами и без', '+35 мс, замер ненадёжен', '—'],
      ['Струп — интерференция', '0 мс, замер ненадёжен', '—'],
      ['Переключение правил — цена переключения', '−12 мс, замер ненадёжен', '—'],
      ['Память — объём', '7', 'средний'],
    ]);
  });

  it('marks the metrics of modules measured with dropped frames and says the index uses them (I1)', () => {
    render(<Done diagnostic={{ ...RESULTS, unreliable: ['pzmr', 'rdo'] }} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    const rows = cells();
    expect(rows[0]).toEqual(['ПЗМР — медиана времени реакции', '251 мс, замер ненадёжен', 'по среднему 262 мс: средний']);
    expect(rows[1]?.[1]).toBe('402 мс');
    expect(rows[3]).toEqual(['Реакция на движущийся объект — средняя ошибка по модулю', '19 мс, замер ненадёжен', '—']);
    expect(screen.getByText(/Замер ненадёжен: в блоке были пропуски кадров и после повтора/)).toBeTruthy();
  });

  it('no mark and no note when every measurement was reliable', () => {
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    expect(screen.queryByText(/замер ненадёжен/i)).toBeNull();
  });

  it('says when the new parts of this diagnostic count in the readiness index (W2-R31)', () => {
    const { rerender } = render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} indexDeferred onHome={vi.fn()} />);
    expect(screen.getByText('Новые показатели войдут в индекс со следующей диагностики.')).toBeTruthy();
    rerender(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    expect(screen.queryByText(/войдут в индекс/)).toBeNull();
  });

  it('diagnostic blocks list no levels (M5); training blocks do', () => {
    const { rerender } = render(
      <Done
        diagnostic={RESULTS}
        seriesTotal={20}
        summaries={[view({ showLevel: false }), view({ module: 'numseries', title: 'Числовые ряды', showLevel: false })]}
        onHome={vi.fn()}
      />,
    );
    expect(screen.getByText('ПЗМР: блоков 1')).toBeTruthy();
    expect(screen.getByText('Числовые ряды: блоков 1')).toBeTruthy();
    expect(screen.queryByText(/уровень/)).toBeNull();
    rerender(<Done diagnostic={null} seriesTotal={null} summaries={[view({ lBefore: 2, lAfter: 3.5 })]} onHome={vi.fn()} />);
    expect(screen.getByText('ПЗМР: блоков 1, уровень 2,0 → 3,5')).toBeTruthy();
  });

  it('overload blocks count as blocks but not in the level change', () => {
    render(
      <Done
        diagnostic={null}
        seriesTotal={null}
        summaries={[
          view({ lBefore: 8, lAfter: 9 }),
          view({ lBefore: 12, lAfter: 14, flags: ['overload'] }),
          view({ lBefore: 9, lAfter: 10 }),
          view({ lBefore: 13, lAfter: 15, flags: ['overload'] }),
          view({ module: 'szmr', title: 'СЗМР', lBefore: 13, lAfter: 14, flags: ['overload'] }),
        ]}
        onHome={vi.fn()}
      />,
    );
    expect(screen.getByText('ПЗМР: блоков 4, уровень 8,0 → 10,0')).toBeTruthy();
    // A finisher module has only overload blocks: no level change to report.
    expect(screen.getByText('СЗМР: блоков 1')).toBeTruthy();
  });
});
