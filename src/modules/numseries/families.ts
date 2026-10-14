import type { Rng } from '../../engine/rng';
import type { FamilyId } from '../../engine/types';

export type { FamilyId } from '../../engine/types';

/** In the order of the parameter reference table. */
export const FAMILIES: readonly FamilyId[] = ['arith', 'geom', 'second', 'alt', 'fib', 'linrec', 'powers', 'opcycle'];

/** Terms shown to the user; the answer is the next term. */
export const SHOWN_LENGTH: Readonly<Record<FamilyId, number>> = {
  arith: 5,
  geom: 5,
  second: 6,
  alt: 7,
  fib: 6,
  linrec: 5,
  powers: 5,
  opcycle: 6,
};

export const BASE_DIFFICULTY: Readonly<Record<FamilyId, number>> = {
  arith: 800,
  geom: 950,
  second: 1150,
  alt: 1050,
  fib: 1250,
  linrec: 1350,
  powers: 1200,
  opcycle: 1400,
};

/** Fewest terms a fit accepts: enough to find the parameters plus at least one check. */
const MIN_TERMS: Readonly<Record<FamilyId, number>> = {
  arith: 3,
  geom: 3,
  second: 4,
  alt: 6,
  fib: 4,
  linrec: 4,
  powers: 4,
  opcycle: 5,
};

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

/** `count` terms with parameters drawn from the generation ranges of the parameter reference. */
const GENERATORS: Readonly<Record<FamilyId, (rng: Rng, count: number) => number[]>> = {
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
};

/**
 * Next terms each family can justify with arbitrary integer parameters.
 * Called only with at least MIN_TERMS terms.
 */
const PREDICTORS: Readonly<Record<FamilyId, (t: readonly number[]) => number[]>> = {
  arith: (t) => extend(t, 2, arithRule(at(t, 1) - at(t, 0))),
  geom: (t) => {
    const r = quotient(at(t, 1), at(t, 0));
    return r === null ? [] : extend(t, 2, geomRule(r));
  },
  second: (t) => {
    const d0 = at(t, 1) - at(t, 0);
    return extend(t, 3, secondRule(d0, at(t, 2) - at(t, 1) - d0));
  },
  alt: (t) => extend(t, 4, altRule),
  fib: (t) => [1, 2].flatMap((k) => extend(t, 3, fibRule(k, at(t, 2) - at(t, 1) - k * at(t, 0)))),
  linrec: (t) => {
    // t1 = t0 leaves a undefined; such a series is constant, and arith covers it.
    const a = quotient(at(t, 2) - at(t, 1), at(t, 1) - at(t, 0));
    return a === null ? [] : extend(t, 3, linrecRule(a, at(t, 1) - a * at(t, 0)));
  },
  powers: (t) =>
    [2, 3].flatMap((p) => POWERS_FIT_K.flatMap((k) => extend(t, 1, powersRule(p, k, at(t, 0) - k ** p)))),
  opcycle: (t) => {
    const [t0, t1, t2] = [at(t, 0), at(t, 1), at(t, 2)];
    const out: number[] = [];
    const bAfterAdd = quotient(t2, t1);
    if (bAfterAdd !== null) out.push(...extend(t, 3, opcycleRule(true, t1 - t0, bAfterAdd)));
    const bFirst = quotient(t1, t0);
    if (bFirst !== null) out.push(...extend(t, 3, opcycleRule(false, t2 - t1, bFirst)));
    return out;
  },
};

/** Terms t_0..t_L of a fresh series (L = shown length); t_L is the answer. */
export function generateTerms(family: FamilyId, rng: Rng): number[] {
  return GENERATORS[family](rng, SHOWN_LENGTH[family] + 1);
}

/** Every next term the family justifies for `terms`; empty below its minimum length. */
export function fitFamily(family: FamilyId, terms: readonly number[]): Set<number> {
  return new Set(terms.length < MIN_TERMS[family] ? [] : PREDICTORS[family](terms));
}
