import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticResults } from '../../engine/diagnostic';
import type { BlockSummaryView } from '../../session/steps';
import Done from './Done';

const RESULTS: DiagnosticResults = {
  pzmrMedianRt: 251.4,
  szmrMedianRt: 402,
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
  unreliable: [],
};

function view(over: Partial<BlockSummaryView>): BlockSummaryView {
  return { module: 'pzmr', title: 'ПЗМР', lBefore: 0, lAfter: 0, changes: [], score: 1, lines: [], flags: [], showLevel: true, ...over };
}

function cells(): string[][] {
  const table = screen.getByRole('table', { name: 'Результаты диагностики' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell').map((td) => td.textContent));
}

describe('Done', () => {
  it('lists the twelve diagnostic results, the W2 ones after the number series', () => {
    render(<Done diagnostic={RESULTS} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    expect(cells()).toEqual([
      ['ПЗМР — медиана времени реакции', '251 мс'],
      ['Сложная реакция (СЗМР) — медиана времени реакции', '402 мс'],
      ['Go/No-Go — верные ответы', '93 %'],
      ['Реакция на движущийся объект — средняя ошибка', '19 мс'],
      ['Горбов — V, среднее время 1-й и 2-й таблиц', '41,3 с'],
      ['Горбов — P, время 3-й таблицы', '70,5 с'],
      ['Горбов — Π, переключение внимания', '−12,0 с'],
      ['Числовые ряды — решено верно', '14 из 20'],
      ['Помехоустойчивость — разница с помехами и без', '+35 мс'],
      ['Струп — интерференция', '+90 мс'],
      ['Переключение правил — цена переключения', '−12 мс'],
      ['Память — объём', '7'],
    ]);
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
    render(<Done diagnostic={{ ...RESULTS, stroopInterferenceMs: 0, unreliable: ['pomeh', 'stroop', 'taskswitch'] }} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    expect(cells().slice(8)).toEqual([
      ['Помехоустойчивость — разница с помехами и без', '+35 мс, замер ненадёжен'],
      ['Струп — интерференция', '0 мс, замер ненадёжен'],
      ['Переключение правил — цена переключения', '−12 мс, замер ненадёжен'],
      ['Память — объём', '7'],
    ]);
  });

  it('marks the metrics of modules measured with dropped frames and says the index uses them (I1)', () => {
    render(<Done diagnostic={{ ...RESULTS, unreliable: ['pzmr', 'rdo'] }} seriesTotal={20} summaries={[]} onHome={vi.fn()} />);
    const rows = cells();
    expect(rows[0]).toEqual(['ПЗМР — медиана времени реакции', '251 мс, замер ненадёжен']);
    expect(rows[1]?.[1]).toBe('402 мс');
    expect(rows[3]).toEqual(['Реакция на движущийся объект — средняя ошибка', '19 мс, замер ненадёжен']);
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
