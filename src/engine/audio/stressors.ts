import { createRng, deriveSeed } from '../rng';

/** Background sound layers, played in headphones during some reaction blocks. */
export type StressorLayer = 'hum' | 'beeps' | 'metronome' | 'babble';

/** Canonical layer order: merges and buffer cache keys use it. */
export const STRESSOR_LAYERS: readonly StressorLayer[] = ['hum', 'beeps', 'metronome', 'babble'];

/** Which layers sound and how loud, as a share of the volume setting (`gain` in [0, 1]). */
export interface AudioStressorParams {
  layers: StressorLayer[];
  gain: number;
}

export const STRESSOR_SAMPLE_RATE = 22050;
/** Length of the synthesized loop, seconds. */
export const STRESSOR_LOOP_S = 20;

/** The finisher and overload blocks add this to the module's own sound (`mergeAudio`). */
export const FINISHER_AUDIO: AudioStressorParams = { layers: ['hum', 'beeps', 'babble'], gain: 0.8 };

export interface Beep {
  atMs: number;
  durMs: number;
  hz: number;
}

const BEEP_TONES = [700, 1000, 1400, 1900] as const;
const BEEP_GAP_MS = [400, 2600] as const;
const BEEP_DUR_MS = [60, 160] as const;
/** Length of one metronome click, ms: a tick only goes in where the whole click fits. */
export const CLICK_MS = 12;
const METRONOME_PERIOD_MS = [550, 850] as const;
const METRONOME_SKIP = 0.1;
const METRONOME_DOUBLE = 0.1;

/** Short tones at random moments; every beep ends inside `durationMs`. */
export function beepSchedule(seed: number, durationMs: number): Beep[] {
  const rng = createRng(deriveSeed(seed, 'beeps'));
  const out: Beep[] = [];
  for (let atMs = rng.int(...BEEP_GAP_MS); ; atMs += rng.int(...BEEP_GAP_MS)) {
    const hz = rng.pick(BEEP_TONES);
    const durMs = rng.int(...BEEP_DUR_MS);
    if (atMs + durMs > durationMs) return out;
    out.push({ atMs, durMs, hz });
  }
}

/**
 * An uneven metronome: beats every `periodMs` from 0; 10 % of beats are skipped, 10 % doubled
 * (an extra tick half a period later). Ticks are ascending and each click ends inside `durationMs`.
 */
export function metronomeSchedule(seed: number, durationMs: number): { periodMs: number; ticks: number[] } {
  const rng = createRng(deriveSeed(seed, 'metronome'));
  const periodMs = rng.int(...METRONOME_PERIOD_MS);
  const ticks: number[] = [];
  const add = (t: number): void => {
    if (t + CLICK_MS <= durationMs) ticks.push(t);
  };
  for (let t = 0; t + CLICK_MS <= durationMs; t += periodMs) {
    const r = rng.next();
    if (r < METRONOME_SKIP) continue;
    add(t);
    if (r < METRONOME_SKIP + METRONOME_DOUBLE) add(t + periodMs / 2);
  }
  return { periodMs, ticks };
}

/** Union of the layers in canonical order and the larger gain; `null` means "no sound". */
export function mergeAudio(a: AudioStressorParams | null, b: AudioStressorParams | null): AudioStressorParams | null {
  if (a === null && b === null) return null;
  const layers = new Set([...(a?.layers ?? []), ...(b?.layers ?? [])]);
  return {
    layers: STRESSOR_LAYERS.filter((l) => layers.has(l)),
    gain: Math.max(a?.gain ?? 0, b?.gain ?? 0),
  };
}
