import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioStressorParams } from '../../engine/audio/stressors';
import { renderStressor } from '../../engine/audio/synth';
import { FakeAudioContext, type FakeAudioOptions } from '../../testing/fakeAudio';
import { IDLE_SUSPEND_MS, SUSPEND_WAIT_MS, browserAudioOut, createAudioOut, prepareQuietly, type AudioOut, type StressorHandle } from './audioOut';

const HUM: AudioStressorParams = { layers: ['hum'], gain: 0.5 };

/** A cheap stand-in for the synthesizer: 100 samples, so the tests stay fast. */
const tinySynth = vi.fn<typeof renderStressor>(() => new Float32Array(100).fill(0.25));

function setup(o: FakeAudioOptions = {}) {
  const ctx = new FakeAudioContext(o);
  const make = vi.fn(() => ctx);
  const synth = vi.fn<typeof renderStressor>(() => new Float32Array(100).fill(0.25));
  const out = createAudioOut(make, synth);
  return { ctx, make, synth, out };
}

describe('createAudioOut', () => {
  it('prepare returns null without Web Audio', async () => {
    const out = createAudioOut(null, tinySynth);
    await out.unlock();
    out.setVolume(1);
    expect(out.prepare(HUM, 1)).toBeNull();
    expect(tinySynth).not.toHaveBeenCalled();
  });

  it('prepare returns null when the context cannot be created', () => {
    const out = createAudioOut(() => {
      throw new Error('no device');
    }, tinySynth);
    expect(out.prepare(HUM, 1)).toBeNull();
  });

  it('creates the context lazily, once', async () => {
    const { make, out } = setup();
    expect(make).not.toHaveBeenCalled();
    await out.unlock();
    out.prepare(HUM, 1);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('prepare synthesizes once per layers and seed', () => {
    const { ctx, synth, out } = setup();
    out.prepare(HUM, 9);
    out.prepare({ layers: ['hum'], gain: 0.9 }, 9);
    expect(synth).toHaveBeenCalledTimes(1);
    expect(synth).toHaveBeenCalledWith(HUM, 9);
    expect(ctx.buffers).toHaveLength(1);
    expect(ctx.buffers[0]).toMatchObject({ numberOfChannels: 1, length: 100, sampleRate: 22050 });
    expect(ctx.buffers[0]?.channels[0]?.[0]).toBe(0.25);
    out.prepare(HUM, 10);
    out.prepare({ layers: ['hum', 'beeps'], gain: 0.5 }, 9);
    expect(synth).toHaveBeenCalledTimes(3);
  });

  it('keeps at most 4 buffers, dropping the least recently used', () => {
    const { synth, out } = setup();
    for (const seed of [1, 2, 3, 4]) out.prepare(HUM, seed);
    out.prepare(HUM, 1); // 1 is now the most recent
    out.prepare(HUM, 5); // drops 2
    expect(synth).toHaveBeenCalledTimes(5);
    out.prepare(HUM, 1);
    expect(synth).toHaveBeenCalledTimes(5);
    out.prepare(HUM, 2);
    expect(synth).toHaveBeenCalledTimes(6);
  });

  it('start schedules a looping source at currentTime + 0.05 with the offset', async () => {
    const { ctx, out } = setup();
    await out.unlock();
    out.setVolume(0.6);
    ctx.currentTime = 12.5;
    const h = out.prepare(HUM, 1);
    expect(h?.playing).toBe(false);
    expect(h?.start(7.25)).toBe(true);
    expect(h?.playing).toBe(true);
    const [source] = ctx.sources;
    const [gain] = ctx.gains;
    expect(source?.loop).toBe(true);
    expect(source?.buffer).toBe(ctx.buffers[0]);
    expect(source?.starts).toHaveLength(1);
    expect(source?.starts[0]?.when).toBeCloseTo(12.55, 9);
    expect(source?.starts[0]?.offset).toBe(7.25);
    expect(source?.connectedTo).toEqual([gain]);
    expect(gain?.connectedTo).toEqual([ctx.destination]);
    expect(gain?.gain.value).toBe(0); // starts silent
    expect(h?.start(1)).toBe(true); // a second start keeps the running loop
    expect(ctx.sources).toHaveLength(1);
  });

  it('start returns false when the context is not running and starts nothing', async () => {
    const { ctx, out } = setup({ resumes: false });
    await expect(out.unlock()).resolves.toBeUndefined();
    out.setVolume(0.6);
    const h = out.prepare(HUM, 1);
    expect(h).not.toBeNull();
    expect(h?.start(0)).toBe(false);
    expect(h?.playing).toBe(false);
    h?.setActive(true);
    h?.stop();
    expect(ctx.sources).toHaveLength(0);
    expect(ctx.gains).toHaveLength(0);
  });

  it('setActive ramps the gain to volume × gain with time constant 0.015', async () => {
    const { ctx, out } = setup();
    await out.unlock();
    out.setVolume(0.6);
    const h = out.prepare(HUM, 1);
    h?.start(0);
    ctx.currentTime = 3;
    h?.setActive(true);
    ctx.currentTime = 4;
    h?.setActive(false);
    expect(ctx.gains[0]?.targets).toEqual([
      { target: 0.3, at: 3, timeConstant: 0.015 },
      { target: 0, at: 4, timeConstant: 0.015 },
    ]);
  });

  it('never goes above the volume setting, even with a gain above 1', async () => {
    const { ctx, out } = setup();
    await out.unlock();
    out.setVolume(0.4);
    const h = out.prepare({ layers: ['hum'], gain: 3 }, 1);
    h?.start(0);
    h?.setActive(true);
    out.setVolume(7);
    expect(ctx.gains[0]?.targets.map((t) => t.target)).toEqual([0.4, 1]);
  });

  it('a volume change retargets an active loop and leaves an inactive one silent', async () => {
    const { ctx, out } = setup();
    await out.unlock();
    out.setVolume(1);
    const a = out.prepare(HUM, 1);
    const b = out.prepare(HUM, 2);
    a?.start(0);
    b?.start(0);
    a?.setActive(true);
    out.setVolume(0.2);
    expect(ctx.gains[0]?.targets.map((t) => t.target)).toEqual([0.5, 0.1]);
    expect(ctx.gains[1]?.targets).toEqual([]);
    a?.stop();
    out.setVolume(0.8);
    // 0.5, 0.1, then the fade-out of stop(); the volume change after it adds nothing.
    expect(ctx.gains[0]?.targets.map((t) => t.target)).toEqual([0.5, 0.1, 0]);
  });

  it('volume 0 keeps the block silent', async () => {
    const { ctx, out } = setup();
    await out.unlock();
    out.setVolume(0);
    const h = out.prepare(HUM, 1);
    expect(h?.start(0)).toBe(false);
    h?.setActive(true);
    expect(ctx.sources).toHaveLength(0);
    out.setVolume(Number.NaN);
    expect(out.prepare(HUM, 1)?.start(0)).toBe(false);
  });

  it('stop is idempotent', async () => {
    const { ctx, out } = setup();
    await out.unlock();
    out.setVolume(0.5);
    const h = out.prepare(HUM, 1);
    h?.start(0);
    h?.stop();
    h?.stop();
    expect(h?.playing).toBe(false);
    expect(ctx.sources[0]?.stops).toHaveLength(1);
    ctx.sources[0]?.end();
    expect(ctx.sources[0]?.disconnects).toBe(1);
    expect(ctx.gains[0]?.disconnects).toBe(1);
    h?.setActive(true);
    expect(ctx.gains[0]?.targets).toHaveLength(1); // only the fade-out of stop()
  });

  it('stop fades out: gain to 0 with time constant 0.015, the source stops 80 ms later, nodes go when it ends', async () => {
    const { ctx, out } = setup();
    await out.unlock();
    out.setVolume(0.5);
    const h = out.prepare(HUM, 1);
    h?.start(0);
    h?.setActive(true);
    ctx.currentTime = 6;
    h?.stop();
    const [source] = ctx.sources;
    const [gain] = ctx.gains;
    expect(gain?.targets.at(-1)).toEqual({ target: 0, at: 6, timeConstant: 0.015 });
    expect(source?.stops).toHaveLength(1);
    expect(source?.stops[0]).toBeCloseTo(6.08, 9);
    // Still connected while the fade plays: disconnecting now would cut the sound.
    expect(source?.disconnects).toBe(0);
    expect(gain?.disconnects).toBe(0);
    source?.end();
    expect(source?.disconnects).toBe(1);
    expect(gain?.disconnects).toBe(1);
    // A later volume change leaves the stopped loop alone.
    out.setVolume(1);
    expect(gain?.targets).toHaveLength(2);
  });

  it('stop survives a source that refuses to stop and disconnects at once', async () => {
    const { ctx, out } = setup();
    await out.unlock();
    out.setVolume(0.5);
    const h = out.prepare(HUM, 1);
    h?.start(0);
    const source = ctx.sources[0];
    if (source === undefined) throw new Error('no source');
    source.stop = () => {
      throw new Error('InvalidStateError');
    };
    expect(() => h?.stop()).not.toThrow();
    expect(h?.playing).toBe(false);
    expect(source.disconnects).toBe(1);
    expect(ctx.gains[0]?.disconnects).toBe(1);
  });

  it('start returns false and leaves nothing connected when the source refuses to start', async () => {
    const { ctx, out } = setup();
    await out.unlock();
    out.setVolume(0.5);
    const create = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => {
      const s = create();
      s.start = () => {
        throw new RangeError('offset out of range');
      };
      return s;
    };
    const h = out.prepare(HUM, 1);
    expect(h?.start(0)).toBe(false);
    expect(h?.playing).toBe(false);
    expect(ctx.sources[0]?.disconnects).toBe(1);
    expect(ctx.gains[0]?.disconnects).toBe(1);
    h?.setActive(true);
    h?.stop();
    expect(ctx.gains[0]?.targets).toEqual([]);
  });

  it('a fresh player stays silent until the volume is set', async () => {
    const { ctx, out } = setup();
    await out.unlock();
    const h = out.prepare(HUM, 1);
    expect(h?.start(0)).toBe(false);
    expect(ctx.sources).toHaveLength(0);
    out.setVolume(0.5);
    expect(h?.start(0)).toBe(true);
  });

  it('unlock resumes the context', async () => {
    const { ctx, out } = setup();
    await out.unlock();
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');
    await out.unlock();
    expect(ctx.resumeCalls).toBe(1); // already running
  });
});

describe('createAudioOut: the context sleeps when idle (B4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A running player with one loop playing. */
  async function playing(o: FakeAudioOptions = {}) {
    vi.useFakeTimers();
    const t = setup(o);
    await t.out.unlock();
    t.out.setVolume(0.5);
    const h = t.out.prepare(HUM, 1);
    expect(h?.start(0)).toBe(true);
    return { ...t, h };
  }

  it('reports whether Web Audio is there', () => {
    expect(createAudioOut(null, tinySynth).available).toBe(false);
    expect(setup().out.available).toBe(true);
    const broken = createAudioOut(() => {
      throw new Error('no device');
    }, tinySynth);
    broken.prepare(HUM, 1);
    expect(broken.available).toBe(false);
  });

  it('suspends the context IDLE_SUSPEND_MS after the last loop stops, never while one plays', async () => {
    const { ctx, out, h } = await playing();
    const second = out.prepare(HUM, 2);
    second?.start(0);
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 3);
    expect(ctx.suspendCalls).toBe(0);
    h?.stop();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 3);
    expect(ctx.suspendCalls).toBe(0);
    second?.stop();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS - 1);
    expect(ctx.suspendCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.suspendCalls).toBe(1);
    expect(ctx.state).toBe('suspended');
  });

  it('the next unlock resumes it, and a loop started then plays', async () => {
    const { ctx, out, h } = await playing();
    h?.stop();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS);
    expect(ctx.state).toBe('suspended');
    await out.unlock();
    expect(ctx.state).toBe('running');
    expect(ctx.resumeCalls).toBe(2);
    expect(out.prepare(HUM, 1)?.start(0)).toBe(true);
  });

  it('an unlock (the context woken without a loop) also goes back to sleep', async () => {
    vi.useFakeTimers();
    const { ctx, out } = setup();
    await out.unlock();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS);
    expect(ctx.state).toBe('suspended');
  });

  it('a loop started within IDLE_SUSPEND_MS keeps the context awake', async () => {
    const { ctx, out, h } = await playing();
    h?.stop();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS - 1);
    expect(out.prepare(HUM, 1)?.start(0)).toBe(true);
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 3);
    expect(ctx.suspendCalls).toBe(0);
  });

  it('unlock waits for a suspend in flight, then resumes; start during it stays silent', async () => {
    const { ctx, out, h } = await playing({ suspendDelayed: true });
    h?.stop();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS);
    expect(ctx.suspendCalls).toBe(1);
    // The suspend has not settled: a loop started now would be cut by it.
    expect(out.prepare(HUM, 1)?.start(0)).toBe(false);
    const unlocked = out.unlock();
    ctx.finishSuspend();
    await unlocked;
    expect(ctx.state).toBe('running');
    expect(out.prepare(HUM, 1)?.start(0)).toBe(true);
  });

  it('a suspend that throws or rejects changes nothing and throws nothing', async () => {
    for (const suspends of ['throws', 'rejects'] as const) {
      const { ctx, out, h } = await playing({ suspends });
      h?.stop();
      await expect(vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS)).resolves.not.toThrow();
      expect(ctx.suspendCalls).toBe(1);
      expect(ctx.state).toBe('running');
      await expect(out.unlock()).resolves.toBeUndefined();
      expect(out.prepare(HUM, 1)?.start(0)).toBe(true);
      vi.useRealTimers();
    }
  });
});

describe('createAudioOut: a hold keeps the context awake (W2-R39)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an unlock while held never arms the sleep', async () => {
    vi.useFakeTimers();
    const { ctx, out } = setup();
    out.hold();
    await out.unlock();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 10);
    expect(ctx.suspendCalls).toBe(0);
    expect(ctx.state).toBe('running');
  });

  it('two sound blocks more than IDLE_SUSPEND_MS apart inside a session both play, with no suspend between', async () => {
    vi.useFakeTimers();
    const { ctx, out } = setup();
    out.setVolume(0.5);
    out.hold();
    // Every instruction key press unlocks; silent blocks play in between.
    await out.unlock();
    const first = out.prepare(HUM, 1);
    expect(first?.start(0)).toBe(true);
    first?.stop();
    await out.unlock();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 5);
    await out.unlock();
    const second = out.prepare(HUM, 2);
    expect(second?.start(0)).toBe(true);
    second?.stop();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 5);
    expect(ctx.suspendCalls).toBe(0);
    expect(ctx.resumeCalls).toBe(1);
  });

  it('after the last release the sleep arms; a second release changes nothing', async () => {
    vi.useFakeTimers();
    const { ctx, out } = setup();
    const releaseA = out.hold();
    const releaseB = out.hold();
    await out.unlock();
    releaseA();
    releaseA();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 3);
    expect(ctx.suspendCalls).toBe(0);
    releaseB();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS - 1);
    expect(ctx.suspendCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.suspendCalls).toBe(1);
    expect(ctx.state).toBe('suspended');
  });

  it('a release while a loop plays waits for the loop to stop', async () => {
    vi.useFakeTimers();
    const { ctx, out } = setup();
    out.setVolume(0.5);
    const release = out.hold();
    await out.unlock();
    const h = out.prepare(HUM, 1);
    expect(h?.start(0)).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 3);
    expect(ctx.suspendCalls).toBe(0);
    h?.stop();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS);
    expect(ctx.suspendCalls).toBe(1);
  });

  it('a hold taken while the sleep is armed cancels it', async () => {
    vi.useFakeTimers();
    const { ctx, out } = setup();
    await out.unlock();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS - 1);
    out.hold();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 3);
    expect(ctx.suspendCalls).toBe(0);
  });

  it('a suspend that never settles holds unlock for SUSPEND_WAIT_MS at most; then start plays', async () => {
    vi.useFakeTimers();
    const { ctx, out } = setup({ suspendDelayed: true });
    out.setVolume(0.5);
    await out.unlock();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS);
    expect(ctx.suspendCalls).toBe(1);
    let done = false;
    const unlocked = out.unlock().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(SUSPEND_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await unlocked;
    expect(done).toBe(true);
    // The stuck suspend no longer blocks the sound until a restart.
    expect(out.prepare(HUM, 1)?.start(0)).toBe(true);
    const again = out.unlock();
    await vi.advanceTimersByTimeAsync(0);
    await expect(again).resolves.toBeUndefined();
  });
});

describe('prepareQuietly (W2-R22, M3)', () => {
  const fail = (what: string) => () => {
    throw new Error(what);
  };
  const outWith = (prepare: AudioOut['prepare']): AudioOut => ({
    available: true,
    unlock: () => Promise.resolve(),
    hold: () => () => undefined,
    setVolume: () => undefined,
    prepare,
  });

  it('null when prepare throws or gives nothing', () => {
    expect(prepareQuietly(outWith(fail('buffer refused')), HUM, 1)).toBeNull();
    expect(prepareQuietly(outWith(() => null), HUM, 1)).toBeNull();
  });

  it('passes calls through, and a call that throws changes nothing else: start counts as not played', () => {
    const start = vi.fn<StressorHandle['start']>(() => true);
    const setActive = vi.fn<StressorHandle['setActive']>();
    const stop = vi.fn<StressorHandle['stop']>();
    const quiet = prepareQuietly(outWith(() => ({ playing: false, start, setActive, stop })), HUM, 7);
    expect(quiet?.start(2)).toBe(true);
    quiet?.setActive(true);
    quiet?.stop();
    expect(start).toHaveBeenCalledWith(2);
    expect(setActive).toHaveBeenCalledWith(true);
    expect(stop).toHaveBeenCalledTimes(1);

    const broken: StressorHandle = { playing: false, start: fail('start'), setActive: fail('setActive'), stop: fail('stop') };
    const guarded = prepareQuietly(outWith(() => broken), HUM, 7);
    expect(guarded?.start(0)).toBe(false);
    expect(() => guarded?.setActive(true)).not.toThrow();
    expect(() => guarded?.stop()).not.toThrow();
  });
});

describe('browserAudioOut', () => {
  it('has no sound without window.AudioContext', () => {
    expect(browserAudioOut({} as Window).prepare(HUM, 1)).toBeNull();
  });

  it('creates the AudioContext only when it is first needed', async () => {
    const created: FakeAudioContext[] = [];
    class Ctor extends FakeAudioContext {
      constructor() {
        super();
        created.push(this);
      }
    }
    const out = browserAudioOut({ AudioContext: Ctor } as unknown as Window);
    expect(created).toHaveLength(0);
    await out.unlock();
    expect(created).toHaveLength(1);
    expect(created[0]?.state).toBe('running');
  });
});
