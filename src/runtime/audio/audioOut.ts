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
  /** Fires once the source has stopped playing. */
  onended: ((ev: Event) => unknown) | null;
  start(when: number, offset: number): void;
  stop(when: number): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: { value: number; setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown };
}

export interface AudioContextLike {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly destination: AudioNodeLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
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
  /** Fades out (gain → 0, time constant 0.015 s) and stops the source 80 ms later, never cutting the sound. Idempotent. */
  stop(): void;
  readonly playing: boolean;
}

export interface AudioOut {
  /** False once Web Audio is known to be missing: no AudioContext in the window, or it could not be created. */
  readonly available: boolean;
  /**
   * Resumes the context (waiting for a sleep in progress first, at most SUSPEND_WAIT_MS); call it from a user
   * gesture (a click or a key press). Never rejects.
   */
  unlock(): Promise<void>;
  /**
   * Keeps the context awake until the returned release is called (idempotent): the idle sleep arms only when no
   * hold is taken and no loop plays. A session screen holds it for its whole life, so the context never changes
   * state inside a timed block and every block after the first unlock finds it running (W2-R39).
   */
  hold(): () => void;
  /** 0..1, the volume setting / 100. Silent (0) until set. Active loops follow it. */
  setVolume(v: number): void;
  /** Synthesizes (or takes from the cache) the loop buffer; null without Web Audio. */
  prepare(p: AudioStressorParams, seed: number): StressorHandle | null;
}

/** Loop start delay after `currentTime`, s: lets the source be scheduled on the audio clock, not "now". */
const START_DELAY_S = 0.05;
const RAMP_TIME_CONSTANT_S = 0.015;
/** stop(): the source ends this long after the fade-out begins (over 5 time constants: the gain is below 1 %). */
const STOP_DELAY_S = 0.08;
const CACHE_LIMIT = 4;
/** The context is suspended this long after the last loop stopped (or an unlock with nothing played): no idle audio thread. */
export const IDLE_SUSPEND_MS = 1000;
/** unlock() waits at most this long for a suspend in flight; one that never settles is then forgotten. */
export const SUSPEND_WAIT_MS = 300;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Plays synthesized stressor loops. The context is created on first use; buffers are cached by
 * layers + seed (at most 4). Output gain never exceeds the volume setting. Without Web Audio, or when
 * the context cannot start, nothing sounds and nothing throws. When nothing plays and nothing holds it
 * (hold()) for IDLE_SUSPEND_MS the context is suspended; unlock() wakes it (every block with sound and the
 * sound check unlock first).
 */
export function createAudioOut(makeContext: (() => AudioContextLike) | null, synth: typeof renderStressor = renderStressor): AudioOut {
  let ctx: AudioContextLike | null = null;
  let broken = makeContext === null;
  let volume = 0;
  const cache = new Map<string, AudioBufferLike>();
  /** Loops that are playing and switched on: a volume change retargets them. */
  const active = new Set<() => void>();
  /** Loops started and not stopped: the context stays awake while there are any. */
  let playing = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** A suspend() that has not settled yet: a loop started now would be cut by it. */
  let suspending: Promise<void> | null = null;
  /** Holds taken and not released: the context stays awake while there are any. */
  let holds = 0;

  /**
   * Puts the context to sleep IDLE_SUSPEND_MS from now unless a loop starts or a hold is taken first. A failed
   * suspend is ignored.
   */
  const sleepWhenIdle = (c: AudioContextLike): void => {
    clearTimeout(idleTimer);
    if (playing > 0 || holds > 0) return;
    idleTimer = setTimeout(() => {
      if (playing > 0 || holds > 0 || c.state !== 'running') return;
      let pending: Promise<void>;
      try {
        pending = c.suspend();
      } catch {
        return;
      }
      const settled = (): void => {
        if (suspending === tracked) suspending = null;
      };
      const tracked: Promise<void> = pending.then(settled, settled);
      suspending = tracked;
    }, IDLE_SUSPEND_MS);
  };

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
        if (c.state !== 'running' || suspending !== null || volume === 0) return false;
        const source = c.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const gain = c.createGain();
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(c.destination);
        try {
          source.start(c.currentTime + START_DELAY_S, offsetS);
        } catch {
          // A context that went away or a refused offset: no sound, and nothing left in the graph.
          source.disconnect();
          gain.disconnect();
          return false;
        }
        nodes = { source, gain };
        playing++;
        clearTimeout(idleTimer);
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
        playing--;
        // The fade-out (STOP_DELAY_S) is long over by the time the context sleeps.
        sleepWhenIdle(c);
        const release = (): void => {
          source.disconnect();
          gain.disconnect();
        };
        gain.gain.setTargetAtTime(0, c.currentTime, RAMP_TIME_CONSTANT_S);
        try {
          source.onended = release;
          source.stop(c.currentTime + STOP_DELAY_S);
        } catch {
          // Already stopped by the context: nothing left to fade.
          release();
        }
      },
    };
  };

  return {
    get available() {
      return !broken;
    },
    async unlock() {
      const c = context();
      if (c === null) return;
      clearTimeout(idleTimer);
      const inFlight = suspending;
      if (inFlight !== null) {
        let waited: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          inFlight.then(() => true),
          new Promise<boolean>((resolve) => {
            waited = setTimeout(() => {
              resolve(false);
            }, SUSPEND_WAIT_MS);
          }),
        ]);
        clearTimeout(waited);
        // A suspend that never settles must not keep start() silent until a restart.
        if (!settled && suspending === inFlight) suspending = null;
      }
      try {
        if (c.state !== 'running') await c.resume();
      } catch {
        // A blocked device: start() reports false and the block runs without sound.
      }
      sleepWhenIdle(c);
    },
    hold() {
      holds++;
      clearTimeout(idleTimer);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        if (ctx !== null) sleepWhenIdle(ctx);
      };
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
