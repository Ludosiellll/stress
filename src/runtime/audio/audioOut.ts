import { STRESSOR_LAYERS, STRESSOR_SAMPLE_RATE, type AudioStressorParams } from '../../engine/audio/stressors';
import { renderStressor } from '../../engine/audio/synth';

/** The subset of Web Audio the player uses; the real AudioContext fits it, tests pass FakeAudioContext. */
export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface AudioBufferLike {
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void;
}

export interface AudioBufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  start(when: number, offset: number): void;
  stop(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: { value: number; setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown };
}

export interface AudioContextLike {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly destination: AudioNodeLike;
  resume(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  createGain(): GainNodeLike;
}

/** One prepared loop: built before the block starts, switched on and off during it without any IO. */
export interface StressorHandle {
  /** Starts the loop silent at currentTime + 0.05 from offsetS; false (and silent) when the context is not running. */
  start(offsetS: number): boolean;
  /** Ramps the gain to volume × params.gain (on) or 0 (off), time constant 0.015 s. */
  setActive(on: boolean): void;
  /** Idempotent. */
  stop(): void;
  readonly playing: boolean;
}

export interface AudioOut {
  /** Resumes the context; call it from a user gesture (a click or a key press). Never rejects. */
  unlock(): Promise<void>;
  /** 0..1, the volume setting / 100. Silent (0) until set. Active loops follow it. */
  setVolume(v: number): void;
  /** Synthesizes (or takes from the cache) the loop buffer; null without Web Audio. */
  prepare(p: AudioStressorParams, seed: number): StressorHandle | null;
}

/** Loop start delay after `currentTime`, s: lets the source be scheduled on the audio clock, not "now". */
const START_DELAY_S = 0.05;
const RAMP_TIME_CONSTANT_S = 0.015;
const CACHE_LIMIT = 4;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Plays synthesized stressor loops. The context is created on first use; buffers are cached by
 * layers + seed (at most 4). Output gain never exceeds the volume setting. Without Web Audio, or when
 * the context cannot start, nothing sounds and nothing throws.
 */
export function createAudioOut(makeContext: (() => AudioContextLike) | null, synth: typeof renderStressor = renderStressor): AudioOut {
  let ctx: AudioContextLike | null = null;
  let broken = makeContext === null;
  let volume = 0;
  const cache = new Map<string, AudioBufferLike>();
  /** Loops that are playing and switched on: a volume change retargets them. */
  const active = new Set<() => void>();

  const context = (): AudioContextLike | null => {
    if (ctx === null && !broken && makeContext !== null) {
      try {
        ctx = makeContext();
      } catch {
        broken = true;
      }
    }
    return ctx;
  };

  const bufferFor = (c: AudioContextLike, p: AudioStressorParams, seed: number): AudioBufferLike => {
    const key = `${STRESSOR_LAYERS.filter((l) => p.layers.includes(l)).join('+')}|${String(seed)}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const data = synth(p, seed);
    const buffer = c.createBuffer(1, data.length, STRESSOR_SAMPLE_RATE);
    buffer.copyToChannel(data, 0);
    cache.set(key, buffer);
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return buffer;
  };

  const handleFor = (c: AudioContextLike, buffer: AudioBufferLike, gainShare: number): StressorHandle => {
    let nodes: { source: AudioBufferSourceLike; gain: GainNodeLike } | null = null;
    let on = false;
    const retarget = (): void => {
      nodes?.gain.gain.setTargetAtTime(on ? volume * gainShare : 0, c.currentTime, RAMP_TIME_CONSTANT_S);
    };
    return {
      get playing() {
        return nodes !== null;
      },
      start(offsetS) {
        if (nodes !== null) return true;
        if (c.state !== 'running' || volume === 0) return false;
        const source = c.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const gain = c.createGain();
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(c.destination);
        source.start(c.currentTime + START_DELAY_S, offsetS);
        nodes = { source, gain };
        return true;
      },
      setActive(next) {
        if (nodes === null) return;
        on = next;
        if (on) active.add(retarget);
        else active.delete(retarget);
        retarget();
      },
      stop() {
        if (nodes === null) return;
        const { source, gain } = nodes;
        nodes = null;
        on = false;
        active.delete(retarget);
        try {
          source.stop();
        } catch {
          // Already stopped by the context: nothing left to silence.
        }
        source.disconnect();
        gain.disconnect();
      },
    };
  };

  return {
    async unlock() {
      const c = context();
      if (c === null || c.state === 'running') return;
      try {
        await c.resume();
      } catch {
        // A blocked device: start() reports false and the block runs without sound.
      }
    },
    setVolume(v) {
      volume = clamp01(v);
      for (const retarget of active) retarget();
    },
    prepare(p, seed) {
      const c = context();
      if (c === null) return null;
      return handleFor(c, bufferFor(c, p, seed), clamp01(p.gain));
    },
  };
}

/** The app's player: Web Audio of the window, if it has one. The AudioContext is made on first use. */
export function browserAudioOut(w: Window): AudioOut {
  // Typed as the real constructor, so the compiler checks that AudioContext fits AudioContextLike.
  const Ctor = (w as Partial<Pick<typeof globalThis, 'AudioContext'>>).AudioContext;
  return createAudioOut(Ctor === undefined ? null : (): AudioContextLike => new Ctor());
}
