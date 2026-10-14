import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRng, deriveSeed } from '../../engine/rng';
import type { TableCell } from '../../modules/tables/gorbov';
import { reshuffle, scoreTableRun, type TableRun } from '../../modules/tables/score';
import type { StepOf } from '../../session/steps';
import { manualFrames, stamped, type ManualFrames } from '../../testing/domFakes';
import TableView from './TableView';

const black = (value: number): TableCell => ({ value, color: 'black' });
/** 3×3 Schulte grid in a fixed shuffled order. */
const CELLS = [5, 2, 9, 1, 7, 3, 8, 4, 6].map(black);

function step(over: Partial<StepOf<'table_block'>['params']> = {}, cells = CELLS): StepOf<'table_block'> {
  return {
    kind: 'table_block',
    module: 'schulte',
    L: 0,
    task: 'schulte',
    cells,
    params: { timeLimitMs: 60_000, reshuffleEvery: null, size: 3, ...over },
    seed: 42,
  };
}

let frames: ManualFrames;

beforeEach(() => {
  frames = manualFrames();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function cellButton(value: number, color: TableCell['color'] = 'black'): HTMLElement {
  const grid = screen.getByRole('group', { name: 'Таблица' });
  const el = within(grid)
    .getAllByRole('button')
    .find((b) => b.textContent === String(value) && b.dataset['color'] === color);
  if (el === undefined) throw new Error(`no cell ${color} ${String(value)}`);
  return el;
}

function press(value: number, ts: number, color: TableCell['color'] = 'black'): void {
  const el = cellButton(value, color);
  fireEvent(el, stamped(createEvent.mouseDown(el, { button: 0 }), ts));
}

const order = (): string[] =>
  within(screen.getByRole('group', { name: 'Таблица' }))
    .getAllByRole('button')
    .map((b) => b.textContent);

describe('TableView', () => {
  it('draws size×size cells in the step order, with no timer on screen', () => {
    render(<TableView step={step()} busy={false} onSubmit={vi.fn()} />);
    expect(order()).toEqual(['5', '2', '9', '1', '7', '3', '8', '4', '6']);
    expect(screen.queryByText(/с$/)).toBeNull();
  });

  it('colours Gorbov numbers red and black on light cells', () => {
    const cells: TableCell[] = [
      { value: 25, color: 'red' },
      { value: 1, color: 'black' },
    ];
    render(<TableView step={{ ...step({ size: 7 }, cells), module: 'gorbov', task: 'red_down' }} busy={false} onSubmit={vi.fn()} />);
    expect(cellButton(25, 'red').style.color).toBe('rgb(214, 69, 69)');
    expect(cellButton(1).style.color).toBe('rgb(17, 17, 17)');
  });

  it('ignores clicks before the first frame; a wrong click is an error and does not advance', () => {
    const onSubmit = vi.fn();
    render(<TableView step={step()} busy={false} onSubmit={onSubmit} />);
    press(1, 900); // before the grid's first frame: ignored
    frames.run(1000);
    press(2, 1100); // wrong: 1 is next
    for (let v = 1; v <= 8; v++) press(v, 1100 + v * 100);
    expect(onSubmit).not.toHaveBeenCalled();
    press(9, 2000);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const run = onSubmit.mock.calls[0]?.[0] as TableRun;
    expect(run).toMatchObject({ task: 'schulte', startTs: 1000, timeLimitMs: 60_000, total: 9 });
    expect(run.clicks).toHaveLength(10);
    expect(run.clicks[0]).toEqual({ cell: black(2), ts: 1100 });
    expect(scoreTableRun(run)).toMatchObject({ completed: true, errors: 1, correct: 9, timeMs: 1000 });
    press(1, 2100); // after the end: nothing
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('ignores the right mouse button', () => {
    const onSubmit = vi.fn();
    render(<TableView step={step()} busy={false} onSubmit={onSubmit} />);
    frames.run(1000);
    const el = cellButton(1);
    fireEvent(el, stamped(createEvent.mouseDown(el, { button: 2 }), 1100));
    for (let v = 1; v <= 9; v++) press(v, 1100 + v * 100);
    expect((onSubmit.mock.calls[0]?.[0] as TableRun).clicks).toHaveLength(9);
  });

  it('the deadline ends the run with the clicks so far', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onSubmit = vi.fn();
    render(<TableView step={step({ timeLimitMs: 5000 })} busy={false} onSubmit={onSubmit} />);
    frames.run(1000);
    press(1, 1500);
    vi.advanceTimersByTime(4999);
    expect(onSubmit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const run = onSubmit.mock.calls[0]?.[0] as TableRun;
    expect(run.clicks).toEqual([{ cell: black(1), ts: 1500 }]);
    expect(scoreTableRun(run)).toMatchObject({ completed: false, correct: 1 });
    press(2, 1600);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('reshuffles after every N correct clicks with the step seed', () => {
    render(<TableView step={step({ reshuffleEvery: 2 })} busy={false} onSubmit={vi.fn()} />);
    frames.run(1000);
    press(1, 1100);
    expect(order()).toEqual(['5', '2', '9', '1', '7', '3', '8', '4', '6']);
    press(2, 1200);
    const first = reshuffle(CELLS, createRng(deriveSeed(42, 'reshuffle:1')));
    expect(order()).toEqual(first.map((c) => String(c.value)));
    press(3, 1300);
    press(4, 1400);
    const second = reshuffle(first, createRng(deriveSeed(42, 'reshuffle:2')));
    expect(order()).toEqual(second.map((c) => String(c.value)));
  });

  it('locks the cells while the run is being saved', () => {
    render(<TableView step={step()} busy onSubmit={vi.fn()} />);
    expect(cellButton(1)).toHaveProperty('disabled', true);
  });

  it('stops waiting for the frame when unmounted', () => {
    const { unmount } = render(<TableView step={step()} busy={false} onSubmit={vi.fn()} />);
    expect(frames.pending()).toBe(1);
    unmount();
    expect(frames.pending()).toBe(0);
  });
});
