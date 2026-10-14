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
});
