import { act, createEvent, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockTimeline, TrialSpec } from '../../engine/reaction/types';
import type { StepOf } from '../../session/steps';
import { manualFrames, mockCanvas, nextTask, stamped, type ManualFrames } from '../../testing/domFakes';
import { installE2eHooks, type E2eHost } from '../../testing/e2eHooks';
import ReactionView from './ReactionView';

const TRIAL: TrialSpec = {
  isiMs: 100,
  windowMs: 500,
  stimulus: { kind: 'shape', shape: 'circle', color: 'red' },
  expected: { kind: 'press', key: 'Space' },
};

function step(over: Partial<StepOf<'reaction_block'>> = {}): StepOf<'reaction_block'> {
  return { kind: 'reaction_block', module: 'pzmr', L: 0, specs: [TRIAL], keys: ['Space'], layout: 'keyboard', ...over };
}

let frames: ManualFrames;

beforeEach(() => {
  frames = manualFrames();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  installE2eHooks({ location: { search: '' } });
});

function renderView(s = step()) {
  const handlers = { onDone: vi.fn(), onAbort: vi.fn(), onError: vi.fn() };
  const view = render(<ReactionView step={s} nominalFrameMs={16} {...handlers} />);
  return { ...handlers, ...view };
}

function keyDown(code: string, ts: number): void {
  fireEvent(window, stamped(createEvent.keyDown(window, { code, key: code === 'Space' ? ' ' : code }), ts));
}

/** Plays the one-trial block: t0 = 1000, onset 1100, press at 1300, done after the late grace. */
async function playOneTrial(): Promise<void> {
  frames.run(1000);
  frames.run(1100);
  keyDown('Space', 1300);
  frames.run(1316);
  frames.run(1616);
  frames.run(1632);
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ReactionView', () => {
  it('fills the screen with a canvas and hides the cursor', () => {
    mockCanvas();
    const { container } = renderView();
    const root = container.querySelector('.reaction');
    expect(root?.querySelector('canvas')).toBeTruthy();
    expect(root?.querySelectorAll('button, input')).toHaveLength(0);
  });

  it('plays the block and reports the timeline', async () => {
    mockCanvas();
    const { onDone, onAbort } = renderView();
    await nextTask();
    await playOneTrial();
    expect(onDone).toHaveBeenCalledTimes(1);
    const tl = onDone.mock.calls[0]?.[0] as BlockTimeline;
    expect(tl.onsets).toEqual([1100]);
    expect(tl.presses).toEqual([{ key: 'Space', ts: 1300 }]);
    expect(onAbort).not.toHaveBeenCalled();
    // Input is released when the block ends.
    keyDown('Space', 1700);
    expect(tl.presses).toHaveLength(1);
  });

  it('records no key pressed before the block started (the key that opened it)', async () => {
    mockCanvas();
    const { onDone } = renderView();
    keyDown('Space', 950);
    await nextTask();
    await playOneTrial();
    expect((onDone.mock.calls[0]?.[0] as BlockTimeline).presses).toEqual([{ key: 'Space', ts: 1300 }]);
  });

  it('uses the step keys and layout: mouse buttons in the mouse layout', async () => {
    mockCanvas();
    const { onDone } = renderView(step({ keys: ['MouseLeft'], layout: 'mouse', specs: [{ ...TRIAL, expected: { kind: 'press', key: 'MouseLeft' } }] }));
    await nextTask();
    frames.run(1000);
    frames.run(1100);
    fireEvent(document.body, stamped(createEvent.mouseDown(document.body, { button: 0 }), 1250));
    keyDown('Space', 1260);
    frames.run(1266);
    frames.run(1566);
    frames.run(1582);
    await act(async () => {
      await Promise.resolve();
    });
    expect((onDone.mock.calls[0]?.[0] as BlockTimeline).presses).toEqual([{ key: 'MouseLeft', ts: 1250 }]);
  });

  it('window blur aborts with focus_lost', async () => {
    mockCanvas();
    const { onAbort, onDone } = renderView();
    await nextTask();
    frames.run(1000);
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      await Promise.resolve();
    });
    expect(onAbort).toHaveBeenCalledWith('focus_lost');
    expect(onDone).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(0);
  });

  it('an unfocused window aborts at once', async () => {
    mockCanvas();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { onAbort } = renderView();
    await nextTask();
    expect(onAbort).toHaveBeenCalledWith('focus_lost');
    expect(frames.pending()).toBe(0);
  });

  it('Escape aborts with user; a held Escape (auto-repeat) does not', async () => {
    mockCanvas();
    const { onAbort } = renderView();
    await nextTask();
    frames.run(1000);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape', repeat: true });
      await Promise.resolve();
    });
    expect(onAbort).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
      await Promise.resolve();
    });
    expect(onAbort).toHaveBeenCalledWith('user');
  });

  it('a renderer failure reports the error and clears the screen', async () => {
    const boom = new Error('draw failed');
    const canvas = mockCanvas({
      arc: () => {
        throw boom;
      },
    });
    const { onError, onDone } = renderView();
    await nextTask();
    frames.run(1000);
    canvas.calls.length = 0;
    frames.run(1100);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledWith(boom);
    expect(onDone).not.toHaveBeenCalled();
    // hide() redrew the empty background after the failed show.
    expect(canvas.calls.slice(-1)).toEqual(['fillRect']);
  });

  it('a missing 2D context is reported as an error', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { onError } = renderView();
    await nextTask();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('unmounting mid-block stops it without reporting anything', async () => {
    mockCanvas();
    const { onAbort, onDone, onError, unmount } = renderView();
    await nextTask();
    frames.run(1000);
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(frames.pending()).toBe(0);
    expect(onAbort).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('in e2e mode emits each stimulus with its onset and keeps the resolved results', async () => {
    mockCanvas();
    const host: E2eHost = { location: { search: '?e2e=1' } };
    installE2eHooks(host);
    const seen = vi.fn();
    host.__trainer?.onStimulus(seen);
    renderView();
    await nextTask();
    await playOneTrial();
    expect(seen).toHaveBeenCalledWith({ module: 'pzmr', expected: { kind: 'press', key: 'Space' }, onset: 1100 });
    expect(host.__trainer?.lastResults).toMatchObject([{ outcome: 'hit', rtMs: 200 }]);
  });
});
