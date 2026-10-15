import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FLOOR_FACTOR, FLOOR_HITS, FLOOR_MIN_HITS, bandFloors, floorFromHits, p80 } from './windowFloor';

const n = (k: number, v: number) => Array<number>(k).fill(v);

describe('windowFloor constants', () => {
  it('1.2 × P80 of the last 60 clean hits, from 15 (spec §3.1.2)', () => {
    expect([FLOOR_FACTOR, FLOOR_HITS, FLOOR_MIN_HITS]).toEqual([1.2, 60, 15]);
  });
});

describe('p80', () => {
  it('P80 by nearest rank', () => {
    expect(p80([5, 1, 4, 2, 3])).toBe(4);
    expect(p80([10])).toBe(10);
    expect(() => p80([])).toThrow(RangeError);
  });

  it('is the ⌈0.8·k⌉-th smallest value, whatever the order, and leaves its input alone', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 100, max: 2000 }), { minLength: 1, maxLength: 80 }), (xs) => {
        const input = [...xs];
        const sorted = [...xs].sort((a, b) => a - b);
        const rank = Math.ceil((4 * xs.length) / 5);
        expect(p80(xs)).toBe(sorted[rank - 1]);
        expect(sorted.filter((x) => x <= p80(xs)).length).toBeGreaterThanOrEqual(0.8 * xs.length);
        expect(xs).toEqual(input);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('floorFromHits', () => {
  it('a floor needs 15 hits and reads the last 60', () => {
    expect(floorFromHits(n(14, 300), 1.2)).toBeNull();
    expect(floorFromHits(Array.from({ length: 15 }, (_, i) => 300 + i), 1.2)).toBeCloseTo(1.2 * 311, 9);
    expect(floorFromHits([...n(10, 1000), ...n(60, 300)], 1.2)).toBeCloseTo(360, 9);
  });

  it('takes the factor it is given', () => {
    expect(floorFromHits(n(20, 300), 1.05)).toBeCloseTo(315, 9);
  });
});

describe('bandFloors', () => {
  const B = [
    { chain: 1, floorFactor: 1.2 },
    { chain: 1.1, floorFactor: 1.2 },
    { chain: 1.05, floorFactor: 1.2 },
    { chain: 1, floorFactor: 1.15 },
  ];

  it('band 0 without history has no floor', () => {
    expect(bandFloors(new Map(), B)(0)).toBeNull();
    expect(bandFloors(new Map(), B)(2)).toBeNull();
  });

  it('14 hits are not enough: the chain from the band below', () => {
    const f = bandFloors(
      new Map([
        [0, n(20, 300)],
        [2, n(14, 250)],
        [3, n(20, 300)],
      ]),
      B,
    );
    expect(f(0)).toBeCloseTo(360, 9);
    expect(f(1)).toBeCloseTo(396, 9);
    expect(f(2)).toBeCloseTo(415.8, 9);
    expect(f(3)).toBeCloseTo(345, 9); // the tail factor 1.15
  });

  it('a band with its own hits starts the chain again, even below the band under it', () => {
    const f = bandFloors(
      new Map([
        [0, n(20, 500)],
        [1, n(15, 250)],
      ]),
      B,
    );
    expect(f(1)).toBeCloseTo(300, 9);
    expect(f(2)).toBeCloseTo(315, 9);
    expect(f(3)).toBeCloseTo(315, 9);
  });

  it('a band outside the table is a programming error', () => {
    const f = bandFloors(new Map(), B);
    for (const band of [-1, 4, 1.5]) expect(() => f(band), String(band)).toThrow(RangeError);
  });
});
