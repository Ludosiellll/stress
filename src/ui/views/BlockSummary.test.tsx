import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BlockSummaryView } from '../../session/steps';
import { nextTask } from '../../testing/domFakes';
import BlockSummary, { changeText } from './BlockSummary';

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

  it('writes a shared unit once and leaves other values whole', () => {
    expect(changeText({ label: 'Лимит времени', from: '120 с', to: '102 с' })).toBe('Лимит времени: 120 → 102 с');
    expect(changeText({ label: 'Перемешивание', from: 'нет', to: 'каждые 10 верных' })).toBe('Перемешивание: нет → каждые 10 верных');
    expect(changeText({ label: 'Размер', from: '5×5', to: '6×6' })).toBe('Размер: 5×5 → 6×6');
    expect(changeText({ label: 'Окно', from: '1 с', to: '900 мс' })).toBe('Окно: 1 с → 900 мс');
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
