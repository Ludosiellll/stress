import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed, hashString } from './rng';

describe('createRng', () => {
  it('same seed gives the same sequence of 100 next()', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const sa = Array.from({ length: 100 }, () => a.next());
    const sb = Array.from({ length: 100 }, () => b.next());
    expect(sa).toEqual(sb);
  });

  it('different seeds give different sequences', () => {
    const a = createRng(1);
    const b = createRng(2);
    const sa = Array.from({ length: 10 }, () => a.next());
    const sb = Array.from({ length: 10 }, () => b.next());
    expect(sa).not.toEqual(sb);
  });

  it('next() is within [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const rng = createRng(seed);
        for (let i = 0; i < 20; i++) {
          const x = rng.next();
          if (x < 0 || x >= 1) return false;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('int(min,max) is inclusive and within bounds', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: -1e6, max: 1e6 }),
        fc.integer({ min: 0, max: 1e6 }),
        (seed, min, span) => {
          const max = min + span;
          const rng = createRng(seed);
          for (let i = 0; i < 10; i++) {
            const v = rng.int(min, max);
            if (!Number.isInteger(v) || v < min || v > max) return false;
          }
          return true;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('int hits both ends of a small range', () => {
    const rng = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(rng.int(3, 5));
    expect([...seen].sort()).toEqual([3, 4, 5]);
  });

  it('int(n, n) returns n', () => {
    expect(createRng(1).int(4, 4)).toBe(4);
  });

  it('int throws on non-integer bounds or min > max', () => {
    const rng = createRng(1);
    expect(() => rng.int(0.5, 3)).toThrow();
    expect(() => rng.int(0, 2.5)).toThrow();
    expect(() => rng.int(5, 4)).toThrow();
    expect(() => rng.int(Number.NaN, 4)).toThrow();
  });

  it('pick returns an element and throws on empty array', () => {
    const rng = createRng(3);
    const xs = ['a', 'b', 'c'];
    for (let i = 0; i < 20; i++) expect(xs).toContain(rng.pick(xs));
    expect(() => rng.pick([])).toThrow();
  });

  it('shuffle is a permutation and does not mutate input', () => {
    fc.assert(
      fc.property(fc.integer(), fc.array(fc.integer(), { maxLength: 50 }), (seed, xs) => {
        const copy = [...xs];
        const out = createRng(seed).shuffle(xs);
        expect(xs).toEqual(copy);
        expect([...out].sort((p, q) => p - q)).toEqual([...xs].sort((p, q) => p - q));
      }),
      { numRuns: 1000 },
    );
  });

  it('shuffle is deterministic per seed', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(createRng(9).shuffle(xs)).toEqual(createRng(9).shuffle(xs));
  });
});

describe('hashString', () => {
  it("hashString('abc') === 440920331", () => {
    expect(hashString('abc')).toBe(440920331);
  });

  it('empty string is the FNV offset basis', () => {
    expect(hashString('')).toBe(0x811c9dc5);
  });

  it('is an unsigned 32-bit integer', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const h = hashString(s);
        return Number.isInteger(h) && h >= 0 && h <= 0xffffffff;
      }),
      { numRuns: 1000 },
    );
  });
});

describe('deriveSeed', () => {
  it('is deterministic and equals hashString(seed>>>0 + ":" + salt)', () => {
    expect(deriveSeed(42, 'x')).toBe(deriveSeed(42, 'x'));
    expect(deriveSeed(-1, 'x')).toBe(hashString('4294967295:x'));
  });

  it('distinct salts give distinct seeds', () => {
    expect(deriveSeed(42, 'a')).not.toBe(deriveSeed(42, 'b'));
  });
});
