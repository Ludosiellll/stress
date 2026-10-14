import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../engine/rng';
import { BASE_DIFFICULTY, FAMILIES, SHOWN_LENGTH, fitFamily, generateTerms, type FamilyId } from './families';

// ---------- independent reference builders (test oracle) ----------

const span = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const nonZero = (min: number, max: number): number[] => span(min, max).filter((v) => v !== 0);

/** Terms t_0..t_{count−1} where t_i = next(i, terms so far). */
function build(count: number, next: (i: number, t: readonly number[]) => number): number[] {
  const t: number[] = [];
  for (let i = 0; i < count; i++) t.push(next(i, t));
  return t;
}
const prev = (t: readonly number[], back: number): number => t[t.length - back] as number;

const ref = {
  arith: (n: number, a: number, d: number) => build(n, (i) => a + i * d),
  geom: (n: number, a: number, r: number) => build(n, (i) => a * r ** i),
  second: (n: number, a: number, d0: number, e: number) =>
    build(n, (i, t) => (i === 0 ? a : prev(t, 1) + d0 + (i - 1) * e)),
  alt: (n: number, a1: number, a2: number, d1: number, d2: number) =>
    build(n, (i) => (i % 2 === 0 ? a1 + (i / 2) * d1 : a2 + ((i - 1) / 2) * d2)),
  fib: (n: number, t0: number, t1: number, k: number, c: number) =>
    build(n, (i, t) => (i === 0 ? t0 : i === 1 ? t1 : prev(t, 1) + k * prev(t, 2) + c)),
  linrec: (n: number, t0: number, a: number, b: number) => build(n, (i, t) => (i === 0 ? t0 : a * prev(t, 1) + b)),
  powers: (n: number, p: number, k: number, c: number) => build(n, (i) => (i + k) ** p + c),
  opcycle: (n: number, t0: number, addFirst: boolean, a: number, b: number) =>
    build(n, (i, t) => {
      if (i === 0) return t0;
      const add = (i - 1) % 2 === 0 ? addFirst : !addFirst;
      return add ? prev(t, 1) + a : prev(t, 1) * b;
    }),
};

const same = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

type Params = Record<string, number>;

/** Generation ranges from the parameter reference (common.md, «Числовые ряды»). */
const GEN_RANGES: Record<FamilyId, Record<string, number[]>> = {
  arith: { a: span(-20, 200), d: nonZero(-30, 30) },
  geom: { a: span(1, 20), r: [2, 3, 4, 5, -2, -3] },
  second: { a: span(0, 50), d0: span(-10, 20), e: nonZero(-6, 6) },
  alt: { a1: span(0, 100), a2: span(0, 100), d1: nonZero(-15, 15), d2: nonZero(-15, 15) },
  fib: { t0: span(1, 10), t1: span(1, 10), k: [1, 2], c: span(-5, 5) },
  linrec: { a: [2, 3, -2], b: nonZero(-10, 10), t0: span(1, 15) },
  powers: { p: [2, 3], k: span(0, 5), c: span(-10, 10) },
  opcycle: { a: span(1, 20), b: [2, 3], first: [0, 1], t0: span(1, 20) },
};

const inRanges = (family: FamilyId, p: Params): boolean =>
  Object.entries(GEN_RANGES[family]).every(([name, values]) => values.includes(p[name] as number));

/** Every parameter set from the generation ranges that reproduces `t` exactly. */
function recover(family: FamilyId, t: readonly number[]): Params[] {
  const n = t.length;
  const t0 = t[0] as number;
  const t1 = t[1] as number;
  const t2 = t[2] as number;
  const t3 = t[3] as number;
  const found: Params[] = [];
  const consider = (p: Params, terms: number[]): void => {
    if (inRanges(family, p) && same(terms, t)) found.push(p);
  };
  switch (family) {
    case 'arith':
      consider({ a: t0, d: t1 - t0 }, ref.arith(n, t0, t1 - t0));
      break;
    case 'geom':
      consider({ a: t0, r: t1 / t0 }, ref.geom(n, t0, t1 / t0));
      break;
    case 'second': {
      const d0 = t1 - t0;
      const e = t2 - t1 - d0;
      consider({ a: t0, d0, e }, ref.second(n, t0, d0, e));
      break;
    }
    case 'alt': {
      const p = { a1: t0, a2: t1, d1: t2 - t0, d2: t3 - t1 };
      if (p.d1 !== p.d2) consider(p, ref.alt(n, p.a1, p.a2, p.d1, p.d2));
      break;
    }
    case 'fib':
      for (const k of [1, 2]) for (const c of span(-5, 5)) consider({ t0, t1, k, c }, ref.fib(n, t0, t1, k, c));
      break;
    case 'linrec':
      for (const a of [2, 3, -2]) for (const b of nonZero(-10, 10)) consider({ a, b, t0 }, ref.linrec(n, t0, a, b));
      break;
    case 'powers':
      for (const p of [2, 3])
        for (const k of span(0, 5)) for (const c of span(-10, 10)) consider({ p, k, c }, ref.powers(n, p, k, c));
      break;
    case 'opcycle':
      for (const first of [0, 1])
        for (const a of span(1, 20))
          for (const b of [2, 3]) consider({ a, b, first, t0 }, ref.opcycle(n, t0, first === 1, a, b));
      break;
  }
  return found;
}

const set = (...xs: number[]): Set<number> => new Set(xs);

// ---------- tests ----------

describe('family table', () => {
  it('lists the families in reference order', () => {
    expect(FAMILIES).toEqual(['arith', 'geom', 'second', 'alt', 'fib', 'linrec', 'powers', 'opcycle']);
  });

  it('pins shown lengths and base difficulties', () => {
    expect(SHOWN_LENGTH).toEqual({ arith: 5, geom: 5, second: 6, alt: 7, fib: 6, linrec: 5, powers: 5, opcycle: 6 });
    expect(BASE_DIFFICULTY).toEqual({
      arith: 800,
      geom: 950,
      second: 1150,
      alt: 1050,
      fib: 1250,
      linrec: 1350,
      powers: 1200,
      opcycle: 1400,
    });
  });
});

describe('fitFamily', () => {
  it('arith: equal differences', () => {
    expect(fitFamily('arith', [2, 4, 6, 8, 10])).toEqual(set(12));
    expect(fitFamily('arith', [7, 7, 7])).toEqual(set(7));
    expect(fitFamily('arith', [500, -500, -1500])).toEqual(set(-2500));
    expect(fitFamily('arith', [1, 2, 4])).toEqual(set());
    expect(fitFamily('arith', [1, 2, 3, 5])).toEqual(set());
    expect(fitFamily('arith', [2, 4])).toEqual(set());
  });

  it('geom: integer ratio from a non-zero first term', () => {
    expect(fitFamily('geom', [3, 6, 12, 24, 48])).toEqual(set(96));
    expect(fitFamily('geom', [-2, 6, -18, 54])).toEqual(set(-162));
    expect(fitFamily('geom', [1, 7, 49])).toEqual(set(343));
    expect(fitFamily('geom', [5, 0, 0, 0])).toEqual(set(0));
    expect(fitFamily('geom', [0, 0, 0, 0])).toEqual(set());
    expect(fitFamily('geom', [4, 6, 9])).toEqual(set());
    expect(fitFamily('geom', [2, 6, 18, 50])).toEqual(set());
    expect(fitFamily('geom', [3, 6])).toEqual(set());
  });

  it('second: equal second differences', () => {
    expect(fitFamily('second', [1, 2, 4, 7, 11, 16])).toEqual(set(22));
    expect(fitFamily('second', [10, 7, 2, -5])).toEqual(set(-14));
    expect(fitFamily('second', [1, 2, 4, 8])).toEqual(set());
    expect(fitFamily('second', [1, 2, 4])).toEqual(set());
  });

  it('alt: both interleaved subsequences arithmetic, at least 6 terms', () => {
    expect(fitFamily('alt', [1, 10, 2, 20, 3, 30])).toEqual(set(4));
    expect(fitFamily('alt', [1, 10, 2, 20, 3, 30, 4])).toEqual(set(40));
    expect(fitFamily('alt', [1, 10, 2, 20, 3, 31])).toEqual(set());
    expect(fitFamily('alt', [1, 10, 2, 20, 4, 30])).toEqual(set());
    expect(fitFamily('alt', [1, 10, 2, 20, 3])).toEqual(set());
  });

  it('fib: k ∈ {1, 2} with the constant computed from the first three terms', () => {
    expect(fitFamily('fib', [1, 1, 2, 3, 5, 8])).toEqual(set(13));
    expect(fitFamily('fib', [1, 2, 4, 7])).toEqual(set(12));
    expect(fitFamily('fib', [1, 2, 4, 8, 16])).toEqual(set(32));
    // Both k fit [2, 2, 5, 8]: k=1, c=1 → 14 and k=2, c=−1 → 17.
    expect(fitFamily('fib', [2, 2, 5, 8])).toEqual(set(14, 17));
    expect(fitFamily('fib', [1, 2, 4, 9])).toEqual(set());
    expect(fitFamily('fib', [1, 2, 4])).toEqual(set());
  });

  it('linrec: t_{n+1} = a·t_n + b with integer a', () => {
    expect(fitFamily('linrec', [2, 5, 11, 23, 47])).toEqual(set(95));
    expect(fitFamily('linrec', [2, -3, 7, -13, 27])).toEqual(set(-53));
    expect(fitFamily('linrec', [3, 3, 3, 3])).toEqual(set());
    expect(fitFamily('linrec', [1, 3, 4, 6])).toEqual(set());
    expect(fitFamily('linrec', [1, 3, 7, 16])).toEqual(set());
    expect(fitFamily('linrec', [1, 3, 7])).toEqual(set());
  });

  it('powers: (n + k)^p + c with p ∈ {2, 3}, k ∈ [0, 10]', () => {
    expect(fitFamily('powers', [1, 4, 9, 16, 25])).toEqual(set(36));
    expect(fitFamily('powers', [0, 7, 26, 63])).toEqual(set(124));
    expect(fitFamily('powers', [100, 121, 144, 169])).toEqual(set(196));
    // k = 11 is outside the fitted range.
    expect(fitFamily('powers', [121, 144, 169, 196])).toEqual(set());
    expect(fitFamily('powers', [1, 4, 9, 16, 26])).toEqual(set());
    expect(fitFamily('powers', [1, 4, 9])).toEqual(set());
  });

  it('opcycle: +a and ×b alternate, starting with either', () => {
    // +3, ×2, +3, ×2 → next +3.
    expect(fitFamily('opcycle', [2, 5, 10, 13, 26])).toEqual(set(29));
    // ×3, +1, ×3, +1 → next ×3.
    expect(fitFamily('opcycle', [2, 6, 7, 21, 22])).toEqual(set(66));
    // t1 = 0 rules out "+a first"; "×b first" fits with b = 0, a = 4.
    expect(fitFamily('opcycle', [3, 0, 4, 0, 4])).toEqual(set(0));
    // t0 = 0 rules out "×b first"; "+a first" fits with a = 5, b = 2.
    expect(fitFamily('opcycle', [0, 5, 10, 15, 30])).toEqual(set(35));
    expect(fitFamily('opcycle', [2, 5, 7, 9, 11])).toEqual(set());
    expect(fitFamily('opcycle', [1, 2, 4, 6, 10])).toEqual(set());
    expect(fitFamily('opcycle', [2, 5, 10, 13])).toEqual(set());
  });
});

describe('fitFamily finds its own rule for arbitrary integer parameters', () => {
  /** Minimum terms per fit from the parameter reference. */
  const MIN_TERMS: Record<FamilyId, number> = {
    arith: 3,
    geom: 3,
    second: 4,
    alt: 6,
    fib: 4,
    linrec: 4,
    powers: 4,
    opcycle: 5,
  };
  const small = fc.integer({ min: -1000, max: 1000 });
  /** Number of shown terms: from the family minimum up to 9. */
  const length = (family: FamilyId) => fc.integer({ min: MIN_TERMS[family], max: 9 });

  /** Asserts that the family fitted to the first n terms predicts t_n. */
  const predictsNext = (family: FamilyId, terms: readonly number[]): void => {
    const shown = terms.slice(0, -1);
    expect(fitFamily(family, shown).has(terms[terms.length - 1] as number)).toBe(true);
  };

  const cases: Record<FamilyId, fc.Arbitrary<number[]>> = {
    arith: fc.tuple(length('arith'), small, small).map(([n, a, d]) => ref.arith(n + 1, a, d)),
    geom: fc
      .tuple(length('geom'), small.filter((a) => a !== 0), fc.integer({ min: -6, max: 6 }))
      .map(([n, a, r]) => ref.geom(n + 1, a, r)),
    second: fc.tuple(length('second'), small, small, small).map(([n, a, d0, e]) => ref.second(n + 1, a, d0, e)),
    alt: fc
      .tuple(length('alt'), small, small, small, small)
      .map(([n, a1, a2, d1, d2]) => ref.alt(n + 1, a1, a2, d1, d2)),
    fib: fc
      .tuple(length('fib'), small, small, fc.constantFrom(1, 2), small)
      .map(([n, t0, t1, k, c]) => ref.fib(n + 1, t0, t1, k, c)),
    linrec: fc
      .tuple(length('linrec'), small, fc.integer({ min: -6, max: 6 }), small)
      .map(([n, t0, a, b]) => ref.linrec(n + 1, t0, a, b))
      .filter((t) => t[1] !== t[0]),
    powers: fc
      .tuple(length('powers'), fc.constantFrom(2, 3), fc.integer({ min: 0, max: 10 }), small)
      .map(([n, p, k, c]) => ref.powers(n + 1, p, k, c)),
    opcycle: fc
      .tuple(length('opcycle'), small, fc.boolean(), small, fc.integer({ min: -6, max: 6 }))
      .map(([n, t0, addFirst, a, b]) => ref.opcycle(n + 1, t0, addFirst, a, b))
      // The quotient b must be recoverable: "+a first" divides by t1, "×b first" by t0.
      .filter((t) => (t[0] as number) !== 0 && (t[1] as number) !== 0),
  };

  it.each(FAMILIES)('%s', (family) => {
    fc.assert(
      fc.property(cases[family], (terms) => {
        predictsNext(family, terms);
      }),
      { numRuns: 1000 },
    );
  });

  it('opcycle needs only the divisor of its own phase to be non-zero', () => {
    // "+a first" with t0 = 0 and "×b first" with t1 = 0 still fit.
    predictsNext('opcycle', ref.opcycle(6, 0, true, 4, 3));
    predictsNext('opcycle', ref.opcycle(6, 5, false, 2, 0));
  });
});

describe('generateTerms', () => {
  it.each(FAMILIES)('%s: shown + 1 integer terms reproducible from the generation ranges', (family) => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const terms = generateTerms(family, createRng(seed));
        expect(terms).toHaveLength(SHOWN_LENGTH[family] + 1);
        expect(terms.every((x) => Number.isSafeInteger(x))).toBe(true);
        expect(recover(family, terms).length).toBeGreaterThan(0);
      }),
      { numRuns: 1000 },
    );
  });

  it.each(FAMILIES)('%s: draws cover every value of every generation parameter', (family) => {
    const seen = new Map<string, Set<number>>();
    for (let seed = 0; seed < 3000; seed++) {
      for (const params of recover(family, generateTerms(family, createRng(seed)))) {
        for (const [name, value] of Object.entries(params)) {
          const values = seen.get(name) ?? new Set<number>();
          values.add(value);
          seen.set(name, values);
        }
      }
    }
    for (const [name, values] of Object.entries(GEN_RANGES[family])) {
      expect([...(seen.get(name) ?? [])].sort((x, y) => x - y), name).toEqual([...values].sort((x, y) => x - y));
    }
  });

  it('is deterministic in the rng', () => {
    for (const family of FAMILIES) {
      expect(generateTerms(family, createRng(42))).toEqual(generateTerms(family, createRng(42)));
    }
  });
});
