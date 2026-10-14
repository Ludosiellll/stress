import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryTrial } from '../../modules/memory/generate';
import type { MemoryAnswer } from '../../modules/memory/score';
import type { StepOf } from '../../session/steps';
import { manualFrames, mockCanvas, nextTask, type ManualFrames } from '../../testing/domFakes';
import MemoryView from './MemoryView';

/** Short timings so a trial is shown within a few frames: fixation 500, items every 200 ms. */
const trial = (over: Partial<MemoryTrial> = {}): MemoryTrial => ({
  mode: 'digits',
  items: ['7', '3', '9', '1'],
  gridSide: 0,
  itemMs: 100,
  gapMs: 100,
  cardMs: 400,
  ...over,
});

function step(trials: MemoryTrial[], over: Partial<StepOf<'memory_block'>> = {}): StepOf<'memory_block'> {
  const first = trials[0] ?? trial();
  return {
    kind: 'memory_block',
    L: 0,
    mode: first.mode,
    params: { length: first.items.length, itemMs: first.itemMs, gapMs: first.gapMs },
    trials,
    protocol: 'fixed',
    ...over,
  };
}

let frames: ManualFrames;
let now = 0;

beforeEach(() => {
  frames = manualFrames();
  mockCanvas();
  now = 0;
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderView(s: StepOf<'memory_block'>, o: { exposeAnswer?: boolean; busy?: boolean } = {}) {
  const handlers = { onSubmit: vi.fn<(a: MemoryAnswer[]) => void>(), onAbort: vi.fn<(r: 'focus_lost' | 'user') => void>() };
  const view = render(<MemoryView step={s} exposeAnswer={o.exposeAnswer ?? false} busy={o.busy ?? false} {...handlers} />);
  return { ...handlers, ...view };
}

/** Runs frames 50 ms apart until the response screen is up (the presentation of the current trial is over). */
async function showTrial(): Promise<void> {
  const start = now;
  for (let i = 0; i < 200 && document.querySelector('.memory-response') === null; i++) {
    frames.run(start + i * 50);
    now = start + i * 50;
    await act(async () => {
      await Promise.resolve();
    });
  }
  expect(document.querySelector('.memory-response')).not.toBeNull();
  // Keys are listened to from the next task on.
  await nextTask();
}

function key(k: string, code = k.length === 1 && /\d/.test(k) ? `Digit${k}` : k, extra: KeyboardEventInit = {}): void {
  fireEvent.keyDown(window, { key: k, code, ...extra });
}

const cell = (i: number): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-cell="${String(i)}"]`);
  if (el === null) throw new Error(`no cell ${String(i)}`);
  return el;
};

describe('MemoryView', () => {
  it('shows the trial on a canvas with the cursor hidden, then the response screen', async () => {
    const { container } = renderView(step([trial()]));
    expect(container.querySelector('.memory canvas')).not.toBeNull();
    expect(container.querySelector('.memory')?.classList.contains('memory-no-cursor')).toBe(true);
    expect(container.querySelector('.memory-response')).toBeNull();
    await showTrial();
    expect(container.querySelector('.memory canvas')).toBeNull();
    expect(screen.getByText('Проба 1 из 1')).toBeTruthy();
    // Keyboard modes keep the cursor hidden on the response screen too.
    expect(container.querySelector('.memory')?.classList.contains('memory-no-cursor')).toBe(true);
  });

  it('typing «7 2 Backspace 3 Enter» gives given [7, 3]', async () => {
    const { onSubmit } = renderView(step([trial()]));
    await showTrial();
    now += 2500;
    key('7');
    key('2');
    key('Backspace');
    key('3', 'Numpad3');
    expect(screen.getByLabelText('Ответ').textContent).toBe('73__');
    key('Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual([{ given: ['7', '3'], timeMs: 2500 }]);
  });

  it('letters by physical key on an English layout; shortcuts and other keys are ignored', async () => {
    const { onSubmit } = renderView(step([trial({ mode: 'letters', items: ['В', 'Б', 'Т'] })]));
    await showTrial();
    key('d', 'KeyD');
    key(',', 'Comma');
    key('c', 'KeyC', { ctrlKey: true });
    key('7');
    key('т', 'KeyN');
    key('Enter');
    expect(onSubmit.mock.calls[0]?.[0]?.[0]?.given).toEqual(['В', 'Б', 'Т']);
  });

  it('clicks on cells 4, 0, 0 (a repeat click takes the last one back), 8, Enter → [4, 8]; the cursor is visible', async () => {
    const t = trial({ mode: 'positions', items: ['4', '8', '2'], gridSide: 3 });
    const { onSubmit, container } = renderView(step([t]));
    await showTrial();
    expect(container.querySelectorAll('[data-cell]')).toHaveLength(9);
    expect(container.querySelector('.memory')?.classList.contains('memory-no-cursor')).toBe(false);
    for (const i of [4, 0, 0, 8]) fireEvent.mouseDown(cell(i), { button: 0 });
    // A cell already chosen earlier, a right click: nothing changes.
    fireEvent.mouseDown(cell(4), { button: 0 });
    fireEvent.mouseDown(cell(2), { button: 2 });
    expect(cell(4).textContent).toBe('1');
    expect(cell(8).textContent).toBe('2');
    expect(cell(0).textContent).toBe('');
    key('Enter');
    expect(onSubmit.mock.calls[0]?.[0]?.[0]?.given).toEqual(['4', '8']);
  });

  it('positions: «Готово» sends the answer; digits typed there do nothing', async () => {
    const t = trial({ mode: 'positions', items: ['4', '8', '2'], gridSide: 3 });
    const { onSubmit } = renderView(step([t]));
    await showTrial();
    key('5');
    fireEvent.mouseDown(cell(2), { button: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
    expect(onSubmit.mock.calls[0]?.[0]?.[0]?.given).toEqual(['2']);
  });

  it('plays every trial in turn and submits all answers after the last', async () => {
    const trials = [trial(), trial({ items: ['5', '2', '6', '0'] })];
    const { onSubmit } = renderView(step(trials));
    await showTrial();
    key('7');
    key('Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('.memory canvas')).not.toBeNull();
    await showTrial();
    expect(screen.getByText('Проба 2 из 2')).toBeTruthy();
    // The field starts empty for the new trial.
    expect(screen.getByLabelText('Ответ').textContent).toBe('____');
    for (const d of ['5', '2', '6', '0']) key(d);
    key('Enter');
    key('Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]?.map((a) => a.given)).toEqual([['7'], ['5', '2', '6', '0']]);
  });

  /** Rows of lengths 2, 2, 3, 3, 4, 4 (the span protocol's order, shortened). */
  const spanTrials = (): MemoryTrial[] =>
    [['1', '2'], ['3', '4'], ['5', '6', '7'], ['8', '9', '0'], ['1', '2', '3', '4'], ['5', '6', '7', '8']].map((items) => trial({ items }));

  async function answerRows(rows: string[][]): Promise<void> {
    for (const digits of rows) {
      await showTrial();
      for (const d of digits) key(d);
      key('Enter');
    }
  }

  it('span protocol submits early when both trials of a length fail', async () => {
    const { onSubmit, container } = renderView(step(spanTrials(), { protocol: 'span' }));
    // Right at length 2, both rows of 3 wrong: the answers go out after the 4th trial.
    await answerRows([['1', '2'], ['3', '4'], ['5', '6'], ['8', '9', '1']]);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]?.map((a) => a.given)).toEqual([['1', '2'], ['3', '4'], ['5', '6'], ['8', '9', '1']]);
    // The block is over: trial 5 is never shown, and a late Enter sends nothing more.
    expect(container.querySelector('.memory canvas')).toBeNull();
    key('Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('span protocol goes on while one row of the length was right', async () => {
    const { onSubmit } = renderView(step(spanTrials(), { protocol: 'span' }));
    await answerRows([['1', '2'], ['3', '4'], ['5', '6', '7'], ['8', '9']]);
    expect(onSubmit).not.toHaveBeenCalled();
    await answerRows([['1', '2', '3'], ['5', '6', '7', '9']]);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toHaveLength(6);
  });

  it('a fixed block never stops early, even when every row is wrong', async () => {
    const trials = [['1', '2'], ['3', '4'], ['5', '6']].map((items) => trial({ items }));
    const { onSubmit } = renderView(step(trials));
    for (let i = 0; i < 2; i++) {
      await showTrial();
      key('9');
      key('Enter');
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('the card is shown whole, then typed like digits', async () => {
    const { onSubmit } = renderView(step([trial({ mode: 'card', gridSide: 3 })]));
    await showTrial();
    for (const d of ['7', '3', '9', '1']) key(d);
    key('Enter');
    expect(onSubmit.mock.calls[0]?.[0]?.[0]?.given).toEqual(['7', '3', '9', '1']);
  });

  it('blur → onAbort(focus_lost), during the presentation or the answer', async () => {
    const first = renderView(step([trial()]));
    frames.run(0);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(first.onAbort).toHaveBeenCalledWith('focus_lost');
    expect(frames.pending()).toBe(0);
    first.unmount();

    const second = renderView(step([trial()]));
    await showTrial();
    act(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('blur'));
    });
    expect(second.onAbort).toHaveBeenCalledTimes(1);
    expect(second.onAbort).toHaveBeenCalledWith('focus_lost');
  });

  it('a blur after the answers were sent (while they are saved) is not a lost block', async () => {
    const { onSubmit, onAbort } = renderView(step([trial()]), { busy: false });
    await showTrial();
    key('Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('an unfocused window aborts at once', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { onAbort } = renderView(step([trial()]));
    expect(onAbort).toHaveBeenCalledWith('focus_lost');
  });

  it('data-e2e-answer only with exposeAnswer', async () => {
    const t = trial({ mode: 'positions', items: ['4', '8', '2'], gridSide: 3 });
    const exposed = renderView(step([t]), { exposeAnswer: true });
    await showTrial();
    expect(exposed.container.querySelector('.memory-response')?.getAttribute('data-e2e-answer')).toBe('4,8,2');
    exposed.unmount();

    renderView(step([t]));
    await showTrial();
    expect(document.querySelector('.memory-response')?.hasAttribute('data-e2e-answer')).toBe(false);
  });

  it('busy: keys and clicks are locked', async () => {
    const digits = renderView(step([trial()]), { busy: true });
    await showTrial();
    key('7');
    key('Enter');
    expect(screen.getByLabelText('Ответ').textContent).toBe('____');
    expect(digits.onSubmit).not.toHaveBeenCalled();
    digits.unmount();

    const t = trial({ mode: 'positions', items: ['4', '8', '2'], gridSide: 3 });
    const grid = renderView(step([t]), { busy: true });
    await showTrial();
    fireEvent.mouseDown(cell(4), { button: 0 });
    expect(cell(4).textContent).toBe('');
    expect((cell(4) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Готово' }).disabled).toBe(true);
    expect(grid.onSubmit).not.toHaveBeenCalled();
  });

  it('unmounting mid-presentation stops the frames and reports nothing', () => {
    const { onAbort, onSubmit, unmount } = renderView(step([trial()]));
    frames.run(0);
    unmount();
    expect(frames.pending()).toBe(0);
    expect(onAbort).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
