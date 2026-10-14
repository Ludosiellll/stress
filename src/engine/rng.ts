export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both ends inclusive. */
  int(min: number, max: number): number;
  pick<T>(xs: readonly T[]): T;
  /** Fisher-Yates; returns a new array and leaves the input untouched. */
  shuffle<T>(xs: readonly T[]): T[];
}

/** mulberry32 PRNG. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new RangeError(`int bounds must be integers, got ${String(min)}, ${String(max)}`);
    }
    if (min > max) throw new RangeError(`int: min ${String(min)} > max ${String(max)}`);
    return min + Math.floor(next() * (max - min + 1));
  };

  const pick = <T>(xs: readonly T[]): T => {
    if (xs.length === 0) throw new RangeError('pick from empty array');
    return xs[int(0, xs.length - 1)] as T;
  };

  const shuffle = <T>(xs: readonly T[]): T[] => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };

  return { next, int, pick, shuffle };
}

/** FNV-1a 32-bit over UTF-16 code units, unsigned. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function deriveSeed(seed: number, salt: string): number {
  return hashString(String(seed >>> 0) + ':' + salt);
}
