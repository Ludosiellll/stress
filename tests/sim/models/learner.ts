/**
 * Learner models of the simulations, ported from the fixes simulation scripts (spec §8): a seeded generator, the
 * practice curve and the two-boundary diffusion table. Parameters are expert judgement, labelled where they are used.
 * RTs are "measured" RTs on a laptop keyboard and display (≈ 25–40 ms device latency included).
 */

/** Seeded generator (mulberry32) with the normal and exponential draws the models need. */
export class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Standard normal (Box–Muller). */
  normal(): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  exp(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }
  /** An integer in [a, b]. */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
}

/** Exponential approach from v0 to vInf over `n` practice units with scale tau. */
export const learn = (v0: number, vInf: number, n: number, tau: number): number => vInf + (v0 - vInf) * Math.exp(-n / tau);

/** Decision times of one (drift, boundary) cell of the diffusion table. */
export interface DdmCell {
  /** Sorted decision times (s) of the upper-boundary (right) answers. */
  up: Float64Array;
  /** Sorted decision times (s) of the lower-boundary (wrong) answers; trajectories still running at 3 s count here. */
  lo: Float64Array;
  /** Trajectories in the cell (up + lo). */
  n: number;
}

/**
 * Two-boundary drift diffusion, noise s = 0.1, step 1 ms, start z = zFrac·a: `samples` trajectories per drift rate in
 * `vs` and boundary separation in `as`, from one seeded generator. table[i][j] is the cell of vs[i] and as[j].
 */
export function buildDdm(vs: number[], as: number[], zFrac: number, samples: number, seed: number): DdmCell[][] {
  const r = new Rand(seed);
  const s = 0.1;
  const dt = 0.001;
  const sq = s * Math.sqrt(dt);
  const out: DdmCell[][] = [];
  for (const v of vs) {
    const row: DdmCell[] = [];
    for (const a of as) {
      const up: number[] = [];
      const lo: number[] = [];
      for (let k = 0; k < samples; k++) {
        let x = zFrac * a;
        let t = 0;
        while (x > 0 && x < a && t < 3) {
          x += v * dt + sq * r.normal();
          t += dt;
        }
        if (x >= a) up.push(t);
        else lo.push(t);
      }
      row.push({ up: Float64Array.from(up.sort((p, q) => p - q)), lo: Float64Array.from(lo.sort((p, q) => p - q)), n: samples });
    }
    out.push(row);
  }
  return out;
}

/** Count of values ≤ x in a sorted array. */
export function countLe(arr: Float64Array, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] as number) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the grid value nearest to x (the first one on a tie). */
export function nearestIdx(grid: readonly number[], x: number): number {
  let best = 0;
  for (let i = 1; i < grid.length; i++) if (Math.abs((grid[i] as number) - x) < Math.abs((grid[best] as number) - x)) best = i;
  return best;
}
