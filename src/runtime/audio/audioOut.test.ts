import { describe, expect, it, vi } from 'vitest';
import type { AudioStressorParams } from '../../engine/audio/stressors';
import { renderStressor } from '../../engine/audio/synth';
import { FakeAudioContext, type FakeAudioOptions } from '../../testing/fakeAudio';
import { browserAudioOut, createAudioOut } from './audioOut';

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
