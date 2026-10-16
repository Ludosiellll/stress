import { nextLevel, savedLevel, startLevel } from '../../../src/engine/adaptive';
import { CALIBRATION_BLOCKS } from '../../../src/engine/phases';
import { penalizedScore } from '../../../src/engine/reaction/summary';
import type { Outcome } from '../../../src/engine/reaction/types';
import { FLOOR_HITS, bandFloors } from '../../../src/engine/windowFloor';
import { withFloor } from '../../../src/modules/reaction/common';
import { szmr } from '../../../src/modules/reaction/szmr';
import { Rand, buildDdm, countLe, learn, nearestIdx, type DdmCell } from './learner';

/**
 * СЗМР over a 90-day course, played by a two-boundary diffusion learner (spec §8.2; ported from the fixes simulation
 * bands.ts). The rules are the app's: the window and the load from szmr.params(L), with `floors` the personal window
 * floor of the band (bandFloors over the clean hits of each band, F3), the block score from penalizedScore, the level
 * from nextLevel (levelDelta; a session is one segment, so its first block may take g = 2), startLevel and savedLevel.
 * The stability rule is off here (cvMax null).
 */

/** Drift rates and boundary separations of the diffusion table: start z = a/2, 2500 trajectories a cell, seed 31. */
const VS = Array.from({ length: 17 }, (_, i) => 0.08 + 0.025 * i);
const AS = [0.06, 0.08, 0.1, 0.12, 0.14];
const Z_FRAC = 0.5;
const DDM_SAMPLES = 2500;
const DDM_SEED = 31;
/** Practice: drift 0.30 → 0.42 and non-decision time 0.31 → 0.28 s, exponential in trials played with this scale. */
const PRACTICE_SCALE = 3000;
/** A lapse adds 300…700 ms to this share of answers. */
const LAPSE = 0.01;
/** The course: the module every 3 days from day 0 to day 90, 7 blocks a session. */
const DAY_STEP = 3;
const LAST_DAY = 90;
const BLOCKS_PER_SESSION = 7;

/** How the learner picks its boundary: the one with the best expected penalised score, or a fixed one from AS. */
export type BoundaryPolicy = 'opt' | { a: number };

export interface SzmrCourseBlock {
  day: number;
  /** The penalised block score the level moved by. */
  s: number;
  /** Wrong keys inside the window, per trial. */
  errorRate: number;
  /** The level the block was played at. */
  L: number;
  /** L_saved at the start of the session. */
  lSaved: number;
}

export interface SzmrCourse {
  blocks: SzmrCourseBlock[];
  /** L_saved after the session of each course day. */
  savedByDay: Map<number, number>;
}

let table: DdmCell[][] | null = null;
/** Built once (about 0.2 M trajectories) on first use. */
const ddm = (): DdmCell[][] => (table ??= buildDdm(VS, AS, Z_FRAC, DDM_SAMPLES, DDM_SEED));

interface Load {
  /** The load band and the nominal window of the level. */
  band: number;
  windowMs: number;
  /** Drift multiplier of the load. */
  drift: number;
  /** Seconds added to the non-decision time. */
  ter: number;
}

/**
 * szmr.params(L) as the learner feels it: Hick's slowing for the alternatives (3 colours on 2 keys count as 2.6),
 * × 0.93 for the distracting shape, × 0.8 for the inversion, × 0.96 for sound and × 0.95 for visual noise (when the
 * parameters have those fields), and 10 ms more non-decision time for the shape, 10 ms for sound, 15 ms for noise.
 */
function loadOf(L: number): Load {
  const p = szmr.params(L);
  const nAlt = p.nColors === 3 && p.nKeys === 2 ? 2.6 : p.nColors;
  const audio = p.audio !== null;
  const noise = p.noise !== null;
  return {
    band: p.band,
    windowMs: p.windowMs,
    drift:
      (1 - 0.17 * Math.log2(nAlt / 2)) *
      (p.shapeDistractor ? 0.93 : 1) *
      (p.inversion ? 0.8 : 1) *
      (audio ? 0.96 : 1) *
      (noise ? 0.95 : 1),
    ter: (p.shapeDistractor ? 0.01 : 0) + (audio ? 0.01 : 0) + (noise ? 0.015 : 0),
  };
}

const ZERO_COUNTS: Readonly<Record<Outcome, number>> = {
  hit: 0,
  wrong: 0,
  miss: 0,
  late: 0,
  false_start: 0,
  commission: 0,
  correct_reject: 0,
  early: 0,
  timing_late: 0,
};

/**
 * The boundary of the cell row of the learner's drift. 'opt': the highest expected penalizedScore of the cell's answers
 * (right inside the window a hit, wrong inside it a wrong key, any answer after it late), the first one on a tie; lapses
 * and the ±25 ms spread are not foreseen.
 */
function pickCell(row: readonly DdmCell[], policy: BoundaryPolicy, terS: number, windowS: number): DdmCell {
  if (policy !== 'opt') {
    const fixed = row[AS.indexOf(policy.a)];
    if (fixed === undefined) throw new RangeError(`runSzmrCourse: boundary ${String(policy.a)} is not one of ${AS.join(', ')}`);
    return fixed;
  }
  let best = row[0] as DdmCell;
  let bestValue = -Infinity;
  for (const cell of row) {
    const hit = countLe(cell.up, windowS - terS);
    const wrong = countLe(cell.lo, windowS - terS);
    const value = penalizedScore({ ...ZERO_COUNTS, hit, wrong, late: cell.n - hit - wrong }, cell.n);
    if (value > bestValue) {
      best = cell;
      bestValue = value;
    }
  }
  return best;
}

/**
 * One block of n trials: a right answer inside the window is a hit (its RT a clean hit), a wrong one an error, any
 * answer after it late.
 */
function playBlock(r: Rand, cell: DdmCell, terS: number, windowMs: number, n: number): { counts: Record<Outcome, number>; hits: number[] } {
  const counts = { ...ZERO_COUNTS };
  const hits: number[] = [];
  const pUp = cell.up.length / cell.n;
  for (let i = 0; i < n; i++) {
    const up = r.next() < pUp;
    const times = up ? cell.up : cell.lo;
    let rt = 1000 * (terS + (r.next() - 0.5) * 0.05 + (times[Math.floor(r.next() * times.length)] as number));
    if (r.next() < LAPSE) rt += 300 + 400 * r.next();
    if (rt > windowMs) counts.late++;
    else if (up) {
      counts.hit++;
      hits.push(rt);
    } else counts.wrong++;
  }
  return { counts, hits };
}

/**
 * The course of one learner. `floors`: the window is withFloor(szmr.params(L), floor of its band) (spec
 * §3.1.2), the floors from the clean hits of every block so far; otherwise the nominal window.
 */
export function runSzmrCourse(seed: number, o: { floors: boolean; policy: BoundaryPolicy }): SzmrCourse {
  const r = new Rand(seed);
  const hitsByBand = new Map<number, number[]>();
  const bands = szmr.bands ?? [];
  const cells = ddm();
  const n = szmr.blockSize;
  const blocks: SzmrCourseBlock[] = [];
  const savedByDay = new Map<number, number>();
  const ends: number[] = [];
  let lSaved = 0;
  let lastDay = 0;
  let trials = 0;
  let lifetime = 0;
  for (let day = 0; day <= LAST_DAY; day += DAY_STEP) {
    let L = startLevel(lSaved, day - lastDay);
    lastDay = day;
    let prev: number | null = null;
    for (let k = 0; k < BLOCKS_PER_SESSION; k++) {
      const load = loadOf(L);
      const floor = o.floors ? bandFloors(hitsByBand, bands)(load.band) : null;
      const { windowMs } = withFloor(szmr.params(L), floor);
      const drift = learn(0.3, 0.42, trials, PRACTICE_SCALE) * load.drift;
      const terS = learn(0.31, 0.28, trials, PRACTICE_SCALE) + load.ter;
      const cell = pickCell(cells[nearestIdx(VS, drift)] as DdmCell[], o.policy, terS, windowMs / 1000);
      const { counts, hits } = playBlock(r, cell, terS, windowMs, n);
      hitsByBand.set(load.band, [...(hitsByBand.get(load.band) ?? []), ...hits].slice(-FLOOR_HITS));
      const s = penalizedScore(counts, n);
      blocks.push({ day, s, errorRate: counts.wrong / n, L, lSaved });
      L = nextLevel(L, {
        score: s,
        calibration: lifetime < CALIBRATION_BLOCKS,
        prevScoreSameSession: prev,
        firstOfSegment: k === 0,
        cvAll: null,
        lapses: 0,
        lapseLimit: 0,
        cvMax: null,
        timingUnreliable: false,
      });
      prev = s;
      lifetime++;
      trials += n;
    }
    ends.push(L);
    lSaved = savedLevel(ends);
    savedByDay.set(day, lSaved);
  }
  return { blocks, savedByDay };
}
