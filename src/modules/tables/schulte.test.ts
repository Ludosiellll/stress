import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../engine/rng';
import { generateSchulteTable, schulteParams } from './schulte';

const levelPair = fc
  .tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a]));

describe('schulteParams', () => {
  it.each([
    [0, 5, 60000],
    [8, 6, 86400],
    [40, 9, undefined],
  ])('L=%i → size %i', (L, size, timeLimitMs) => {
    const p = schulteParams(L);
    expect(p.size).toBe(size);
    expect(p.reshuffleEvery).toBeNull();
    if (timeLimitMs !== undefined) expect(p.timeLimitMs).toBe(timeLimitMs);
  });

  it('size steps at multiples of 8 and caps at 9', () => {
    expect(schulteParams(7.9).size).toBe(5);
    expect(schulteParams(16).size).toBe(7);
    expect(schulteParams(24).size).toBe(8);
    expect(schulteParams(32).size).toBe(9);
    expect(schulteParams(1000).size).toBe(9);
  });

  it('monotone: size non-decreasing and <= 9', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        expect(schulteParams(b).size).toBeGreaterThanOrEqual(schulteParams(a).size);
        expect(schulteParams(b).size).toBeLessThanOrEqual(9);
      }),
      { numRuns: 1000 },
    );
  });

  it('time limit is never below size² · 400', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1000, noNaN: true }), (L) => {
        const { size, timeLimitMs } = schulteParams(L);
        expect(timeLimitMs).toBeGreaterThanOrEqual(size * size * 400);
        expect(Number.isFinite(timeLimitMs)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('generateSchulteTable', () => {
  it('contains each of 1..n² exactly once, all black', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 0, max: 0xffffffff }), (n, seed) => {
        const cells = generateSchulteTable(n, createRng(seed));
        expect(cells).toHaveLength(n * n);
        expect(cells.every((c) => c.color === 'black')).toBe(true);
        expect(cells.map((c) => c.value).sort((x, y) => x - y)).toEqual(
          Array.from({ length: n * n }, (_, i) => i + 1),
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('is shuffled and deterministic per seed', () => {
    expect(generateSchulteTable(5, createRng(1))).toEqual(generateSchulteTable(5, createRng(1)));
    expect(generateSchulteTable(5, createRng(1))).not.toEqual(generateSchulteTable(5, createRng(2)));
  });

  it('rejects invalid sizes', () => {
    expect(() => generateSchulteTable(0, createRng(1))).toThrow(RangeError);
    expect(() => generateSchulteTable(2.5, createRng(1))).toThrow(RangeError);
  });
});
