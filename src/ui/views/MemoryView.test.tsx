import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../../data/memoryRepository';
import type { MemoryTrial } from '../../modules/memory/generate';
import { CARD_AUDIO } from '../../modules/memory/params';
import type { MemoryAnswer } from '../../modules/memory/score';
import { createAudioOut, type AudioOut, type StressorHandle } from '../../runtime/audio/audioOut';
import type { StepOf } from '../../session/steps';
import { manualFrames, mockCanvas, nextTask, type ManualFrames } from '../../testing/domFakes';
import { createFakePlatform } from '../../testing/fakePlatform';
import { renderWithApp } from '../testUtils';
import MemoryView from './MemoryView';
import { UNLOCK_WAIT_MS } from './ReactionView';

/** Short timings so a trial is shown within a few frames: fixation 500, items every 200 ms. */
const trial = (over: Partial<MemoryTrial> = {}): MemoryTrial => ({
  mode: 'digits',
  items: ['7', '3', '9', '1'],
  gridSide: 0,
  rows: 0,
  itemMs: 100,
  gapMs: 100,
  cardMs: 400,
  sound: false,
  ...over,
});

function step(trials: MemoryTrial[], over: Partial<StepOf<'memory_block'>> = {}): StepOf<'memory_block'> {
  const first = trials[0] ?? trial();
  return {
    kind: 'memory_block',
    L: 0,
    mode: first.mode,
    params: { length: first.items.length, itemMs: first.itemMs, gapMs: first.gapMs, exposureMs: null, rows: null, sound: false },
    trials,
    protocol: 'fixed',
    audio: null,
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

function renderView(s: StepOf<'memory_block'>, o: { exposeAnswer?: boolean; busy?: boolean; audio?: AudioOut } = {}) {
  const handlers = {
    onSubmit: vi.fn<(a: MemoryAnswer[], audioPlayed?: boolean) => void>(),
    onFocusLost: vi.fn<() => void>(),
    onProgress: vi.fn<(p: number) => void>(),
  };
  const view = renderWithApp(
    <MemoryView step={s} exposeAnswer={o.exposeAnswer ?? false} busy={o.busy ?? false} {...handlers} />,
    createFakePlatform(),
    new MemoryRepository(),
    o.audio ?? createAudioOut(null),
  );
  return { ...handlers, ...view };
}

/** A sound output whose handle records the order of what the view does with it. */
function fakeAudio(o: { unlock?: () => Promise<void> } = {}) {
  const log: string[] = [];
  const handle = {
    start: vi.fn<StressorHandle['start']>(() => {
      log.push('start');
      return true;
    }),
    setActive: vi.fn<StressorHandle['setActive']>((on) => {
      log.push(`active ${String(on)}`);
    }),
    stop: vi.fn<StressorHandle['stop']>(() => {
      log.push('stop');
    }),
  };
  const prepare = vi.fn<AudioOut['prepare']>(() => ({ ...handle, playing: false }));
  const unlock = vi.fn<AudioOut['unlock']>(o.unlock ?? (() => Promise.resolve()));
  const audio: AudioOut = { available: true, unlock, setVolume: () => undefined, prepare, hold: () => () => undefined };
  return { audio, prepare, unlock, handle, log };
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

  it('Enter on an empty answer sends nothing and says what to do (B3)', async () => {
    const { onSubmit } = renderView(step([trial()]));
    await showTrial();
    key('Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Набери ответ, потом Enter.')).toBeTruthy();
    key('7');
    expect(screen.queryByText('Набери ответ, потом Enter.')).toBeNull();
    key('Enter');
    expect(onSubmit.mock.calls[0]?.[0]?.[0]?.given).toEqual(['7']);
  });

  it('positions: Enter with no cell chosen sends nothing and says what to do (B3)', async () => {
    const t = trial({ mode: 'positions', items: ['4', '8', '2'], gridSide: 3 });
    const { onSubmit } = renderView(step([t]));
    await showTrial();
    key('Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Нажми клетки, потом Enter.')).toBeTruthy();
    fireEvent.mouseDown(cell(4), { button: 0 });
    expect(screen.queryByText('Нажми клетки, потом Enter.')).toBeNull();
    key('Enter');
    expect(onSubmit.mock.calls[0]?.[0]?.[0]?.given).toEqual(['4']);
  });

  it('keys, Enter and clicks during the presentation are ignored (B3)', async () => {
    for (const t of [trial(), trial({ mode: 'positions', items: ['4', '8', '2'], gridSide: 3 })]) {
      const view = renderView(step([t, t]));
      const typeAndSend = (): void => {
        const canvas = view.container.querySelector('.memory canvas');
        expect(canvas).not.toBeNull();
        key('5');
        key('6');
        key('Enter');
        if (canvas !== null) fireEvent.mouseDown(canvas, { button: 0 });
        key('Enter');
      };
      /** At the response screen: nothing was sent and the answer is empty. */
      const answerIsEmpty = (): void => {
        expect(view.onSubmit).not.toHaveBeenCalled();
        if (t.mode === 'positions') expect(view.container.querySelectorAll('.memory-cell.chosen')).toHaveLength(0);
        else expect(screen.getByLabelText('Ответ').textContent).toBe('____');
      };
      // Trial 1 is being shown: type and press Enter, then the response screen.
      typeAndSend();
      await showTrial();
      answerIsEmpty();
      expect(screen.getByText('Проба 1 из 2')).toBeTruthy();
      // Trial 1 answered; trial 2 is being shown.
      if (t.mode === 'positions') fireEvent.mouseDown(cell(4), { button: 0 });
      else key('7');
      key('Enter');
      frames.run(now);
      await nextTask();
      typeAndSend();
      await showTrial();
      expect(screen.getByText('Проба 2 из 2')).toBeTruthy();
      answerIsEmpty();
      // An Enter now finds the answer empty: no hidden input was kept, nothing is sent, the hint shows.
      key('Enter');
      await nextTask();
      expect(view.onSubmit).not.toHaveBeenCalled();
      expect(screen.getByText(t.mode === 'positions' ? 'Нажми клетки, потом Enter.' : 'Набери ответ, потом Enter.')).toBeTruthy();
      view.unmount();
    }
  });

  it('plays every trial in turn and submits all answers after the last', async () => {
    const trials = [trial(), trial({ items: ['5', '2', '6', '0'] })];
    const { onSubmit, onProgress } = renderView(step(trials));
    await showTrial();
    key('Enter'); // empty: no answer, nothing to report
    expect(onProgress).not.toHaveBeenCalled();
    key('7');
    key('Enter');
    // The share done: answers / rows (F11).
    expect(onProgress.mock.calls).toEqual([[0.5]]);
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

  it('span protocol counts its trials without a total: it usually stops before the last one', async () => {
    renderView(step(spanTrials(), { protocol: 'span' }));
    await showTrial();
    expect(screen.getByText('Проба 1')).toBeTruthy();
    expect(screen.queryByText(/из 6/)).toBeNull();
    key('1');
    key('2');
    key('Enter');
    await showTrial();
    expect(screen.getByText('Проба 2')).toBeTruthy();
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

  it('the 3×3 card is shown whole, then typed like digits (F13)', async () => {
    const { onSubmit } = renderView(step([trial({ mode: 'card3x3', gridSide: 3, rows: 2 })]));
    await showTrial();
    expect(document.querySelector('.memory-response')?.getAttribute('data-mode')).toBe('card3x3');
    for (const d of ['7', '3', '9', '1']) key(d);
    key('w', 'KeyW');
    key('Enter');
    expect(onSubmit.mock.calls[0]?.[0]?.[0]?.given).toEqual(['7', '3', '9', '1']);
  });

  it('ten rows: after each answer the share done is the rows answered out of 10 (F11, F13)', async () => {
    const trials = Array.from({ length: 10 }, () => trial({ items: ['5'] }));
    const { onProgress } = renderView(step(trials));
    for (let i = 0; i < 4; i++) {
      await showTrial();
      key('5');
      key('Enter');
    }
    expect(onProgress.mock.calls).toEqual([[0.1], [0.2], [0.3], [0.4]]);
  });

  it('a card with sound: the sound plays only while the card is on screen (F13)', async () => {
    const { audio, prepare, unlock, log } = fakeAudio();
    const cards = [trial({ mode: 'card3x3', gridSide: 3, rows: 2, sound: true }), trial({ mode: 'card3x3', gridSide: 3, rows: 2, sound: true })];
    renderView(step(cards, { audio: CARD_AUDIO }), { audio });
    expect(prepare).toHaveBeenCalledWith(CARD_AUDIO, expect.any(Number));
    expect(unlock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    // The fixation cross: no sound yet.
    frames.run(0);
    frames.run(250);
    expect(log).toEqual([]);
    // The card at 500 ms: the sound starts and is switched on.
    frames.run(500);
    expect(log).toEqual(['start', 'active true']);
    frames.run(800);
    expect(log).toEqual(['start', 'active true']);
    // The card goes 400 ms later: the sound stops with it.
    frames.run(900);
    expect(log).toEqual(['start', 'active true', 'stop']);
    await act(async () => {
      await Promise.resolve();
    });
    await nextTask();
    for (const d of ['7', '3', '9', '1']) key(d);
    key('Enter');
    // The next card plays it again, the answer screen never.
    await showTrial();
    expect(log).toEqual(['start', 'active true', 'stop', 'start', 'active true', 'stop']);
  });

  it('a block with sound reports whether it played: false when no card started it (T-R67); a quiet block reports nothing', async () => {
    const card = () => step([trial({ mode: 'card3x3', gridSide: 3, rows: 2, sound: true })], { audio: CARD_AUDIO });
    const answer = async (): Promise<void> => {
      await showTrial();
      for (const d of ['7', '3', '9', '1']) key(d);
      key('Enter');
    };
    for (const started of [true, false]) {
      const fake = fakeAudio();
      fake.handle.start.mockImplementation(() => started);
      const view = renderView(card(), { audio: fake.audio });
      await answer();
      expect(view.onSubmit).toHaveBeenCalledTimes(1);
      expect(view.onSubmit.mock.calls[0]?.[0].map((a) => a.given)).toEqual([['7', '3', '9', '1']]);
      expect(view.onSubmit.mock.calls[0]?.[1]).toBe(started);
      view.unmount();
    }
    // The sound could not even be built: it never played.
    const broken = fakeAudio();
    broken.prepare.mockImplementation(() => {
      throw new Error('no buffer');
    });
    const silent = renderView(card(), { audio: broken.audio });
    await answer();
    expect(silent.onSubmit.mock.calls[0]?.[1]).toBe(false);
    silent.unmount();
    const quiet = renderView(step([trial()]));
    await showTrial();
    key('7');
    key('Enter');
    expect(quiet.onSubmit.mock.calls[0]).toHaveLength(1);
  });

  it('a card with sound waits for the unlock, at most UNLOCK_WAIT_MS; a block without sound neither prepares nor unlocks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { audio, unlock, log } = fakeAudio({ unlock: () => new Promise<void>(() => undefined) });
      renderView(step([trial({ mode: 'card3x3', gridSide: 3, rows: 2, sound: true })], { audio: CARD_AUDIO }), { audio });
      expect(unlock).toHaveBeenCalledTimes(1);
      frames.run(0);
      expect(frames.pending()).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(UNLOCK_WAIT_MS);
      });
      // The unlock never settled: the card is shown all the same.
      frames.run(1000);
      frames.run(1500);
      expect(log).toEqual(['start', 'active true']);
    } finally {
      vi.useRealTimers();
    }
    const quiet = fakeAudio();
    renderView(step([trial()]), { audio: quiet.audio });
    expect(quiet.prepare).not.toHaveBeenCalled();
    expect(quiet.unlock).not.toHaveBeenCalled();
  });

  it('unmounting while the card is on screen stops its sound', async () => {
    const { audio, log } = fakeAudio();
    const { unmount } = renderView(step([trial({ mode: 'card3x3', gridSide: 3, rows: 2, sound: true })], { audio: CARD_AUDIO }), { audio });
    await act(async () => {
      await Promise.resolve();
    });
    frames.run(0);
    frames.run(500);
    expect(log).toEqual(['start', 'active true']);
    unmount();
    expect(log.at(-1)).toBe('stop');
  });

  it('blur → onFocusLost, during the presentation or the answer', async () => {
    const first = renderView(step([trial()]));
    frames.run(0);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(first.onFocusLost).toHaveBeenCalledTimes(1);
    expect(frames.pending()).toBe(0);
    first.unmount();

    const second = renderView(step([trial()]));
    await showTrial();
    act(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('blur'));
    });
    expect(second.onFocusLost).toHaveBeenCalledTimes(1);
  });

  it('a blur after the answers were sent (while they are saved) is not a lost block', async () => {
    const { onSubmit, onFocusLost } = renderView(step([trial()]), { busy: false });
    await showTrial();
    key('7');
    key('Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onFocusLost).not.toHaveBeenCalled();
  });

  it('an unfocused window aborts at once', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { onFocusLost } = renderView(step([trial()]));
    expect(onFocusLost).toHaveBeenCalledTimes(1);
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
    const { onFocusLost, onSubmit, unmount } = renderView(step([trial()]));
    frames.run(0);
    unmount();
    expect(frames.pending()).toBe(0);
    expect(onFocusLost).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
