import { createRng, deriveSeed, type Rng } from '../rng';
import {
  CLICK_MS,
  STRESSOR_LAYERS,
  STRESSOR_LOOP_S,
  STRESSOR_SAMPLE_RATE,
  beepSchedule,
  metronomeSchedule,
  type AudioStressorParams,
  type StressorLayer,
} from './stressors';

/** The loop seam: the 50 ms rendered past the end are crossfaded into the first 50 ms. */
const SEAM_S = 0.05;
/** Candidate start points for the noise layers: the one with the smallest step across the seam is used. */
const LOOP_POINT_SEARCH = 256;
/** Layers that are noise, not events on a schedule: their start point may move. */
const NOISE_LAYERS: readonly StressorLayer[] = ['hum', 'babble'];
const PEAK = 0.9;

const HUM_RMS = 0.1;
/** Brown noise share against pink, by RMS. */
const HUM_BROWN = 0.5;
const BROWN_LEAK = 0.02;

const BEEP_PEAK = 0.35;
const BEEP_EDGE_S = 0.008;

const CLICK_HZ = 2000;
const CLICK_TAU_S = 0.003;
const CLICK_PEAK = 0.3;

const BABBLE_VOICES = 4;
const BABBLE_RMS = 0.08;
const BABBLE_Q = 1;
const SYLLABLE_PAUSE = 0.2;

/** Paul Kellet's refined pink noise filter over the rng's white noise. */
function pinkNoise(rng: Rng, length: number): Float64Array {
  const out = new Float64Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return out;
}

/** White noise integrated with a leak, so it stays bounded. */
function brownNoise(rng: Rng, length: number): Float64Array {
  const out = new Float64Array(length);
  let y = 0;
  for (let i = 0; i < length; i++) {
    y = (1 - BROWN_LEAK) * y + (rng.next() * 2 - 1);
    out[i] = y;
  }
  return out;
}

function rms(x: Float64Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

/** Scales noise `x` in place to the given RMS. */
function toRms(x: Float64Array, target: number): Float64Array {
  const k = target / rms(x);
  for (let i = 0; i < x.length; i++) x[i] = (x[i] as number) * k;
  return x;
}

/** Band-pass biquad (RBJ cookbook, 0 dB peak gain), applied in place. */
function bandPass(x: Float64Array, centerHz: number, q: number, sampleRate: number): Float64Array {
  const w0 = (2 * Math.PI * centerHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i] as number;
    const y0 = b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
  return x;
}

/** Raised-cosine (Hann) bump of `length` samples, 0 at both ends. */
const hann = (j: number, length: number): number => 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / length);

const samplesOf = (ms: number, sampleRate: number): number => Math.round((ms * sampleRate) / 1000);

/** "Office hum": pink and brown noise 1 : 0.5 by RMS, RMS 0.1. */
function hum(seed: number, sampleRate: number, length: number): Float64Array {
  const rng = createRng(deriveSeed(seed, 'hum'));
  const pink = toRms(pinkNoise(rng, length), 1);
  const brown = toRms(brownNoise(rng, length), HUM_BROWN);
  for (let i = 0; i < length; i++) pink[i] = (pink[i] as number) + (brown[i] as number);
  return toRms(pink, HUM_RMS);
}

/** Sine beeps of beepSchedule with 8 ms raised-cosine edges, peak 0.35. */
function beeps(seed: number, sampleRate: number, length: number, loopLength: number): Float64Array {
  const out = new Float64Array(length);
  const edge = Math.max(1, Math.round(BEEP_EDGE_S * sampleRate));
  for (const b of beepSchedule(seed, (loopLength * 1000) / sampleRate)) {
    const start = samplesOf(b.atMs, sampleRate);
    const len = samplesOf(b.durMs, sampleRate);
    for (let j = 0; j < len; j++) {
      const env = j < edge ? hann(j, 2 * edge) : j >= len - edge ? hann(len - j, 2 * edge) : 1;
      out[start + j] = BEEP_PEAK * env * Math.sin((2 * Math.PI * b.hz * j) / sampleRate);
    }
  }
  return out;
}

/** 2 kHz clicks at the metronomeSchedule ticks: 12 ms with a 3 ms decay, peak 0.3. */
function metronome(seed: number, sampleRate: number, length: number, loopLength: number): Float64Array {
  const out = new Float64Array(length);
  const click = new Float64Array(samplesOf(CLICK_MS, sampleRate));
  for (let j = 0; j < click.length; j++) {
    click[j] = Math.sin((2 * Math.PI * CLICK_HZ * j) / sampleRate) * Math.exp(-j / (CLICK_TAU_S * sampleRate));
  }
  const peak = click.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  for (const t of metronomeSchedule(seed, (loopLength * 1000) / sampleRate).ticks) {
    const start = samplesOf(t, sampleRate);
    for (let j = 0; j < click.length; j++) out[start + j] = (CLICK_PEAK * (click[j] as number)) / peak;
  }
  return out;
}

/**
 * Four synthetic "voices" (no recordings): band-passed pink noise under a syllable envelope of
 * raised-cosine bumps 120–280 ms with amplitude 0.3–1, a 150–500 ms pause after 20 % of syllables.
 */
function babble(seed: number, sampleRate: number, length: number): Float64Array {
  const rng = createRng(deriveSeed(seed, 'babble'));
  const out = new Float64Array(length);
  for (let v = 0; v < BABBLE_VOICES; v++) {
    const voice = toRms(bandPass(pinkNoise(rng, length), rng.int(400, 1200), BABBLE_Q, sampleRate), 1);
    let at = 0;
    while (at < length) {
      const len = samplesOf(rng.int(120, 280), sampleRate);
      const amp = 0.3 + 0.7 * rng.next();
      for (let j = 0; j < len && at + j < length; j++) {
        out[at + j] = (out[at + j] as number) + (amp * hann(j, len) * (voice[at + j] as number)) / BABBLE_VOICES;
      }
      at += len;
      if (rng.next() < SYLLABLE_PAUSE) at += samplesOf(rng.int(150, 500), sampleRate);
    }
  }
  return toRms(out, BABBLE_RMS);
}

const RENDER: Record<StressorLayer, (seed: number, sampleRate: number, length: number, loopLength: number) => Float64Array> = {
  hum,
  beeps,
  metronome,
  babble,
};

/**
 * One mono loop of the given layers, deterministic per seed (`p.gain` is applied at playback).
 * The layers are rendered 50 ms past the loop end and that tail is crossfaded (equal power) into
 * the first 50 ms, so the last sample runs straight on into the first. The noise layers start at
 * the point (within 256 samples) where their own step across that seam is smallest, so the loop
 * closes without a click; beeps and clicks keep their schedule. Peak ≤ 0.9.
 */
export function renderStressor(
  p: AudioStressorParams,
  seed: number,
  sampleRate: number = STRESSOR_SAMPLE_RATE,
  seconds: number = STRESSOR_LOOP_S,
): Float32Array<ArrayBuffer> {
  const n = Math.round(sampleRate * seconds);
  const seam = Math.min(n, Math.round(SEAM_S * sampleRate));
  const mix = new Float64Array(n + seam);
  const noise = new Float64Array(n + seam + LOOP_POINT_SEARCH);
  for (const layer of STRESSOR_LAYERS) {
    if (!p.layers.includes(layer)) continue;
    const into = NOISE_LAYERS.includes(layer) ? noise : mix;
    const x = RENDER[layer](seed, sampleRate, into.length, n);
    for (let i = 0; i < into.length; i++) into[i] = (into[i] as number) + (x[i] as number);
  }
  let start = 0;
  let step = Infinity;
  for (let o = 0; o < LOOP_POINT_SEARCH; o++) {
    const d = Math.abs((noise[o + n] as number) - (noise[o + n - 1] as number));
    if (d < step) [start, step] = [o, d];
  }
  for (let i = 0; i < mix.length; i++) mix[i] = (mix[i] as number) + (noise[start + i] as number);
  for (let i = 0; i < seam; i++) {
    const phase = (Math.PI / 2) * (i / seam);
    mix[i] = (mix[i] as number) * Math.sin(phase) + (mix[n + i] as number) * Math.cos(phase);
  }
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mix[i] as number));
  const scale = peak > PEAK ? PEAK / peak : 1;
  for (let i = 0; i < n; i++) out[i] = (mix[i] as number) * scale;
  return out;
}
