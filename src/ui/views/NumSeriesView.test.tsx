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

/** Letters by position: В, Д, Ж, И, К → М (3, 5, 7, 9, 11 → 13). */
const L: TimedSeriesItem = { id: 'letters:1', family: 'letters', seed: 1, shown: [3, 5, 7, 9, 11], answer: 13, difficulty: 1000, timeLimitMs: 40_000 };
const A = item('arith:1', [2, 5, 11, 23, 47], 95);
const B = item('arith:2', [3, -1, -5, -9, -13], -17);
const C = item('arith:3', [1, 2, 3, 4, 5], 6);
/** Diagnostic items: no per-item limit. */
const untimed = (x: TimedSeriesItem): TimedSeriesItem => ({ ...x, timeLimitMs: null });

function step(items: TimedSeriesItem[], totalLimitMs: number | null = null): StepOf<'numseries_block'> {
  return { kind: 'numseries_block', items, totalLimitMs };
}

/** A key press on the answer field, as the browser sends it. */
function press(key: string, code: string, extra: Partial<{ repeat: boolean; ctrlKey: boolean }> = {}): void {
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Ответ' }), { key, code, ...extra });
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

  it('a letter item shows letters and the hint; a letter key on any layout answers its position with Enter (F12)', () => {
    const onSubmit = vi.fn();
    const { container } = render(<NumSeriesView step={step([L, A])} exposeAnswer busy={false} onProgress={vi.fn()} onSubmit={onSubmit} />);
    expect(screen.getByText('В, Д, Ж, И, К, ?')).toBeTruthy();
    expect(screen.getByText('Ответ — буква. Алфавит без Ё. Раскладку переключать не нужно.')).toBeTruthy();
    const el = container.querySelector('.series-item');
    expect(el?.getAttribute('data-answer-kind')).toBe('letter');
    expect(el?.getAttribute('data-e2e-answer')).toBe('М');
    // An English layout: the key of М prints «v».
    press('v', 'KeyV');
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Ответ' });
    expect(input.value).toBe('М');
    // Another letter replaces it; Ctrl with a key types nothing.
    press('d', 'KeyD');
    press('v', 'KeyV', { ctrlKey: true });
    expect(input.value).toBe('В');
    press('ь', 'KeyM');
    expect(input.value).toBe('Ь');
    press('m', 'KeyV');
    expect(input.value).toBe('М');
    press('Enter', 'Enter');
    // The next item is a number one, without the hint.
    expect(screen.getByText('2, 5, 11, 23, 47, ?')).toBeTruthy();
    expect(screen.queryByText(/Ответ — буква/)).toBeNull();
    expect(container.querySelector('.series-item')?.getAttribute('data-answer-kind')).toBe('number');
    answer('95');
    const answers = onSubmit.mock.calls[0]?.[0] as SeriesAnswer[];
    expect(answers.map((a) => [a.itemId, a.given])).toEqual([
      ['letters:1', 13],
      ['arith:1', 95],
    ]);
  });

  it('a letter item asks for a letter on Enter without one', () => {
    render(<NumSeriesView step={step([L])} exposeAnswer={false} busy={false} onProgress={vi.fn()} onSubmit={vi.fn()} />);
    press('Enter', 'Enter');
    expect(screen.getByRole('alert').textContent).toBe('Введи букву');
    // Ё is no letter of the alphabet here: it stays text and Enter asks again.
    answer('ё');
    expect(screen.getByRole('alert').textContent).toBe('Введи букву');
    expect(screen.getByText('В, Д, Ж, И, К, ?')).toBeTruthy();
  });

  it('Space skips any item: no answer, skipped, the time of the press, then the next item (F12)', () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    const onProgress = vi.fn();
    render(<NumSeriesView step={step([A, L, B])} exposeAnswer={false} busy={false} onProgress={onProgress} onSubmit={onSubmit} />);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    press(' ', 'Space');
    expect(screen.getByText('В, Д, Ж, И, К, ?')).toBeTruthy();
    expect(onProgress).toHaveBeenLastCalledWith(1 / 3, [{ itemId: 'arith:1', given: null, timeMs: 4000, skipped: true }]);
    // A held Space does not skip the next one too.
    press(' ', 'Space', { repeat: true });
    expect(screen.getByText('В, Д, Ж, И, К, ?')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    press(' ', 'Space');
    answer('−17');
    expect(onSubmit).toHaveBeenCalledWith([
      { itemId: 'arith:1', given: null, timeMs: 4000, skipped: true },
      { itemId: 'letters:1', given: null, timeMs: 1500, skipped: true },
      { itemId: 'arith:2', given: -17, timeMs: 0 },
    ]);
  });
});
