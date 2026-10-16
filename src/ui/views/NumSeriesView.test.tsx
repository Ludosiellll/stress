import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimedSeriesItem } from '../../modules/numseries/generate';
import type { SeriesAnswer, StepOf } from '../../session/steps';
import NumSeriesView from './NumSeriesView';

const item = (id: string, shown: number[], answer: number, timeLimitMs: number | null = 40_000): TimedSeriesItem => ({
  id,
  family: 'arith',
  seed: 1,
  shown,
  answer,
  difficulty: 800,
  timeLimitMs,
});

const A = item('arith:1', [2, 5, 11, 23, 47], 95);
const B = item('arith:2', [3, -1, -5, -9, -13], -17);
const C = item('arith:3', [1, 2, 3, 4, 5], 6);
/** Diagnostic items: no per-item limit. */
const untimed = (x: TimedSeriesItem): TimedSeriesItem => ({ ...x, timeLimitMs: null });

function step(items: TimedSeriesItem[], totalLimitMs: number | null = null): StepOf<'numseries_block'> {
  return { kind: 'numseries_block', items, totalLimitMs };
}

function answer(value: string): void {
  const input = screen.getByRole('textbox', { name: 'Ответ' });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('NumSeriesView', () => {
  it('shows the series large with a question mark and focuses the answer field', () => {
    render(<NumSeriesView step={step([A, B])} exposeAnswer={false} busy={false} onProgress={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByText('2, 5, 11, 23, 47, ?')).toBeTruthy();
    expect(screen.getByText('Задача 1 из 2')).toBeTruthy();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Ответ' });
    expect(document.activeElement).toBe(input);
    expect(input.maxLength).toBe(12);
  });

  it('writes negative numbers with a minus sign', () => {
    render(<NumSeriesView step={step([B])} exposeAnswer={false} busy={false} onProgress={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByText('3, −1, −5, −9, −13, ?')).toBeTruthy();
  });

  it('«−17» + Enter stores −17 and goes to the next item; after the last one submits all answers', () => {
    const onSubmit = vi.fn();
    render(<NumSeriesView step={step([B, A])} exposeAnswer={false} busy={false} onProgress={vi.fn()} onSubmit={onSubmit} />);
    answer('−17');
    expect(screen.getByText('2, 5, 11, 23, 47, ?')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Ответ' }).value).toBe('');
    expect(onSubmit).not.toHaveBeenCalled();
    answer(' 95 ');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const answers = onSubmit.mock.calls[0]?.[0] as Array<{ itemId: string; given: number | null; timeMs: number }>;
    expect(answers.map((a) => [a.itemId, a.given])).toEqual([
      ['arith:2', -17],
      ['arith:1', 95],
    ]);
    for (const a of answers) expect(a.timeMs).toBeGreaterThanOrEqual(0);
  });

  it('reports the share done and the answers so far after each item (F11)', () => {
    const onProgress = vi.fn();
    render(<NumSeriesView step={step([B, A, C])} exposeAnswer={false} busy={false} onProgress={onProgress} onSubmit={vi.fn()} />);
    answer('abc'); // not an answer: nothing to report
    expect(onProgress).not.toHaveBeenCalled();
    answer('−17');
    answer('94');
    const calls = onProgress.mock.calls as [number, SeriesAnswer[]][];
    expect(calls.map(([p, answered]) => [p, answered.map((x) => [x.itemId, x.given])])).toEqual([
      [1 / 3, [['arith:2', -17]]],
      [2 / 3, [['arith:2', -17], ['arith:1', 94]]],
    ]);
  });

  it('«abc» shows «Введи целое число» and stays on the item', () => {
    const onSubmit = vi.fn();
    render(<NumSeriesView step={step([A, B])} exposeAnswer={false} busy={false} onProgress={vi.fn()} onSubmit={onSubmit} />);
    answer('abc');
    expect(screen.getByRole('alert').textContent).toBe('Введи целое число');
    expect(screen.getByText('2, 5, 11, 23, 47, ?')).toBeTruthy();
    answer('4.5');
    expect(screen.getByText('2, 5, 11, 23, 47, ?')).toBeTruthy();
    answer('95');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('3, −1, −5, −9, −13, ?')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores a held Enter', () => {
    const onSubmit = vi.fn();
    render(<NumSeriesView step={step([A, B])} exposeAnswer={false} busy={false} onProgress={vi.fn()} onSubmit={onSubmit} />);
    const input = screen.getByRole('textbox', { name: 'Ответ' });
    fireEvent.change(input, { target: { value: '95' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', repeat: true });
    expect(screen.getByText('2, 5, 11, 23, 47, ?')).toBeTruthy();
  });

  it('a per-item timeout gives null and moves on; the bar shows the seconds left', () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    render(<NumSeriesView step={step([A, B])} exposeAnswer={false} busy={false} onProgress={vi.fn()} onSubmit={onSubmit} />);
    expect(screen.getByText('Осталось: 40 с')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(10_500);
    });
    expect(screen.getByText('Осталось: 30 с')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ответ' }), { target: { value: '9' } });
    act(() => {
      vi.advanceTimersByTime(29_500);
    });
    // Typed but not confirmed: still no answer.
    expect(screen.getByText('3, −1, −5, −9, −13, ?')).toBeTruthy();
    expect(screen.getByText('Осталось: 40 с')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(onSubmit).toHaveBeenCalledWith([
      { itemId: 'arith:1', given: null, timeMs: 40_000 },
      { itemId: 'arith:2', given: null, timeMs: 40_000 },
    ]);
  });

  it('each item runs on its own limit', () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    render(<NumSeriesView step={step([A, item('arith:2', [3, -1, -5, -9, -13], -17, 10_000)])} exposeAnswer={false} busy={false} onProgress={vi.fn()} onSubmit={onSubmit} />);
    expect(screen.getByText('Осталось: 40 с')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    answer('95');
    expect(screen.getByText('3, −1, −5, −9, −13, ?')).toBeTruthy();
    expect(screen.getByText('Осталось: 10 с')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('Осталось: 5 с')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onSubmit).toHaveBeenCalledWith([
      { itemId: 'arith:1', given: 95, timeMs: 3000 },
      { itemId: 'arith:2', given: null, timeMs: 10_000 },
    ]);
  });

  it('the total limit ends the block: the current and the remaining items get null', () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    render(<NumSeriesView step={step([A, B, C].map(untimed), 60_000)} exposeAnswer={false} busy={false} onProgress={vi.fn()} onSubmit={onSubmit} />);
    expect(screen.getByText('Осталось: 60 с')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    answer('95');
    expect(screen.getByText('Осталось: 50 с')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    expect(onSubmit).toHaveBeenCalledWith([
      { itemId: 'arith:1', given: 95, timeMs: 10_000 },
      { itemId: 'arith:2', given: null, timeMs: 50_000 },
      { itemId: 'arith:3', given: null, timeMs: 0 },
    ]);
  });

  it('locks the field while the answers are being saved', () => {
    render(<NumSeriesView step={step([A])} exposeAnswer={false} busy onProgress={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Ответ' }).disabled).toBe(true);
  });

  it('exposes the answer as data-e2e-answer only in e2e mode', () => {
    const { container, rerender } = render(<NumSeriesView step={step([A])} exposeAnswer={false} busy={false} onProgress={vi.fn()} onSubmit={vi.fn()} />);
    expect(container.querySelector('[data-e2e-answer]')).toBeNull();
    rerender(<NumSeriesView step={step([A])} exposeAnswer busy={false} onProgress={vi.fn()} onSubmit={vi.fn()} />);
    expect(container.querySelector('[data-e2e-answer]')?.getAttribute('data-e2e-answer')).toBe('95');
  });
});
