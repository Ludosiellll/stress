import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FINISHER_AUDIO,
  STRESSOR_LAYERS,
  STRESSOR_LOOP_S,
  STRESSOR_SAMPLE_RATE,
  beepSchedule,
  mergeAudio,
  metronomeSchedule,
  type AudioStressorParams,
} from './stressors';

const LOOP_MS = STRESSOR_LOOP_S * 1000;

describe('stressor constants', () => {
  it('are mono 22 050 Hz, a 20 s loop, four layers in canonical order and the finisher sound', () => {
    expect(STRESSOR_SAMPLE_RATE).toBe(22050);
    expect(STRESSOR_LOOP_S).toBe(20);
    expect(STRESSOR_LAYERS).toEqual(['hum', 'beeps', 'metronome', 'babble']);
    expect(FINISHER_AUDIO).toEqual({ layers: ['hum', 'beeps', 'babble'], gain: 0.8 });
  });
});

describe('beepSchedule', () => {
  it('is deterministic per seed and differs between seeds', () => {
    expect(beepSchedule(7, LOOP_MS)).toEqual(beepSchedule(7, LOOP_MS));
    expect(beepSchedule(7, LOOP_MS)).not.toEqual(beepSchedule(8, LOOP_MS));
  });

  it('keeps gaps between onsets in [400, 2600], lengths in [60, 160], the four tones, all inside the duration', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 60_000 }), (seed, durationMs) => {
        const beeps = beepSchedule(seed, durationMs);
        for (const [i, b] of beeps.entries()) {
          expect(b.durMs).toBeGreaterThanOrEqual(60);
          expect(b.durMs).toBeLessThanOrEqual(160);
          expect([700, 1000, 1400, 1900]).toContain(b.hz);
          expect(b.atMs).toBeGreaterThanOrEqual(0);
          expect(b.atMs + b.durMs).toBeLessThanOrEqual(durationMs);
          const prev = beeps[i - 1];
          if (prev !== undefined) {
            expect(b.atMs - prev.atMs).toBeGreaterThanOrEqual(400);
            expect(b.atMs - prev.atMs).toBeLessThanOrEqual(2600);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('fills a 20 s loop with several beeps', () => {
    expect(beepSchedule(1, LOOP_MS).length).toBeGreaterThanOrEqual(7);
  });
});

describe('metronomeSchedule', () => {
  it('is deterministic per seed', () => {
    expect(metronomeSchedule(3, LOOP_MS)).toEqual(metronomeSchedule(3, LOOP_MS));
  });

  it('keeps the period in [550, 850] and every tick with its 12 ms click inside the duration', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 30_000 }), (seed, durationMs) => {
        const { periodMs, ticks } = metronomeSchedule(seed, durationMs);
        expect(Number.isInteger(periodMs)).toBe(true);
        expect(periodMs).toBeGreaterThanOrEqual(550);
        expect(periodMs).toBeLessThanOrEqual(850);
        for (const [i, t] of ticks.entries()) {
          expect(t).toBeGreaterThanOrEqual(0);
          expect(t + 12).toBeLessThanOrEqual(durationMs);
          if (i > 0) expect(t).toBeGreaterThan(ticks[i - 1] ?? Infinity);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('skips and doubles about 10 % of 10 000 beats each', () => {
    for (const seed of [1, 2, 3]) {
      const probe = metronomeSchedule(seed, 0).periodMs;
      const beats = 10_000;
      const { periodMs, ticks } = metronomeSchedule(seed, beats * probe);
      expect(periodMs).toBe(probe);
      const at = new Set(ticks);
      let skipped = 0;
      for (let k = 0; k < beats; k++) if (!at.has(k * periodMs)) skipped++;
      // Every tick off the beat grid is a double: half a period after a played beat.
      const extra = ticks.filter((t) => t % periodMs !== 0);
      for (const t of extra) expect(at.has(t - periodMs / 2)).toBe(true);
      const doubled = extra.length;
      expect(skipped / beats, `seed ${String(seed)} skipped`).toBeGreaterThanOrEqual(0.07);
      expect(skipped / beats, `seed ${String(seed)} skipped`).toBeLessThanOrEqual(0.13);
      expect(doubled / beats, `seed ${String(seed)} doubled`).toBeGreaterThanOrEqual(0.07);
      expect(doubled / beats, `seed ${String(seed)} doubled`).toBeLessThanOrEqual(0.13);
    }
  });
});

describe('mergeAudio', () => {
  const hum: AudioStressorParams = { layers: ['hum'], gain: 0.5 };

  it('joins the layers in canonical order without repeats and takes the larger gain', () => {
    expect(mergeAudio({ layers: ['babble', 'hum'], gain: 0.95 }, FINISHER_AUDIO)).toEqual({
      layers: ['hum', 'beeps', 'babble'],
      gain: 0.95,
    });
    expect(mergeAudio({ layers: ['metronome', 'hum'], gain: 0.5 }, FINISHER_AUDIO)).toEqual({
      layers: ['hum', 'beeps', 'metronome', 'babble'],
      gain: 0.8,
    });
  });

  it('returns the other side when one is null, and null for two nulls', () => {
    expect(mergeAudio(null, hum)).toEqual(hum);
    expect(mergeAudio(hum, null)).toEqual(hum);
    expect(mergeAudio(null, null)).toBeNull();
  });

  it('never hands out the argument itself', () => {
    const merged = mergeAudio(null, FINISHER_AUDIO);
    merged?.layers.push('metronome');
    expect(FINISHER_AUDIO.layers).toEqual(['hum', 'beeps', 'babble']);
  });
});
