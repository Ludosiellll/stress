import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BlockSummaryView } from '../../session/steps';
import { nextTask } from '../../testing/domFakes';
import BlockSummary from './BlockSummary';

const VIEW: BlockSummaryView = {
  module: 'pzmr',
  title: 'ПЗМР',
  lBefore: 10,
  lAfter: 11,
  changes: [{ label: 'Окно ответа', from: '387 мс', to: '358 мс' }],
  score: 0.85,
  lines: ['Медиана: 312 мс', 'Разброс (SD): 41 мс', 'Фальстарты: 1', 'Пропуски: 0'],
  flags: ['calibration', 'fatigued', 'timing_unreliable'],
  showLevel: true,
};

describe('BlockSummary', () => {
  it('shows the level, the parameter changes, the score, the metric lines and the flags', () => {
    render(<BlockSummary view={VIEW} busy={false} onContinue={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'ПЗМР' })).toBeTruthy();
    expect(screen.getByText('Уровень: 10,0 → 11,0')).toBeTruthy();
    expect(screen.getByText('Окно ответа: 387 → 358 мс')).toBeTruthy();
    expect(screen.getByText('Успешно: 85 %')).toBeTruthy();
    for (const line of VIEW.lines) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByText('Калибровка')).toBeTruthy();
    expect(screen.getByText('Блок помечен: усталость')).toBeTruthy();
    expect(screen.getByText('Замер ненадёжен: пропуски кадров — уровень не менялся')).toBeTruthy();
    expect(screen.getByText('Enter — дальше')).toBeTruthy();
  });

  it('an overload block says it does not touch the saved level', () => {
    render(<BlockSummary view={{ ...VIEW, flags: ['overload'] }} busy={false} onContinue={vi.fn()} />);
    expect(screen.getByText('Блок с перегрузкой: на сохранённый уровень не влияет')).toBeTruthy();
  });

  it('rounds the level to one decimal and leaves out what did not happen', () => {
    render(
      <BlockSummary view={{ ...VIEW, lBefore: 3.25, lAfter: 3, changes: [], flags: [] }} busy={false} onContinue={vi.fn()} />,
    );
    expect(screen.getByText('Уровень: 3,3 → 3,0')).toBeTruthy();
    expect(screen.queryByText(/Блок помечен|Замер ненадёжен|Калибровка/)).toBeNull();
  });

  it('a diagnostic block shows no level and no parameter changes (M5)', () => {
    render(<BlockSummary view={{ ...VIEW, lBefore: 0, lAfter: 0, showLevel: false }} busy={false} onContinue={vi.fn()} />);
    expect(screen.queryByText(/Уровень/)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Изменения' })).toBeNull();
    expect(screen.getByText('Успешно: 85 %')).toBeTruthy();
  });

  it('has no level line for number series', () => {
    render(
      <BlockSummary
        view={{ ...VIEW, module: 'numseries', title: 'Числовые ряды', lBefore: 0, lAfter: 0, changes: [], flags: [], score: 0.7, showLevel: false }}
        busy={false}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Уровень/)).toBeNull();
    expect(screen.getByText('Успешно: 70 %')).toBeTruthy();
  });

  it('shows the assessment in order under the metrics', () => {
    const assessment = { step: 'S', goal: 'G', norms: ['N1', 'N2'], history: 'H' };
    render(<BlockSummary view={{ ...VIEW, assessment }} busy={false} onContinue={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Оценка' })).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Оценка' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['S', 'G', 'N1', 'N2', 'H']);
    const metrics = screen.getByRole('list', { name: 'Показатели' });
    expect(metrics.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves out empty lines; no section without an assessment', () => {
    const { rerender } = render(
      <BlockSummary view={{ ...VIEW, assessment: { step: null, goal: null, norms: ['N1'], history: null } }} busy={false} onContinue={vi.fn()} />,
    );
    expect(within(screen.getByRole('list', { name: 'Оценка' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['N1']);
    for (const view of [VIEW, { ...VIEW, assessment: { step: null, goal: null, norms: [], history: null } }]) {
      rerender(<BlockSummary view={view} busy={false} onContinue={vi.fn()} />);
      expect(screen.queryByRole('list', { name: 'Оценка' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Оценка' })).toBeNull();
    }
  });

  it('Enter or the button continues; nothing while busy', async () => {
    const onContinue = vi.fn();
    const { rerender } = render(<BlockSummary view={VIEW} busy={false} onContinue={onContinue} />);
    await nextTask();
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    expect(onContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Дальше' }));
    expect(onContinue).toHaveBeenCalledTimes(2);
    rerender(<BlockSummary view={VIEW} busy onContinue={onContinue} />);
    await nextTask();
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Дальше' }).disabled).toBe(true);
    expect(onContinue).toHaveBeenCalledTimes(2);
  });
});
