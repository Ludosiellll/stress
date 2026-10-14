import { describe, expect, it } from 'vitest';
import { CLICK_MS, STRESSOR_LAYERS, STRESSOR_LOOP_S, STRESSOR_SAMPLE_RATE, beepSchedule, metronomeSchedule, type StressorLayer } from './stressors';
import { renderStressor } from './synth';

const N = STRESSOR_SAMPLE_RATE * STRESSOR_LOOP_S;
const LOOP_MS = STRESSOR_LOOP_S * 1000;
/** The first and last 50 ms: the loop seam crossfade. */
const EDGE = Math.round(0.05 * STRESSOR_SAMPLE_RATE);

const only = (layer: StressorLayer, seed = 11): Float32Array => renderStressor({ layers: [layer], gain: 1 }, seed);
const sampleOf = (ms: number): number => Math.round((ms * STRESSOR_SAMPLE_RATE) / 1000);
const inBody = (i: number): boolean => i >= EDGE && i < N - EDGE;

function meanSquare(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] ?? 0) ** 2;
  return s / (to - from);
}

/** Marks every sample covered by one of the [from, to) ranges. */
function mask(ranges: readonly (readonly [number, number])[]): Uint8Array {
  const m = new Uint8Array(N);
  for (const [from, to] of ranges) m.fill(1, Math.max(0, from), Math.min(N, to));
  return m;
}

/** Each full render takes tens of milliseconds, several times that under coverage. */
const SLOW = { timeout: 30_000 };

describe('renderStressor', SLOW, () => {
  it('renders 20 s at 22 050 Hz, deterministic per seed, finite and within ±0.9', () => {
    const all = { layers: [...STRESSOR_LAYERS], gain: 1 };
    const a = renderStressor(all, 5);
    expect(a.length).toBe(441_000);
    expect(renderStressor(all, 5)).toEqual(a);
    expect(renderStressor(all, 6)).not.toEqual(a);
    expect(a.every((v) => Number.isFinite(v))).toBe(true);
    const peak = a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeLessThanOrEqual(0.9);
    expect(peak).toBeGreaterThan(0.1);
  });

  it('keeps every single layer within ±0.9 as well', () => {
    for (const layer of STRESSOR_LAYERS) {
      expect(only(layer).reduce((m, v) => Math.max(m, Math.abs(v)), 0), layer).toBeLessThanOrEqual(0.9);
    }
  });

  it('renders silence for no layers and honours sample rate and length', () => {
    const silent = renderStressor({ layers: [], gain: 1 }, 1);
    expect(silent.length).toBe(N);
    expect(silent.every((v) => v === 0)).toBe(true);
    expect(renderStressor({ layers: ['hum'], gain: 1 }, 1, 8000, 2).length).toBe(16_000);
  });

  it('hum is a low rumble: mean squared step below 0.4 of the mean square (white noise ≈ 2)', () => {
    for (const seed of [1, 2, 3]) {
      const x = only('hum', seed);
      let steps = 0;
      for (let i = 1; i < x.length; i++) steps += ((x[i] ?? 0) - (x[i - 1] ?? 0)) ** 2;
      expect(steps / (x.length - 1) / meanSquare(x)).toBeLessThan(0.4);
      expect(Math.sqrt(meanSquare(x))).toBeCloseTo(0.1, 1);
    }
  });

  it('beeps sound only inside the beepSchedule beeps: RMS inside ≥ 10 × RMS outside', () => {
    const seed = 21;
    const x = only('beeps', seed);
    const inside = mask(beepSchedule(seed, LOOP_MS).map((b) => [sampleOf(b.atMs), sampleOf(b.atMs + b.durMs)] as const));
    let sIn = 0;
    let nIn = 0;
    let sOut = 0;
    let nOut = 0;
    for (let i = EDGE; i < N - EDGE; i++) {
      const e = (x[i] ?? 0) ** 2;
      if (inside[i] === 1) {
        sIn += e;
        nIn++;
      } else {
        sOut += e;
        nOut++;
      }
    }
    expect(nIn).toBeGreaterThan(0);
    expect(Math.sqrt(sIn / nIn)).toBeGreaterThanOrEqual(10 * Math.sqrt(sOut / Math.max(1, nOut)));
    expect(x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeCloseTo(0.35, 2);
  });

  it('metronome puts ≥ 95 % of its energy in the 30 ms after the metronomeSchedule ticks', () => {
    const seed = 4;
    const x = only('metronome', seed);
    const after = mask(metronomeSchedule(seed, LOOP_MS).ticks.map((t) => [sampleOf(t), sampleOf(t + 30)] as const));
    let near = 0;
    let total = 0;
    for (let i = 0; i < N; i++) {
      if (!inBody(i)) continue;
      const e = (x[i] ?? 0) ** 2;
      total += e;
      if (after[i] === 1) near += e;
    }
    expect(total).toBeGreaterThan(0);
    expect(near / total).toBeGreaterThanOrEqual(0.95);
  });

  it('the metronome tick at 0 is as loud as the others: the seam crossfade leaves it whole (B4)', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8].filter((seed) => metronomeSchedule(seed, LOOP_MS).ticks[0] === 0);
    expect(seeds.length).toBeGreaterThan(0);
    for (const seed of seeds) {
      const x = only('metronome', seed);
      let peak = 0;
      for (let i = 0; i < sampleOf(CLICK_MS); i++) peak = Math.max(peak, Math.abs(x[i] ?? 0));
      expect(peak, `seed ${String(seed)}`).toBeCloseTo(0.3, 2);
    }
  });

  it('babble has RMS in [0.04, 0.12] and is modulated: CV of 50 ms window RMS ≥ 0.2', () => {
    for (const seed of [1, 2, 3]) {
      const x = only('babble', seed);
      const rms = Math.sqrt(meanSquare(x));
      expect(rms).toBeGreaterThanOrEqual(0.04);
      expect(rms).toBeLessThanOrEqual(0.12);
      const win = sampleOf(50);
      const windows: number[] = [];
      for (let from = 0; from + win <= N; from += win) windows.push(Math.sqrt(meanSquare(x, from, from + win)));
      const mean = windows.reduce((a, b) => a + b, 0) / windows.length;
      const sd = Math.sqrt(windows.reduce((a, b) => a + (b - mean) ** 2, 0) / windows.length);
      expect(sd / mean).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('closes the loop without a click: |x[last] − x[0]| ≤ 0.05', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const x = renderStressor({ layers: [...STRESSOR_LAYERS], gain: 1 }, seed);
      expect(Math.abs((x[N - 1] ?? 0) - (x[0] ?? 0)), `seed ${String(seed)}`).toBeLessThanOrEqual(0.05);
    }
  });
});
