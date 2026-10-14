import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../engine/rng';
import { generateMemoryTrials, spanProtocolTrials } from './generate';
import { MEMORY_LETTERS, memoryParams, type MemoryMode } from './params';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const MODES: readonly MemoryMode[] = ['digits', 'letters', 'positions', 'card'];

const level = fc.integer({ min: 0, max: 60 });
const seed = fc.integer({ min: 0, max: 0xffffffff });
const mode = fc.constantFrom(...MODES);

describe('generateMemoryTrials', () => {
  it('count trials of the mode; every row has the level length and its timing', () => {
    fc.assert(
      fc.property(level, mode, seed, fc.integer({ min: 0, max: 8 }), (L, m, s, count) => {
        const p = memoryParams(L);
        const trials = generateMemoryTrials(p, m, count, createRng(s));
        expect(trials).toHaveLength(count);
        for (const t of trials) {
          expect(t.mode).toBe(m);
          expect(t.items).toHaveLength(p.length);
          expect(t.itemMs).toBe(p.itemMs);
          expect(t.gapMs).toBe(p.gapMs);
          expect(t.cardMs).toBe(p.length * p.itemMs);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('sequential modes never repeat an item twice in a row', () => {
    fc.assert(
      fc.property(level, fc.constantFrom<MemoryMode>('digits', 'letters', 'positions'), seed, (L, m, s) => {
        for (const t of generateMemoryTrials(memoryParams(L), m, 3, createRng(s))) {
          t.items.forEach((x, i) => {
            if (i > 0) expect(x).not.toBe(t.items[i - 1]);
          });
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('digits are 0–9 and letters come from the set; no grid for them', () => {
    fc.assert(
      fc.property(level, seed, (L, s) => {
        const [d] = generateMemoryTrials(memoryParams(L), 'digits', 1, createRng(s));
        const [l] = generateMemoryTrials(memoryParams(L), 'letters', 1, createRng(s));
        expect(d?.items.every((x) => DIGITS.includes(x))).toBe(true);
        expect(l?.items.every((x) => MEMORY_LETTERS.includes(x))).toBe(true);
        expect(d?.gridSide).toBe(0);
        expect(l?.gridSide).toBe(0);
      }),
      { numRuns: 1000 },
    );
  });

  it('positions: distinct cells of a max(3, ceil(sqrt(length + 3))) grid', () => {
    fc.assert(
      fc.property(level, seed, (L, s) => {
        const p = memoryParams(L);
        const [t] = generateMemoryTrials(p, 'positions', 1, createRng(s));
        const side = Math.max(3, Math.ceil(Math.sqrt(p.length + 3)));
        expect(t?.gridSide).toBe(side);
        const cells = t?.items.map(Number) ?? [];
        expect(new Set(cells).size).toBe(p.length);
        for (const c of cells) {
          expect(Number.isInteger(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThan(side * side);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('card: digits on a max(3, ceil(sqrt(length))) card shown length·itemMs', () => {
    fc.assert(
      fc.property(level, seed, (L, s) => {
        const p = memoryParams(L);
        const [t] = generateMemoryTrials(p, 'card', 1, createRng(s));
        expect(t?.gridSide).toBe(Math.max(3, Math.ceil(Math.sqrt(p.length))));
        expect(t?.items.every((x) => DIGITS.includes(x))).toBe(true);
        expect(t?.cardMs).toBe(p.length * p.itemMs);
      }),
      { numRuns: 1000 },
    );
  });

  it('the same seed gives the same trials; another seed usually differs', () => {
    fc.assert(
      fc.property(level, mode, seed, (L, m, s) => {
        const p = memoryParams(L);
        expect(generateMemoryTrials(p, m, 6, createRng(s))).toEqual(generateMemoryTrials(p, m, 6, createRng(s)));
      }),
      { numRuns: 1000 },
    );
    const p = memoryParams(9);
    expect(generateMemoryTrials(p, 'digits', 6, createRng(1))).not.toEqual(generateMemoryTrials(p, 'digits', 6, createRng(2)));
  });

  it('rejects a negative or fractional count', () => {
    expect(() => generateMemoryTrials(memoryParams(0), 'digits', -1, createRng(1))).toThrow(RangeError);
    expect(() => generateMemoryTrials(memoryParams(0), 'digits', 1.5, createRng(1))).toThrow(RangeError);
  });
});

describe('spanProtocolTrials', () => {
  it('20 digit trials of lengths 3, 3, 4, 4, …, 12, 12 at 1000 / 250 ms', () => {
    const trials = spanProtocolTrials(createRng(7));
    expect(trials.map((t) => t.items.length)).toEqual([3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12]);
    for (const t of trials) {
      expect(t.mode).toBe('digits');
      expect(t.itemMs).toBe(1000);
      expect(t.gapMs).toBe(250);
      expect(t.items.every((x) => DIGITS.includes(x))).toBe(true);
      t.items.forEach((x, i) => {
        if (i > 0) expect(x).not.toBe(t.items[i - 1]);
      });
    }
    expect(spanProtocolTrials(createRng(7))).toEqual(trials);
  });
});
