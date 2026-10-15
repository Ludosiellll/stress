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

  it('a number never breaks from its unit in the assessment (A-R22)', () => {
    const assessment = {
      step: 'Ступень 3 из 5+ — формат теста (уровень 13,5; формат теста — 12)',
      goal: 'До ступени 4 «сверх нормы»: уровень 17 (+3,5). Там: лимит времени: 39 → 29 с',
      norms: ['Норма (ориентир): 44,0 с — средний; выше среднего — до 37 с. Бумажная методика, источник не указан'],
      history: 'Раньше в этом блоке: прошлый раз 67 % (ряд 7, ур. 9)',
    };
    render(<BlockSummary view={{ ...VIEW, assessment }} busy={false} onContinue={vi.fn()} />);
    expect(within(screen.getByRole('list', { name: 'Оценка' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Ступень 3 из 5+ — формат теста (уровень 13,5; формат теста — 12)',
      'До ступени 4 «сверх нормы»: уровень 17 (+3,5). Там: лимит времени: 39\u00a0→\u00a029\u00a0с',
      'Норма (ориентир): 44,0\u00a0с — средний; выше среднего — до 37\u00a0с. Бумажная методика, источник не указан',
      'Раньше в этом блоке: прошлый раз 67\u00a0% (ряд 7, ур. 9)',
    ]);
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
