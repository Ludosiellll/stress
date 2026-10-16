import { act, cleanup, createEvent, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../../data/memoryRepository';
import type { AudioStressorParams } from '../../engine/audio/stressors';
import type { VisualNoiseParams } from '../../engine/noise';
import type { BlockTimeline, TrialCond, TrialSpec } from '../../engine/reaction/types';
import { NO_STRESSORS, type BlockStressors } from '../../modules/reaction/common';
import { createAudioOut, type AudioOut, type StressorHandle } from '../../runtime/audio/audioOut';
import { createCanvasRenderer, type CanvasRenderer } from '../../runtime/canvasRenderer';
import type { StepOf } from '../../session/steps';
import { manualFrames, mockCanvas, nextTask, stamped, type ManualFrames } from '../../testing/domFakes';
import { installE2eHooks, type E2eHost } from '../../testing/e2eHooks';
import { FakeAudioContext } from '../../testing/fakeAudio';
import { createFakePlatform } from '../../testing/fakePlatform';
import { renderWithApp } from '../testUtils';
import ReactionView, { UNLOCK_WAIT_MS } from './ReactionView';

// The real renderer, observed: tests read the instance the view made.
vi.mock('../../runtime/canvasRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/canvasRenderer')>();
  return { ...actual, createCanvasRenderer: vi.fn(actual.createCanvasRenderer) };
});

const TRIAL: TrialSpec = {
  isiMs: 100,
  windowMs: 500,
  stimulus: { kind: 'shape', shape: 'circle', color: 'red' },
  expected: { kind: 'press', key: 'Space' },
};

function step(over: Partial<StepOf<'reaction_block'>> = {}): StepOf<'reaction_block'> {
  return {
    kind: 'reaction_block',
    module: 'pzmr',
    L: 0,
    specs: [TRIAL],
    keys: ['Space'],
    layout: 'keyboard',
    legend: null,
    layers: { ...NO_STRESSORS, seed: 1 },
    ...over,
  };
}

/**
 * A sound output whose one handle records what the view does with it; `device: false` = no Web Audio,
 * `throws: 'prepare'` = building the buffer fails, `throws: 'handle'` = every call on the handle throws.
 */
function fakeAudio(o: { starts?: boolean; device?: boolean; throws?: 'prepare' | 'handle' } = {}) {
  const boom = (): never => {
    throw new DOMException('the node cannot be created', 'InvalidStateError');
  };
  const handle =
    o.throws === 'handle'
      ? {
          start: vi.fn<StressorHandle['start']>(boom),
          setActive: vi.fn<StressorHandle['setActive']>(boom),
          stop: vi.fn<StressorHandle['stop']>(boom),
        }
      : {
          start: vi.fn<StressorHandle['start']>(() => o.starts ?? true),
          setActive: vi.fn<StressorHandle['setActive']>(),
          stop: vi.fn<StressorHandle['stop']>(),
        };
  const prepare = vi.fn<AudioOut['prepare']>(() => {
    if (o.throws === 'prepare') throw new RangeError('createBuffer failed');
    return o.device === false ? null : { ...handle, playing: false };
  });
  const unlock = vi.fn<AudioOut['unlock']>(() => Promise.resolve());
  const audio: AudioOut = { available: o.device !== false, unlock, setVolume: () => undefined, prepare, hold: () => () => undefined };
  return { audio, prepare, handle, unlock };
}

/** An AudioContext that stays 'suspended' until the test lets its resume() settle (a real device takes a moment). */
class SlowResumeContext extends FakeAudioContext {
  private settle: (() => void) | null = null;

  override resume(): Promise<void> {
    this.resumeCalls++;
    return new Promise<void>((resolve) => {
      this.settle = () => {
        this.state = 'running';
        resolve();
      };
    });
  }

  /** resume() settles now; false if nobody asked for it. */
  finishResume(): boolean {
    const settle = this.settle;
    this.settle = null;
    settle?.();
    return settle !== null;
  }
}

/** The real player over a SlowResumeContext, at half volume, with a tiny synthesized loop. */
function slowAudio() {
  const ctx = new SlowResumeContext();
  const audio = createAudioOut(
    () => ctx,
    () => new Float32Array(16),
  );
  audio.setVolume(0.5);
  return { ctx, audio };
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

function renderView(s = step(), audio: AudioOut = fakeAudio().audio, canStop: () => boolean = () => true) {
  const handlers = { onDone: vi.fn(), onAbort: vi.fn(), onError: vi.fn() };
  const view = renderWithApp(
    <ReactionView step={s} nominalFrameMs={16} canStop={canStop} {...handlers} />,
    createFakePlatform(),
    new MemoryRepository(),
    audio,
  );
  return { ...handlers, ...view };
}

/** The renderer the view made last, with its noise switch recorded. */
function noiseSwitch() {
  const renderer = vi.mocked(createCanvasRenderer).mock.results.at(-1)?.value as CanvasRenderer;
  return vi.spyOn(renderer, 'setNoiseActive');
}

const NOISE: VisualNoiseParams = { distractors: 3, lifetimeMs: 1000, flicker: false, farOnly: true, forbidden: [{ shape: 'circle', color: 'red' }] };
const HUM: AudioStressorParams = { layers: ['hum'], gain: 0.5 };
const LAYERS_SEED = 123_456;

/** Trials with these conditions, ISI 100, window 200, nobody presses. */
function stressedStep(
  conds: readonly TrialCond[],
  gate: BlockStressors['gate'] = 'noisy',
  noiseGate: BlockStressors['noiseGate'] = 'noisy',
): StepOf<'reaction_block'> {
  return step({
    module: 'pomeh',
    specs: conds.map((cond) => ({ ...TRIAL, windowMs: 200, cond })),
    layers: { noise: NOISE, audio: HUM, gate, noiseGate, seed: LAYERS_SEED },
  });
}

/** Plays `n` unanswered trials of stressedStep from t0 = 1000 to the end of the block. */
async function playUnanswered(n: number): Promise<void> {
  frames.run(1000);
  for (let i = 0; i < n; i++) {
    frames.run(1100 + i * 300); // onset
    frames.run(1300 + i * 300); // window over
  }
  frames.run(1300 + (n - 1) * 300 + 300 + 16); // late grace + one frame
  await act(async () => {
    await Promise.resolve();
  });
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

  it('shows the key legend under the canvas', () => {
    mockCanvas();
    const { container, getByText } = renderView(step({ module: 'stroop', keys: ['KeyF', 'KeyJ'], legend: 'красный — F · зелёный — J' }));
    const legend = getByText('красный — F · зелёный — J');
    expect(legend.previousElementSibling?.tagName).toBe('CANVAS');
    expect(legend.closest('.reaction')).toBe(container.querySelector('.reaction'));
  });

  it('no legend element without a legend', () => {
    mockCanvas();
    const { container } = renderView();
    expect(container.querySelector('.reaction-legend')).toBeNull();
  });

  it('plays the block and reports the timeline', async () => {
    mockCanvas();
    const { audio, prepare, unlock } = fakeAudio();
    const { onDone, onAbort } = renderView(step(), audio);
    await nextTask();
    // A block without sound starts in the next task, as in 0.1.0: it waits for nothing.
    expect(frames.pending()).toBe(1);
    await playOneTrial();
    expect(onDone).toHaveBeenCalledTimes(1);
    const tl = onDone.mock.calls[0]?.[0] as BlockTimeline;
    expect(tl.onsets).toEqual([1100]);
    expect(tl.presses).toEqual([{ key: 'Space', ts: 1300 }]);
    // A block without sound prepares none and says nothing about it.
    expect(prepare).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
    expect(tl).not.toHaveProperty('audioPlayed');
    expect(vi.mocked(createCanvasRenderer).mock.lastCall?.[1]).toEqual({});
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
    expect(onAbort).toHaveBeenCalledWith('focus_lost', 0);
    expect(onDone).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(0);
  });

  it('an unfocused window aborts at once', async () => {
    mockCanvas();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { onAbort } = renderView();
    await nextTask();
    expect(onAbort).toHaveBeenCalledWith('focus_lost', 0);
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
    expect(onAbort).toHaveBeenCalledWith('user', 0);
  });

  it('Escape reports the share of the block shown: stimuli shown / trials, practice left out (F11)', async () => {
    mockCanvas();
    const practice = { ...TRIAL, practice: true };
    const { onAbort } = renderView(step({ specs: [practice, practice, TRIAL, TRIAL, TRIAL, TRIAL] }));
    await nextTask();
    // Nobody presses: onsets at 1100, 1700 and 2300 (ISI 100 after each 500 ms window).
    for (const ts of [1000, 1100, 1600, 1700, 2200, 2300]) frames.run(ts);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
      await Promise.resolve();
    });
    expect(onAbort).toHaveBeenCalledWith('user', 0.25);
  });

  it('Escape does nothing when the session screen cannot take the stop at that moment: the block plays on (F11, T-R57)', async () => {
    mockCanvas();
    // Asked at the key press, not at render: the screen may be busy with another call.
    let allowed = true;
    const { onAbort, onDone } = renderView(step(), fakeAudio().audio, () => allowed);
    allowed = false;
    await nextTask();
    frames.run(1000);
    let event: KeyboardEvent | null = null;
    await act(async () => {
      event = createEvent.keyDown(window, { key: 'Escape', code: 'Escape' }) as KeyboardEvent;
      fireEvent(window, event);
      await Promise.resolve();
    });
    // Left for the session screen, which says why.
    expect((event as KeyboardEvent | null)?.defaultPrevented).toBe(false);
    expect(onAbort).not.toHaveBeenCalled();
    frames.run(1100);
    keyDown('Space', 1300);
    frames.run(1316);
    frames.run(1616);
    frames.run(1632);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onDone).toHaveBeenCalledTimes(1);
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
    // The failing stimulus had its onset: the one trial of the block is done (F11).
    expect(onError).toHaveBeenCalledWith(boom, 1);
    expect(onDone).not.toHaveBeenCalled();
    // hide() redrew the empty background after the failed show.
    expect(canvas.calls.slice(-1)).toEqual(['fillRect']);
  });

  it('a missing 2D context is reported as an error', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { onError } = renderView();
    await nextTask();
    expect(onError).toHaveBeenCalledTimes(1);
    // Nothing was shown.
    expect(onError.mock.calls[0]?.[1]).toBe(0);
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

  it('gates noise and sound by trial condition', async () => {
    mockCanvas();
    const { audio, prepare, handle } = fakeAudio();
    const conds: TrialCond[] = ['quiet', 'noisy', 'noisy', 'quiet'];
    const { onDone, container } = renderView(stressedStep(conds), audio);
    // The sound is built before the block starts, and started with it.
    expect(prepare).toHaveBeenCalledWith(HUM, LAYERS_SEED);
    expect(handle.start).not.toHaveBeenCalled();
    expect(vi.mocked(createCanvasRenderer).mock.lastCall).toEqual([
      container.querySelector('canvas'),
      { noise: { params: NOISE, seed: LAYERS_SEED } },
    ]);
    const noise = noiseSwitch();
    await nextTask();
    expect(handle.start).toHaveBeenCalledWith((LAYERS_SEED % 20000) / 1000);
    await playUnanswered(conds.length);
    expect(noise.mock.calls.map(([on]) => on)).toEqual([false, true, true, false]);
    expect(handle.setActive.mock.calls.map(([on]) => on)).toEqual([false, true, true, false]);
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ onsets: [1100, 1400, 1700, 2000], audioPlayed: true });
  });

  it('gate all (overload) plays the sound on every trial; the noise keeps to noisy trials (W2-R10)', async () => {
    mockCanvas();
    const { audio, handle } = fakeAudio();
    const conds: TrialCond[] = ['quiet', 'noisy', 'quiet'];
    renderView(stressedStep(conds, 'all'), audio);
    const noise = noiseSwitch();
    await nextTask();
    await playUnanswered(conds.length);
    expect(handle.setActive.mock.calls.map(([on]) => on)).toEqual([true, true, true]);
    expect(noise.mock.calls.map(([on]) => on)).toEqual([false, true, false]);
  });

  it('noiseGate all (noise outside Помехоустойчивость, F3) shows the noise on every trial; noisy keeps to noisy trials', async () => {
    mockCanvas();
    const { audio } = fakeAudio();
    const conds: TrialCond[] = ['quiet', 'noisy', 'quiet'];
    renderView(stressedStep(conds, 'all', 'all'), audio);
    const noise = noiseSwitch();
    await nextTask();
    await playUnanswered(conds.length);
    expect(noise.mock.calls.map(([on]) => on)).toEqual([true, true, true]);
  });

  it('a block whose trials have no condition and noiseGate all shows the noise throughout', async () => {
    mockCanvas();
    const { audio } = fakeAudio();
    renderView(step({ module: 'pzmr', specs: [TRIAL, TRIAL].map((t) => ({ ...t, windowMs: 200 })), layers: { noise: NOISE, audio: null, gate: 'all', noiseGate: 'all', seed: LAYERS_SEED } }), audio);
    const noise = noiseSwitch();
    await nextTask();
    await playUnanswered(2);
    expect(noise.mock.calls.map(([on]) => on)).toEqual([true, true]);
  });

  it.each([
    ['the context cannot start', { starts: false }],
    ['there is no sound device', { device: false }],
    ['preparing the sound throws (W2-R22)', { throws: 'prepare' as const }],
    ['every call on the sound throws (W2-R22)', { throws: 'handle' as const }],
  ])('plays the block without sound when %s', async (_why, o) => {
    mockCanvas();
    const { audio } = fakeAudio(o);
    const conds: TrialCond[] = ['noisy', 'quiet', 'noisy'];
    const { onDone, onAbort, onError } = renderView(stressedStep(conds), audio);
    await nextTask();
    await playUnanswered(conds.length);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ onsets: [1100, 1400, 1700], audioPlayed: false });
    expect(onAbort).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops the sound when the block is aborted or the view unmounts; an aborted start plays none', async () => {
    mockCanvas();
    const escaped = fakeAudio();
    renderView(stressedStep(['noisy']), escaped.audio);
    await nextTask();
    frames.run(1000);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
      await Promise.resolve();
    });
    expect(escaped.handle.stop).toHaveBeenCalled();

    const unmounted = fakeAudio();
    const { unmount } = renderView(stressedStep(['noisy']), unmounted.audio);
    await nextTask();
    frames.run(1000);
    unmount();
    expect(unmounted.handle.stop).toHaveBeenCalled();

    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const unfocused = fakeAudio();
    const { onAbort } = renderView(stressedStep(['noisy']), unfocused.audio);
    await nextTask();
    expect(onAbort).toHaveBeenCalledWith('focus_lost', 0);
    expect(unfocused.handle.start).not.toHaveBeenCalled();
    expect(unfocused.handle.stop).toHaveBeenCalled();
  });

  it('a block with sound waits for the context to resume, then plays it (W2-R22)', async () => {
    mockCanvas();
    const { ctx, audio } = slowAudio();
    const conds: TrialCond[] = ['noisy', 'quiet'];
    const { onDone } = renderView(stressedStep(conds), audio);
    await nextTask();
    // The instruction's unlock() has not finished yet: nothing has started.
    expect(ctx.state).toBe('suspended');
    expect(frames.pending()).toBe(0);
    expect(ctx.finishResume()).toBe(true);
    await nextTask();
    expect(frames.pending()).toBe(1);
    await playUnanswered(conds.length);
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ onsets: [1100, 1400], audioPlayed: true });
    expect(ctx.sources).toHaveLength(1);
  });

  it('a resume that never settles holds the block for UNLOCK_WAIT_MS at most, then it runs silently', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mockCanvas();
      const { ctx, audio } = slowAudio();
      const conds: TrialCond[] = ['noisy'];
      const { onDone, onError } = renderView(stressedStep(conds), audio);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(UNLOCK_WAIT_MS - 1);
      });
      expect(frames.pending()).toBe(0);
      // The wait ends at UNLOCK_WAIT_MS; the block starts in the task after it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2);
      });
      expect(frames.pending()).toBe(1);
      await playUnanswered(conds.length);
      expect(onDone.mock.calls[0]?.[0]).toMatchObject({ onsets: [1100], audioPlayed: false });
      expect(onError).not.toHaveBeenCalled();
      expect(ctx.sources).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unlock that rejects starts the block at once, without sound (B3)', async () => {
    mockCanvas();
    const { audio, unlock } = fakeAudio({ starts: false });
    unlock.mockImplementation(() => Promise.reject(new Error('resume refused')));
    const conds: TrialCond[] = ['noisy'];
    const { onDone, onError } = renderView(stressedStep(conds), audio);
    await nextTask();
    await act(async () => {
      await Promise.resolve();
    });
    // Not after UNLOCK_WAIT_MS: the rejection itself lets the block begin.
    expect(frames.pending()).toBe(1);
    await playUnanswered(conds.length);
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ audioPlayed: false });
    expect(onError).not.toHaveBeenCalled();
  });

  it('a window blur mid-block stops the sound', async () => {
    mockCanvas();
    const { audio, handle } = fakeAudio();
    const { onAbort } = renderView(stressedStep(['noisy', 'noisy']), audio);
    await nextTask();
    frames.run(1000);
    frames.run(1100);
    expect(handle.setActive).toHaveBeenCalledWith(true);
    expect(handle.stop).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      await Promise.resolve();
    });
    expect(onAbort).toHaveBeenCalledWith('focus_lost', 0.5);
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(frames.pending()).toBe(0);
  });

  it('trials with feedback get the marks of the runner; the same block without feedback, none (F15)', async () => {
    mockCanvas();
    for (const feedback of [true, false]) {
      const spec: TrialSpec = feedback ? { ...TRIAL, feedback } : TRIAL;
      const { onDone } = renderView(step({ module: 'szmr', keys: ['KeyF', 'KeyJ'], specs: [{ ...spec, expected: { kind: 'press', key: 'KeyF' } }] }));
      const renderer = vi.mocked(createCanvasRenderer).mock.results.at(-1)?.value as CanvasRenderer;
      const mark = vi.spyOn(renderer, 'mark');
      const clearMark = vi.spyOn(renderer, 'clearMark');
      await nextTask();
      frames.run(1000);
      frames.run(1100);
      // The wrong key 200 ms after the onset.
      keyDown('KeyJ', 1300);
      frames.run(1316);
      frames.run(1466);
      frames.run(1616);
      frames.run(1632);
      await act(async () => {
        await Promise.resolve();
      });
      expect(onDone).toHaveBeenCalledTimes(1);
      if (feedback) {
        expect(mark.mock.calls).toEqual([['ошибка']]);
        expect(clearMark).toHaveBeenCalledTimes(1);
      } else {
        expect(mark).not.toHaveBeenCalled();
        expect(clearMark).not.toHaveBeenCalled();
      }
      cleanup();
    }
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
