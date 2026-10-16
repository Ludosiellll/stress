import type { Rng } from '../../engine/rng';
import type { FamilyId } from '../../engine/types';

export type { FamilyId } from '../../engine/types';

/** The 14 families (Справочник F12): the 8 of 0.1.0 in the order of the parameter reference table, then the new ones. */
export const ALL_FAMILIES: readonly FamilyId[] = [
  'arith',
  'geom',
  'second',
  'alt',
  'fib',
  'linrec',
  'powers',
  'opcycle',
  'letters',
  'addsub',
  'primes',
  'powstep',
  'twostep',
  'digitsum',
];

/** The families training draws from (spec §4.8). */
export const TRAINING_FAMILIES: readonly FamilyId[] = ALL_FAMILIES.slice(0, 11);

/** Held out for the diagnostic: training never generates them, and they have no rating. */
export const HELD_OUT_FAMILIES: readonly FamilyId[] = ['powstep', 'twostep', 'digitsum'];

/** The numeric rules every candidate is checked against; a letter series is checked by its positions. */
export const PREDICTOR_FAMILIES: readonly FamilyId[] = ALL_FAMILIES.filter((f) => f !== 'letters');

/**
 * Terms shown to the user; the answer is the next term. One length per rule: letters 5 (arithmetic), 6 (second order),
 * 7 (two interleaved); addsub 6 (a cycle of 2), 7 (a cycle of 3).
 */
export const SHOWN_LENGTH: Readonly<Record<FamilyId, readonly number[]>> = {
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
};

/** D of the simplest series of the family; the new families add their rule terms (structDifficulty, spec §4.8). */
export const BASE_DIFFICULTY: Readonly<Record<FamilyId, number>> = {
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
};

/** Fewest terms a fit accepts: enough to find the parameters plus at least one check. */
export const MIN_TERMS: Readonly<Record<FamilyId, number>> = {
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

/** A continuation a rule justifies and what the rule adds to the family's base difficulty (spec §4.8). */
interface Fit {
  next: number;
  extra: number;
}

/** Value of t_i computed from the earlier terms t_0..t_{i−1}. */
type Rule = (t: readonly number[], i: number) => number;

const at = (t: readonly number[], i: number): number => t[i] as number;

const arithRule = (d: number): Rule => (t, i) => at(t, i - 1) + d;
const geomRule = (r: number): Rule => (t, i) => r * at(t, i - 1);
/** Difference i − 1 is d0 + (i − 1)·e. */
const secondRule = (d0: number, e: number): Rule => (t, i) => at(t, i - 1) + d0 + (i - 1) * e;
/** Each of the two interleaved subsequences keeps its own step. */
const altRule: Rule = (t, i) => 2 * at(t, i - 2) - at(t, i - 4);
const fibRule = (k: number, c: number): Rule => (t, i) => at(t, i - 1) + k * at(t, i - 2) + c;
const linrecRule = (a: number, b: number): Rule => (t, i) => a * at(t, i - 1) + b;
const powersRule = (p: number, k: number, c: number): Rule => (_t, i) => (i + k) ** p + c;
/** Operation i − 1 produces t_i; the even-numbered operations are the first one. */
const opcycleRule = (addFirst: boolean, a: number, b: number): Rule => (t, i) =>
  ((i - 1) % 2 === 0) === addFirst ? at(t, i - 1) + a : at(t, i - 1) * b;
/** The differences repeat with period k: t_i − t_{i−1} = t_{i−k} − t_{i−k−1}. */
const cycleRule = (k: number): Rule => (t, i) => at(t, i - 1) + at(t, i - k) - at(t, i - k - 1);
const powstepRule = (m: number, s: number, p: number, c: number): Rule => (_t, i) => (m + s * i) ** p + c;
const twostepRule = (k: number, c: number): Rule => (t, i) => at(t, i - 1) * (k + i - 1) + c;
const digitsumRule = (m: number): Rule => (t, i) => at(t, i - 1) + m * digitSum(at(t, i - 1));

/** Sum of the decimal digits of |x|. */
function digitSum(x: number): number {
  let sum = 0;
  for (let v = Math.abs(x); v > 0; v = Math.floor(v / 10)) sum += v % 10;
  return sum;
}

function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
  return true;
}

/** The prime `steps` primes after the prime p. */
function primeAfter(p: number, steps: number): number {
  let q = p;
  for (let k = 0; k < steps; k++) {
    q++;
    while (!isPrime(q)) q++;
  }
  return q;
}

/** P(k), the k-th prime from P(0) = 2. */
const nthPrime = (k: number): number => primeAfter(2, k);

/** Continues `start` with `rule` up to `count` terms. */
function recur(start: readonly number[], count: number, rule: Rule): number[] {
  const t = [...start];
  while (t.length < count) t.push(rule(t, t.length));
  return t;
}

/** If `rule` reproduces every t_i from index `from` on, its next term; otherwise nothing. */
function extend(t: readonly number[], from: number, rule: Rule): number[] {
  for (let i = from; i < t.length; i++) if (rule(t, i) !== at(t, i)) return [];
  return [rule(t, t.length)];
}

/** extend's next term with the rule's difficulty terms. */
const fit = (t: readonly number[], from: number, rule: Rule, extra: number): Fit[] =>
  extend(t, from, rule).map((next) => ({ next, extra }));

/** Next terms of a family whose rules add nothing to its base difficulty. */
const plain =
  (predict: (t: readonly number[]) => number[]) =>
  (t: readonly number[]): Fit[] =>
    predict(t).map((next) => ({ next, extra: 0 }));

const points = (x: boolean, value: number): number => (x ? value : 0);

/** Integer n / d, or null when d is 0 or does not divide n. */
function quotient(n: number, d: number): number | null {
  return d !== 0 && n % d === 0 ? n / d : null;
}

const span = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const nonZero = (min: number, max: number): number[] => span(min, max).filter((v) => v !== 0);

const ARITH_D = nonZero(-30, 30);
const GEOM_R = [2, 3, 4, 5, -2, -3];
const SECOND_E = nonZero(-6, 6);
const ALT_D = nonZero(-15, 15);
const LINREC_A = [2, 3, -2];
const LINREC_B = nonZero(-10, 10);
/** The fit tries k beyond the generation range [0, 5]. */
const POWERS_FIT_K = span(0, 10);
const LETTER_D = nonZero(-4, 4);
const ALPHABET_SIZE = 32;
const PRIMES_C = span(-5, 5);
/** c = 0 first: of two fits that agree, the simpler one names the difficulty. */
const PRIMES_FIT_C = [0, ...nonZero(-10, 10)];
const POWSTEP_FIT_M = span(0, 12);

/**
 * `offsets` placed at a first position drawn so that every term is a letter (1…32); when they span more than the
 * alphabet, at 1 (candidateItem then rejects the series).
 */
function placeLetters(rng: Rng, offsets: readonly number[]): number[] {
  const lo = 1 - Math.min(...offsets);
  const hi = ALPHABET_SIZE - Math.max(...offsets);
  const start = lo <= hi ? rng.int(lo, hi) : lo;
  return offsets.map((x) => start + x);
}

/** Letters by one of three rules (spec §4.8): arithmetic, second order (differences d0, d0 + 1, …), two interleaved. */
function letterTerms(rng: Rng): number[] {
  const rule = rng.int(0, 2);
  if (rule === 0) {
    const d = rng.pick(LETTER_D);
    return placeLetters(rng, recur([0], 6, arithRule(d)));
  }
  if (rule === 1) {
    const d0 = rng.int(1, 3);
    return placeLetters(rng, recur([0], 7, secondRule(d0, 1)));
  }
  const d1 = rng.pick(LETTER_D);
  const d2 = rng.pick(LETTER_D.filter((d) => d !== d1));
  const odd = placeLetters(rng, recur([0], 4, arithRule(d1)));
  const even = placeLetters(rng, recur([0], 4, arithRule(d2)));
  return odd.flatMap((x, j) => [x, even[j] as number]);
}

/** The families with one shown length; letters and addsub draw the rule first, and its length with it. */
type FixedLengthFamily = Exclude<FamilyId, 'letters' | 'addsub'>;

/** `count` terms with parameters drawn from the generation ranges of the parameter reference and spec §4.8. */
const FIXED_GENERATORS: Readonly<Record<FixedLengthFamily, (rng: Rng, count: number) => number[]>> = {
  arith: (rng, count) => {
    const a = rng.int(-20, 200);
    const d = rng.pick(ARITH_D);
    return recur([a], count, arithRule(d));
  },
  geom: (rng, count) => {
    const a = rng.int(1, 20);
    const r = rng.pick(GEOM_R);
    return recur([a], count, geomRule(r));
  },
  second: (rng, count) => {
    const a = rng.int(0, 50);
    const d0 = rng.int(-10, 20);
    const e = rng.pick(SECOND_E);
    return recur([a], count, secondRule(d0, e));
  },
  alt: (rng, count) => {
    const a1 = rng.int(0, 100);
    const a2 = rng.int(0, 100);
    const d1 = rng.pick(ALT_D);
    const d2 = rng.pick(ALT_D.filter((d) => d !== d1));
    return recur([a1, a2, a1 + d1, a2 + d2], count, altRule);
  },
  fib: (rng, count) => {
    const t0 = rng.int(1, 10);
    const t1 = rng.int(1, 10);
    const k = rng.int(1, 2);
    const c = rng.int(-5, 5);
    return recur([t0, t1], count, fibRule(k, c));
  },
  linrec: (rng, count) => {
    const a = rng.pick(LINREC_A);
    const b = rng.pick(LINREC_B);
    const t0 = rng.int(1, 15);
    return recur([t0], count, linrecRule(a, b));
  },
  powers: (rng, count) => {
    const p = rng.int(2, 3);
    const k = rng.int(0, 5);
    const c = rng.int(-10, 10);
    return recur([], count, powersRule(p, k, c));
  },
  opcycle: (rng, count) => {
    const a = rng.int(1, 20);
    const b = rng.int(2, 3);
    const addFirst = rng.int(0, 1) === 1;
    const t0 = rng.int(1, 20);
    return recur([t0], count, opcycleRule(addFirst, a, b));
  },
  primes: (rng, count) => {
    const k = rng.int(0, 12);
    const s = rng.int(1, 2);
    const c = rng.pick(PRIMES_C);
    return Array.from({ length: count }, (_, i) => nthPrime(k + s * i) + c);
  },
  powstep: (rng, count) => {
    const m = rng.int(1, 6);
    const s = rng.int(2, 3);
    const p = rng.int(2, 3);
    const c = rng.int(-10, 10);
    return recur([], count, powstepRule(m, s, p, c));
  },
  twostep: (rng, count) => {
    const k = rng.int(1, 2);
    const c = rng.int(-3, 3);
    const t0 = rng.int(1, 6);
    return recur([t0], count, twostepRule(k, c));
  },
  digitsum: (rng, count) => {
    const m = rng.int(1, 2);
    const t0 = rng.int(10, 200);
    return recur([t0], count, digitsumRule(m));
  },
};

/** A cycle of 2 steps (+a, −b) or 3 (+a, +b, −c), a ≠ b (spec §4.8); 6 or 7 terms shown. */
function addsubTerms(rng: Rng): number[] {
  const cycle = rng.int(2, 3);
  const a = rng.int(2, 20);
  const b = rng.pick(span(2, 20).filter((x) => x !== a));
  const steps = cycle === 2 ? [a, -b] : [a, b, -rng.int(2, 20)];
  const t0 = rng.int(1, 60);
  const count = cycle + 5;
  const t = [t0];
  while (t.length < count) t.push(at(t, t.length - 1) + (steps[(t.length - 1) % cycle] as number));
  return t;
}

const isLetter = (x: number): boolean => x >= 1 && x <= ALPHABET_SIZE;

/** Letters: arithmetic, second order or two interleaved, by positions; every term and the next one a letter. */
function letterFits(t: readonly number[]): Fit[] {
  if (!t.every(isLetter)) return [];
  const d = at(t, 1) - at(t, 0);
  const fits = [...fit(t, 2, arithRule(d), points(Math.abs(d) >= 3, 100) + points(d < 0, 50))];
  if (t.length >= MIN_TERMS.second) fits.push(...fit(t, 3, secondRule(d, at(t, 2) - at(t, 1) - d), 150));
  if (t.length >= MIN_TERMS.alt) {
    const [d1, d2] = [at(t, 2) - at(t, 0), at(t, 3) - at(t, 1)];
    const extra = 200 + points(Math.max(Math.abs(d1), Math.abs(d2)) >= 3, 100) + points(d1 < 0 && d2 < 0, 50);
    fits.push(...fit(t, 4, altRule, extra));
  }
  return fits.filter((f) => isLetter(f.next));
}

/** P(k + s·i) + c: t_0 − c is the prime the series starts from. */
function primesFits(t: readonly number[]): Fit[] {
  const fits: Fit[] = [];
  for (const s of [1, 2]) {
    for (const c of PRIMES_FIT_C) {
      let p = at(t, 0) - c;
      if (!isPrime(p)) continue;
      let ok = true;
      for (let i = 1; i < t.length && ok; i++) {
        p = primeAfter(p, s);
        ok = p + c === at(t, i);
      }
      if (ok) fits.push({ next: primeAfter(p, s) + c, extra: points(s === 2, 100) + points(c !== 0, 100) });
    }
  }
  return fits;
}

/**
 * Next terms each family can justify with arbitrary integer parameters (the new families within the predictor ranges
 * of spec §4.8), with their difficulty terms. Called only with at least MIN_TERMS terms.
 */
const FITS: Readonly<Record<FamilyId, (t: readonly number[]) => Fit[]>> = {
  arith: plain((t) => extend(t, 2, arithRule(at(t, 1) - at(t, 0)))),
  geom: plain((t) => {
    const r = quotient(at(t, 1), at(t, 0));
    return r === null ? [] : extend(t, 2, geomRule(r));
  }),
  second: plain((t) => {
    const d0 = at(t, 1) - at(t, 0);
    return extend(t, 3, secondRule(d0, at(t, 2) - at(t, 1) - d0));
  }),
  alt: plain((t) => extend(t, 4, altRule)),
  fib: plain((t) => [1, 2].flatMap((k) => extend(t, 3, fibRule(k, at(t, 2) - at(t, 1) - k * at(t, 0))))),
  linrec: plain((t) => {
    // t1 = t0 leaves a undefined; such a series is constant, and arith covers it.
    const a = quotient(at(t, 2) - at(t, 1), at(t, 1) - at(t, 0));
    return a === null ? [] : extend(t, 3, linrecRule(a, at(t, 1) - a * at(t, 0)));
  }),
  powers: plain((t) =>
    [2, 3].flatMap((p) => POWERS_FIT_K.flatMap((k) => extend(t, 1, powersRule(p, k, at(t, 0) - k ** p)))),
  ),
  opcycle: plain((t) => {
    const [t0, t1, t2] = [at(t, 0), at(t, 1), at(t, 2)];
    const out: number[] = [];
    const bAfterAdd = quotient(t2, t1);
    if (bAfterAdd !== null) out.push(...extend(t, 3, opcycleRule(true, t1 - t0, bAfterAdd)));
    const bFirst = quotient(t1, t0);
    if (bFirst !== null) out.push(...extend(t, 3, opcycleRule(false, t2 - t1, bFirst)));
    return out;
  }),
  letters: letterFits,
  // A cycle of 2 needs 5 terms, one of 3 needs 7.
  addsub: (t) => [...fit(t, 3, cycleRule(2), 0), ...(t.length >= 7 ? fit(t, 4, cycleRule(3), 200) : [])],
  primes: primesFits,
  powstep: (t) =>
    [2, 3].flatMap((p) =>
      [2, 3].flatMap((s) =>
        POWSTEP_FIT_M.flatMap((m) => {
          const c = at(t, 0) - m ** p;
          return fit(t, 1, powstepRule(m, s, p, c), points(p === 3, 100) + points(c !== 0, 50));
        }),
      ),
    ),
  twostep: (t) =>
    [1, 2, 3, 4].flatMap((k) => {
      const c = at(t, 1) - k * at(t, 0);
      return fit(t, 2, twostepRule(k, c), points(k === 2, 100) + points(c !== 0, 100));
    }),
  digitsum: (t) => [1, 2, 3].flatMap((m) => fit(t, 1, digitsumRule(m), points(m === 2, 100) + points(at(t, 0) > 100, 100))),
};

/** Terms t_0..t_L of a fresh series (L = shown length of the rule drawn); t_L is the answer. */
export function generateTerms(family: FamilyId, rng: Rng): number[] {
  if (family === 'letters') return letterTerms(rng);
  if (family === 'addsub') return addsubTerms(rng);
  return FIXED_GENERATORS[family](rng, (SHOWN_LENGTH[family][0] as number) + 1);
}

function fitsOf(family: FamilyId, terms: readonly number[]): Fit[] {
  return terms.length < MIN_TERMS[family] ? [] : FITS[family](terms);
}

/** Every next term the family justifies for `terms`; empty below its minimum length. */
export function fitFamily(family: FamilyId, terms: readonly number[]): Set<number> {
  return new Set(fitsOf(family, terms).map((f) => f.next));
}

/**
 * D_struct of `terms` (the shown terms, then the answer): the family's base plus the rule terms of the first of its
 * rules that continues the shown terms with the answer (spec §4.8); the base when none does. Without the size terms
 * of difficultyOf.
 */
export function structDifficulty(family: FamilyId, terms: readonly number[]): number {
  const answer = terms[terms.length - 1];
  const rule = fitsOf(family, terms.slice(0, -1)).find((f) => f.next === answer);
  return BASE_DIFFICULTY[family] + (rule?.extra ?? 0);
}
