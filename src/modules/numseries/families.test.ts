import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../engine/rng';
import {
  ALL_FAMILIES,
  BASE_DIFFICULTY,
  HELD_OUT_FAMILIES,
  PREDICTOR_FAMILIES,
  SHOWN_LENGTH,
  TRAINING_FAMILIES,
  fitFamily,
  generateTerms,
  structDifficulty,
  type FamilyId,
} from './families';

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

/** The first 40 primes: P(0) = 2. */
const PRIMES = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113,
  127, 131, 137, 139, 149, 151, 157, 163, 167, 173,
];
const prime = (i: number): number => PRIMES[i] as number;
/** Sum of the decimal digits of |x|. */
const digitSum = (x: number): number =>
  String(Math.abs(x))
    .split('')
    .reduce((sum, d) => sum + Number(d), 0);

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
  /** Differences d0, d0 + 1, d0 + 2, … */
  letterSecond: (n: number, a: number, d0: number) => build(n, (i, t) => (i === 0 ? a : prev(t, 1) + d0 + i - 1)),
  /** The steps repeat: t_i = t_{i−1} + steps[(i − 1) mod k]. */
  addsub: (n: number, t0: number, steps: readonly number[]) =>
    build(n, (i, t) => (i === 0 ? t0 : prev(t, 1) + (steps[(i - 1) % steps.length] as number))),
  primes: (n: number, k: number, s: number, c: number) => build(n, (i) => prime(k + s * i) + c),
  powstep: (n: number, m: number, s: number, p: number, c: number) => build(n, (i) => (m + s * i) ** p + c),
  twostep: (n: number, t0: number, k: number, c: number) => build(n, (i, t) => (i === 0 ? t0 : prev(t, 1) * (k + i - 1) + c)),
  digitsum: (n: number, t0: number, m: number) => build(n, (i, t) => (i === 0 ? t0 : prev(t, 1) + m * digitSum(prev(t, 1)))),
};

const same = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

type Params = Record<string, number>;

const LETTER_D = [...nonZero(-4, 4)];

/**
 * Generation ranges from the parameter reference (common.md, «Числовые ряды») and the table of spec §4.8. Letters:
 * `rule` 0 arithmetic (d), 1 second order (d0), 2 two interleaved (d1, d2); a, a1, a2 are the first positions.
 * addsub: `cycle` 2 (+a, −b) or 3 (+a, +b, −c). opcycle `first` 1: +a first.
 */
const GEN_RANGES: Record<FamilyId, Record<string, number[]>> = {
  arith: { a: span(-20, 200), d: nonZero(-30, 30) },
  geom: { a: span(1, 20), r: [2, 3, 4, 5, -2, -3] },
  second: { a: span(0, 50), d0: span(-10, 20), e: nonZero(-6, 6) },
  alt: { a1: span(0, 100), a2: span(0, 100), d1: nonZero(-15, 15), d2: nonZero(-15, 15) },
  fib: { t0: span(1, 10), t1: span(1, 10), k: [1, 2], c: span(-5, 5) },
  linrec: { a: [2, 3, -2], b: nonZero(-10, 10), t0: span(1, 15) },
  powers: { p: [2, 3], k: span(0, 5), c: span(-10, 10) },
  opcycle: { a: span(1, 20), b: [2, 3], first: [0, 1], t0: span(1, 20) },
  letters: { rule: [0, 1, 2], d: LETTER_D, d0: span(1, 3), d1: LETTER_D, d2: LETTER_D, a: span(1, 32), a1: span(1, 32), a2: span(1, 32) },
  addsub: { cycle: [2, 3], a: span(2, 20), b: span(2, 20), c: span(2, 20), t0: span(1, 60) },
  primes: { k: span(0, 12), s: [1, 2], c: span(-5, 5) },
  powstep: { m: span(1, 6), s: [2, 3], p: [2, 3], c: span(-10, 10) },
  twostep: { k: [1, 2], c: span(-3, 3), t0: span(1, 6) },
  digitsum: { m: [1, 2], t0: span(10, 200) },
};

/** 100·[max|t| > 100] + 200·[max|t| > 1000] + 50·[any t < 0] (spec §4.8 «величина»). */
const magnitude = (t: readonly number[]): number => {
  const maxAbs = Math.max(...t.map((x) => Math.abs(x)));
  return (maxAbs > 100 ? 100 : 0) + (maxAbs > 1000 ? 200 : 0) + (t.some((x) => x < 0) ? 50 : 0);
};
const flag = (x: boolean, points: number): number => (x ? points : 0);

/** D_struct of the table of spec §4.8 for the parameters a new family's terms were generated with. */
function tableDifficulty(family: FamilyId, p: Params, t: readonly number[]): number {
  const v = (name: string): number => p[name] as number;
  switch (family) {
    case 'letters':
      if (v('rule') === 0) return 1000 + flag(Math.abs(v('d')) >= 3, 100) + flag(v('d') < 0, 50);
      if (v('rule') === 1) return 1000 + 150;
      return (
        1000 + 200 + flag(Math.max(Math.abs(v('d1')), Math.abs(v('d2'))) >= 3, 100) + flag(v('d1') < 0 && v('d2') < 0, 50)
      );
    case 'addsub':
      return 1050 + flag(v('cycle') === 3, 200) + magnitude(t);
    case 'primes':
      return 1150 + flag(v('s') === 2, 100) + flag(v('c') !== 0, 100) + magnitude(t);
    case 'powstep':
      return 1300 + flag(v('p') === 3, 100) + flag(v('c') !== 0, 50) + magnitude(t);
    case 'twostep':
      return 1400 + flag(v('k') === 2, 100) + flag(v('c') !== 0, 100) + magnitude(t);
    case 'digitsum':
      return 1350 + flag(v('m') === 2, 100) + flag(v('t0') > 100, 100) + magnitude(t);
    default:
      throw new Error(`not a new family: ${family}`);
  }
}

/** Every parameter of `p` within its generation range (letters and addsub name only those of their rule). */
const inRanges = (family: FamilyId, p: Params): boolean =>
  Object.entries(p).every(([name, value]) => GEN_RANGES[family][name]?.includes(value) === true);

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
    // Spec §4.8, shown terms by rule: letters 5, 6, 7; addsub 6 (a cycle of 2), 7 (a cycle of 3). n counts the answer.
    case 'letters':
      if (n === 6) consider({ rule: 0, a: t0, d: t1 - t0 }, ref.arith(n, t0, t1 - t0));
      if (n === 7) consider({ rule: 1, a: t0, d0: t1 - t0 }, ref.letterSecond(n, t0, t1 - t0));
      if (n === 8) {
        const p = { rule: 2, a1: t0, a2: t1, d1: t2 - t0, d2: t3 - t1 };
        if (p.d1 !== p.d2) consider(p, ref.alt(n, p.a1, p.a2, p.d1, p.d2));
      }
      break;
    case 'addsub': {
      const d = t.slice(1).map((x, i) => x - (t[i] as number));
      if (n === 7) {
        const p = { cycle: 2, t0, a: d[0] as number, b: -(d[1] as number) };
        if (p.a !== p.b) consider(p, ref.addsub(n, t0, [p.a, -p.b]));
      }
      if (n === 8) {
        const p = { cycle: 3, t0, a: d[0] as number, b: d[1] as number, c: -(d[2] as number) };
        if (p.a !== p.b) consider(p, ref.addsub(n, t0, [p.a, p.b, -p.c]));
      }
      break;
    }
    case 'primes':
      for (const k of span(0, 12))
        for (const s of [1, 2]) for (const c of span(-5, 5)) consider({ k, s, c }, ref.primes(n, k, s, c));
      break;
    case 'powstep':
      for (const m of span(1, 6))
        for (const s of [2, 3])
          for (const p of [2, 3]) for (const c of span(-10, 10)) consider({ m, s, p, c }, ref.powstep(n, m, s, p, c));
      break;
    case 'twostep':
      for (const k of [1, 2]) for (const c of span(-3, 3)) consider({ k, c, t0 }, ref.twostep(n, t0, k, c));
      break;
    case 'digitsum':
      for (const m of [1, 2]) consider({ m, t0 }, ref.digitsum(n, t0, m));
      break;
  }
  return found;
}

const set = (...xs: number[]): Set<number> => new Set(xs);

// ---------- tests ----------

const OLD_FAMILIES: readonly FamilyId[] = ['arith', 'geom', 'second', 'alt', 'fib', 'linrec', 'powers', 'opcycle'];
const NEW_FAMILIES: readonly FamilyId[] = ['letters', 'addsub', 'primes', 'powstep', 'twostep', 'digitsum'];

describe('family table', () => {
  it('lists the 14 families: the 8 old ones in reference order, then the new ones (Справочник F12)', () => {
    expect(ALL_FAMILIES).toEqual([...OLD_FAMILIES, ...NEW_FAMILIES]);
    expect(TRAINING_FAMILIES).toEqual([...OLD_FAMILIES, 'letters', 'addsub', 'primes']);
    expect(HELD_OUT_FAMILIES).toEqual(['powstep', 'twostep', 'digitsum']);
    expect(PREDICTOR_FAMILIES).toEqual(ALL_FAMILIES.filter((f) => f !== 'letters'));
    expect(PREDICTOR_FAMILIES).toHaveLength(13);
  });

  it('pins shown lengths and base difficulties', () => {
    expect(SHOWN_LENGTH).toEqual({
      arith: [5],
      geom: [5],
      second: [6],
      alt: [7],
      fib: [6],
      linrec: [5],
      powers: [5],
      opcycle: [6],
      letters: [5, 6, 7],
      addsub: [6, 7],
      primes: [5],
      powstep: [5],
      twostep: [5],
      digitsum: [5],
    });
    expect(BASE_DIFFICULTY).toEqual({
      arith: 800,
      geom: 950,
      second: 1150,
      alt: 1050,
      fib: 1250,
      linrec: 1350,
      powers: 1200,
      opcycle: 1400,
      letters: 1000,
      addsub: 1050,
      primes: 1150,
      powstep: 1300,
      twostep: 1400,
      digitsum: 1350,
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

  it('letters: arithmetic, second order or two interleaved, by positions 1…32 only', () => {
    expect(fitFamily('letters', [1, 3, 5, 7, 9])).toEqual(set(11));
    expect(fitFamily('letters', [1, 2, 4, 7, 11, 16])).toEqual(set(22));
    expect(fitFamily('letters', [1, 20, 3, 18, 5, 16, 7])).toEqual(set(14));
    // The next position would be 33, or a shown one is outside 1…32.
    expect(fitFamily('letters', [24, 26, 28, 30, 32])).toEqual(set());
    expect(fitFamily('letters', [0, 2, 4, 6, 8])).toEqual(set());
    expect(fitFamily('letters', [1, 2, 4, 8])).toEqual(set());
    expect(fitFamily('letters', [1, 3])).toEqual(set());
  });

  it('addsub: a cycle of 2 steps from 5 terms, of 3 steps from 7', () => {
    expect(fitFamily('addsub', [10, 15, 12, 17, 14])).toEqual(set(19));
    expect(fitFamily('addsub', [1, 6, 10, 3, 8, 12, 5])).toEqual(set(10));
    expect(fitFamily('addsub', [1, 6, 10, 3, 8, 12])).toEqual(set());
    expect(fitFamily('addsub', [10, 15, 12, 17, 15])).toEqual(set());
    expect(fitFamily('addsub', [10, 15, 12, 17])).toEqual(set());
  });

  it('primes: P(k + s·i) + c with s ∈ {1, 2}, c ∈ −10…10', () => {
    expect(fitFamily('primes', [2, 3, 5, 7, 11])).toEqual(set(13));
    expect(fitFamily('primes', [3, 7, 13, 19])).toEqual(set(29));
    expect(fitFamily('primes', [0, 2, 6, 8])).toEqual(set(12));
    expect(fitFamily('primes', [-8, -7, -5, -3])).toEqual(set(1));
    expect(fitFamily('primes', [2, 3, 5, 8])).toEqual(set());
    expect(fitFamily('primes', [-20, -19, -17, -13])).toEqual(set());
    expect(fitFamily('primes', [2, 3, 5])).toEqual(set());
  });

  it('powstep: (m + s·i)^p + c with s, p ∈ {2, 3}, m ∈ 0…12', () => {
    expect(fitFamily('powstep', [1, 9, 25, 49])).toEqual(set(81));
    expect(fitFamily('powstep', [8, 125, 512, 1331])).toEqual(set(2744));
    expect(fitFamily('powstep', [149, 201, 261, 329])).toEqual(set(405));
    expect(fitFamily('powstep', [1, 9, 25, 50])).toEqual(set());
    expect(fitFamily('powstep', [1, 9, 25])).toEqual(set());
  });

  it('twostep: t_i = t_{i−1}·(k + i − 1) + c with k ∈ 1…4', () => {
    expect(fitFamily('twostep', [1, 1, 2, 6, 24])).toEqual(set(120));
    expect(fitFamily('twostep', [2, 5, 16, 65])).toEqual(set(326));
    expect(fitFamily('twostep', [1, 4, 20, 120])).toEqual(set(840));
    expect(fitFamily('twostep', [2, 5, 16, 66])).toEqual(set());
    expect(fitFamily('twostep', [2, 5, 16])).toEqual(set());
  });

  it('digitsum: t_i = t_{i−1} + m·S(t_{i−1}) with m ∈ 1…3', () => {
    expect(fitFamily('digitsum', [10, 11, 13, 17, 25])).toEqual(set(32));
    expect(fitFamily('digitsum', [12, 18, 36, 54])).toEqual(set(72));
    expect(fitFamily('digitsum', [19, 49, 88])).toEqual(set(136));
    expect(fitFamily('digitsum', [-12, -9, 0])).toEqual(set(0));
    expect(fitFamily('digitsum', [10, 11, 14])).toEqual(set());
    expect(fitFamily('digitsum', [10, 11])).toEqual(set());
  });
});

describe('structDifficulty', () => {
  it('is the base of an old family', () => {
    for (const f of OLD_FAMILIES) expect(structDifficulty(f, [1, 2, 3, 4, 5, 6]), f).toBe(BASE_DIFFICULTY[f]);
  });

  it('adds the rule terms of the table of spec §4.8', () => {
    expect(structDifficulty('letters', [1, 3, 5, 7, 9, 11])).toBe(1000);
    expect(structDifficulty('letters', [20, 17, 14, 11, 8, 5])).toBe(1150);
    expect(structDifficulty('letters', [1, 2, 4, 7, 11, 16, 22])).toBe(1150);
    expect(structDifficulty('letters', [1, 20, 3, 18, 5, 16, 7, 14])).toBe(1200);
    expect(structDifficulty('letters', [9, 30, 8, 26, 7, 22, 6, 18])).toBe(1350);
    expect(structDifficulty('addsub', [10, 15, 12, 17, 14, 19, 16])).toBe(1050);
    expect(structDifficulty('addsub', [1, 6, 10, 3, 8, 12, 5, 10])).toBe(1250);
    expect(structDifficulty('primes', [2, 3, 5, 7, 11, 13])).toBe(1150);
    expect(structDifficulty('primes', [0, 2, 6, 8, 12])).toBe(1250);
    expect(structDifficulty('powstep', [1, 9, 25, 49, 81])).toBe(1300);
    expect(structDifficulty('powstep', [10, 127, 514, 1333, 2746])).toBe(1450);
    expect(structDifficulty('twostep', [1, 1, 2, 6, 24])).toBe(1400);
    expect(structDifficulty('twostep', [2, 5, 16, 65, 326])).toBe(1600);
    expect(structDifficulty('digitsum', [10, 11, 13, 17, 25])).toBe(1350);
    expect(structDifficulty('digitsum', [102, 108, 126, 144, 162])).toBe(1550);
  });

  it('is the base when the rule does not continue the terms', () => {
    expect(structDifficulty('primes', [2, 3, 5, 7, 12])).toBe(1150);
    expect(structDifficulty('letters', [1, 3, 5, 7, 9, 12])).toBe(1000);
  });
});

describe('fitFamily finds its own rule for arbitrary integer parameters', () => {
  /** Minimum terms per fit from the parameter reference and the table of spec §4.8 (addsub: 5 for a cycle of 2). */
  const MIN_TERMS: Record<FamilyId, number> = {
    arith: 3,
    geom: 3,
    second: 4,
    alt: 6,
    fib: 4,
    linrec: 4,
    powers: 4,
    opcycle: 5,
    letters: 3,
    addsub: 5,
    primes: 4,
    powstep: 4,
    twostep: 4,
    digitsum: 3,
  };
  const small = fc.integer({ min: -1000, max: 1000 });
  /** Number of shown terms: from `min` (the family minimum) up to `max`. */
  const length = (family: FamilyId, max = 9) => fc.integer({ min: MIN_TERMS[family], max });

  /** Asserts that the family fitted to the first n terms predicts t_n. */
  const predictsNext = (family: FamilyId, terms: readonly number[]): void => {
    const shown = terms.slice(0, -1);
    expect(fitFamily(family, shown).has(terms[terms.length - 1] as number)).toBe(true);
  };

  /** Letters: positions, whichever rule, as long as every term is in 1…32. */
  const inAlphabet = (t: readonly number[]): boolean => t.every((x) => x >= 1 && x <= 32);
  const position = fc.integer({ min: 1, max: 32 });
  const step = fc.integer({ min: -8, max: 8 });

  /**
   * The predictors of the new families fit wider ranges than generation (spec §4.8 «Правило: проверка единственности»):
   * addsub any steps, primes c ∈ −10…10 and any k, powstep m ∈ 0…12 and any c, twostep k ∈ 1…4, digitsum m ∈ 1…3.
   */
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
    letters: fc
      .oneof(
        fc.tuple(length('letters', 7), position, step).map(([n, a, d]) => ref.arith(n + 1, a, d)),
        fc.tuple(fc.integer({ min: 4, max: 7 }), position, step).map(([n, a, d0]) => ref.letterSecond(n + 1, a, d0)),
        fc
          .tuple(fc.integer({ min: 6, max: 9 }), position, position, step, step)
          .map(([n, a1, a2, d1, d2]) => ref.alt(n + 1, a1, a2, d1, d2)),
      )
      .filter(inAlphabet),
    addsub: fc
      .tuple(fc.constantFrom(2, 3), fc.integer({ min: 0, max: 2 }), small, fc.array(small, { minLength: 3, maxLength: 3 }))
      .map(([k, extra, t0, steps]) => ref.addsub((k === 2 ? 5 : 7) + extra + 1, t0, steps.slice(0, k))),
    primes: fc
      .tuple(length('primes', 7), fc.integer({ min: 0, max: 20 }), fc.constantFrom(1, 2), fc.integer({ min: -10, max: 10 }))
      .map(([n, k, s, c]) => ref.primes(n + 1, k, s, c)),
    powstep: fc
      .tuple(length('powstep', 6), fc.integer({ min: 0, max: 12 }), fc.constantFrom(2, 3), fc.constantFrom(2, 3), small)
      .map(([n, m, s, p, c]) => ref.powstep(n + 1, m, s, p, c)),
    twostep: fc
      .tuple(length('twostep', 7), fc.integer({ min: -50, max: 50 }), fc.integer({ min: 1, max: 4 }), small)
      .map(([n, t0, k, c]) => ref.twostep(n + 1, t0, k, c)),
    digitsum: fc
      .tuple(length('digitsum', 8), fc.integer({ min: -100_000, max: 100_000 }), fc.integer({ min: 1, max: 3 }))
      .map(([n, t0, m]) => ref.digitsum(n + 1, t0, m)),
  };

  it.each(ALL_FAMILIES)('%s', (family) => {
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

  it('predictors fit wider ranges than generation', () => {
    // Beyond the generation ranges of spec §4.8, inside those of the predictors.
    predictsNext('addsub', ref.addsub(6, 70, [-25, 30]));
    predictsNext('addsub', ref.addsub(8, -5, [1, -1, 40]));
    predictsNext('primes', ref.primes(5, 20, 2, -10));
    predictsNext('primes', ref.primes(5, 3, 1, 10));
    predictsNext('powstep', ref.powstep(5, 0, 3, 3, -500));
    predictsNext('powstep', ref.powstep(5, 12, 2, 2, 40));
    predictsNext('twostep', ref.twostep(5, 7, 4, -20));
    predictsNext('twostep', ref.twostep(5, -3, 3, 9));
    predictsNext('digitsum', ref.digitsum(4, 950, 3));
    // The edges of the predictors stay the edges: m = 13 for powstep, k = 5 for twostep, m = 4 for digitsum.
    expect(fitFamily('powstep', ref.powstep(5, 13, 2, 2, 0).slice(0, 4))).toEqual(set());
    expect(fitFamily('twostep', ref.twostep(5, 2, 5, 0).slice(0, 4))).toEqual(set());
    expect(fitFamily('digitsum', ref.digitsum(4, 10, 4).slice(0, 3))).toEqual(set());
  });
});

describe('generateTerms', () => {
  it.each(ALL_FAMILIES)('%s: shown + 1 integer terms reproducible from the generation ranges', (family) => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const terms = generateTerms(family, createRng(seed));
        expect(SHOWN_LENGTH[family]).toContain(terms.length - 1);
        expect(terms.every((x) => Number.isSafeInteger(x))).toBe(true);
        expect(recover(family, terms).length).toBeGreaterThan(0);
      }),
      { numRuns: 1000 },
    );
  });

  it.each(ALL_FAMILIES)('%s: draws cover every value of every generation parameter', (family) => {
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

  it.each(NEW_FAMILIES)('%s: D_struct is the table of spec §4.8 for the parameters drawn', (family) => {
    for (let seed = 0; seed < 1000; seed++) {
      const terms = generateTerms(family, createRng(seed));
      // Letters: a second-order series with first difference 3 does not fit in 32 letters; candidateItem rejects it.
      if (family === 'letters' && !terms.every((x) => x >= 1 && x <= 32)) continue;
      const expected = recover(family, terms).map((p) => tableDifficulty(family, p, terms));
      const magnitudeOf = family === 'letters' ? 0 : magnitude(terms);
      expect(expected, terms.join(',')).toContain(structDifficulty(family, terms) + magnitudeOf);
    }
  });

  it('is deterministic in the rng', () => {
    for (const family of ALL_FAMILIES) {
      expect(generateTerms(family, createRng(42))).toEqual(generateTerms(family, createRng(42)));
    }
  });
});
