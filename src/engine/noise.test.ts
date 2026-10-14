import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FLICKER_HALF_PERIOD_MS,
  NOISE_EXCLUSION_RADIUS,
  flickerOn,
  noiseFrame,
  noiseSlots,
  type VisualNoiseParams,
} from './noise';
import { COLOR_IDS, SHAPE_IDS, type ColorId, type ShapeId } from './reaction/types';

const EPS = 1e-9;

const PAIRS = SHAPE_IDS.flatMap((shape) => COLOR_IDS.map((color) => ({ shape, color })));

/** Up to 3 forbidden pairs: with farOnly at least 3 colours and the 5 shapes other than the circle stay. */
const paramsArb: fc.Arbitrary<VisualNoiseParams> = fc.record({
  distractors: fc.integer({ min: 0, max: 14 }),
  lifetimeMs: fc.integer({ min: 120, max: 1000 }),
  flicker: fc.boolean(),
  farOnly: fc.boolean(),
  forbidden: fc.subarray(PAIRS, { maxLength: 3 }),
});
const seedArb = fc.integer({ min: 0, max: 0xffffffff });
const elapsedArb = fc.double({ min: 0, max: 600_000, noNaN: true });
const boxArb = fc.record({
  halfW: fc.double({ min: 0.5, max: 1.2, noNaN: true }),
  halfH: fc.double({ min: 0.5, max: 1.2, noNaN: true }),
});

const BASE: VisualNoiseParams = {
  distractors: 4,
  lifetimeMs: 1000,
  flicker: true,
  farOnly: false,
  forbidden: [{ shape: 'circle', color: 'red' }],
};
const BOX = { halfW: 0.8, halfH: 0.5 };

describe('noise constants', () => {
  it('central zone 0.2 of the shorter side, flicker half period 250 ms (2 Hz)', () => {
    expect(NOISE_EXCLUSION_RADIUS).toBe(0.2);
    expect(FLICKER_HALF_PERIOD_MS).toBe(250);
  });
});

describe('noiseFrame', () => {
  it('exactly `distractors` figures, each out of the central zone, inside the box, size in [0.06, 0.10]', () => {
    fc.assert(
      fc.property(paramsArb, seedArb, elapsedArb, boxArb, (p, seed, t, box) => {
        const frame = noiseFrame(p, seed, t, box);
        expect(frame).toHaveLength(p.distractors);
        for (const d of frame) {
          expect(d.size).toBeGreaterThanOrEqual(0.06);
          expect(d.size).toBeLessThanOrEqual(0.1);
          expect(Math.hypot(d.x, d.y)).toBeGreaterThanOrEqual(NOISE_EXCLUSION_RADIUS + d.size / 2 - EPS);
          expect(Math.abs(d.x) + d.size / 2).toBeLessThanOrEqual(box.halfW + EPS);
          expect(Math.abs(d.y) + d.size / 2).toBeLessThanOrEqual(box.halfH + EPS);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('never a forbidden pair; farOnly: no circles and no colour of a forbidden pair', () => {
    fc.assert(
      fc.property(paramsArb, seedArb, elapsedArb, (p, seed, t) => {
        const targetColors = new Set(p.forbidden.map((f) => f.color));
        for (const d of noiseFrame(p, seed, t, BOX)) {
          expect(p.forbidden.some((f) => f.shape === d.shape && f.color === d.color)).toBe(false);
          if (p.farOnly) {
            expect(d.shape).not.toBe('circle');
            expect(targetColors.has(d.color)).toBe(false);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('the same inputs give the same frame', () => {
    fc.assert(
      fc.property(paramsArb, seedArb, elapsedArb, boxArb, (p, seed, t, box) => {
        expect(noiseFrame(p, seed, t, box)).toEqual(noiseFrame(p, seed, t, box));
      }),
      { numRuns: 1000 },
    );
  });

  it('a figure does not move inside its slot', () => {
    fc.assert(
      fc.property(paramsArb, seedArb, elapsedArb, fc.double({ min: 0, max: 2000, noNaN: true }), (p, seed, t, dt) => {
        const a = noiseFrame(p, seed, t, BOX);
        const b = noiseFrame(p, seed, t + dt, BOX);
        const slotsA = noiseSlots(p, t);
        const slotsB = noiseSlots(p, t + dt);
        a.forEach((d, j) => {
          if (slotsA[j] === slotsB[j]) expect(b[j]).toEqual(d);
        });
      }),
      { numRuns: 1000 },
    );
  });

  it('figure j changes every lifetimeMs, shifted by j · lifetimeMs / distractors', () => {
    // 4 figures, 1000 ms: figure 1 changes at 750, 1750, …; figure 0 at 1000, 2000, …
    expect(noiseSlots(BASE, 0)).toEqual([0, 0, 0, 0]);
    expect(noiseSlots(BASE, 249.9)).toEqual([0, 0, 0, 0]);
    expect(noiseSlots(BASE, 250)).toEqual([0, 0, 0, 1]);
    expect(noiseSlots(BASE, 750)).toEqual([0, 1, 1, 1]);
    expect(noiseSlots(BASE, 1000)).toEqual([1, 1, 1, 1]);
    const before = noiseFrame(BASE, 7, 749, BOX);
    const after = noiseFrame(BASE, 7, 750, BOX);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).not.toEqual(before[1]);
    expect(noiseFrame(BASE, 7, 999, BOX)[0]).toEqual(noiseFrame(BASE, 7, 0, BOX)[0]);
    expect(noiseFrame(BASE, 7, 1000, BOX)[0]).not.toEqual(noiseFrame(BASE, 7, 0, BOX)[0]);
  });

  it('draws from every allowed pair', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 300; seed++) {
      for (const d of noiseFrame({ ...BASE, distractors: 14 }, seed, 0, BOX)) seen.add(`${d.shape}:${d.color}`);
    }
    expect(seen.size).toBe(35);
    expect(seen.has('circle:red')).toBe(false);
    const far = new Set<string>();
    const farParams: VisualNoiseParams = {
      ...BASE,
      distractors: 14,
      farOnly: true,
      forbidden: [
        { shape: 'circle', color: 'red' },
        { shape: 'circle', color: 'green' },
      ],
    };
    for (let seed = 0; seed < 300; seed++) {
      for (const d of noiseFrame(farParams, seed, 0, BOX)) far.add(`${d.shape}:${d.color}`);
    }
    const farShapes: ShapeId[] = ['square', 'triangle', 'diamond', 'hexagon', 'star'];
    const farColors: ColorId[] = ['yellow', 'blue', 'white', 'purple'];
    expect([...far].sort()).toEqual(farShapes.flatMap((s) => farColors.map((c) => `${s}:${c}`)).sort());
  });

  it('with no room outside the zone a figure goes on the edge of the zone', () => {
    // A box smaller than the zone: every one of the 20 tries lands inside it.
    for (const d of noiseFrame({ ...BASE, distractors: 6 }, 3, 0, { halfW: 0.1, halfH: 0.1 })) {
      expect(Math.hypot(d.x, d.y)).toBeCloseTo(NOISE_EXCLUSION_RADIUS + d.size / 2, 12);
    }
  });

  it('no figures without distractors; throws when no pair is allowed', () => {
    expect(noiseFrame({ ...BASE, distractors: 0 }, 1, 0, BOX)).toEqual([]);
    expect(() => noiseFrame({ ...BASE, forbidden: PAIRS }, 1, 0, BOX)).toThrow(RangeError);
    const allColors = COLOR_IDS.map((color) => ({ shape: 'square' as const, color }));
    expect(() => noiseFrame({ ...BASE, farOnly: true, forbidden: allColors }, 1, 0, BOX)).toThrow(RangeError);
  });
});

describe('flickerOn', () => {
  it('off on [0, 250), on on [250, 500): a 500 ms period', () => {
    expect([0, 249.9, 250, 499.9, 500, 750].map((t) => flickerOn(BASE, t))).toEqual([false, false, true, true, false, true]);
  });

  it('follows floor(t / 250) mod 2 with flicker; never without it', () => {
    fc.assert(
      fc.property(elapsedArb, (t) => {
        expect(flickerOn(BASE, t)).toBe(Math.floor(t / FLICKER_HALF_PERIOD_MS) % 2 === 1);
        expect(flickerOn({ ...BASE, flicker: false }, t)).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});
