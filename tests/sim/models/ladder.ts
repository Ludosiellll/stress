import { levelDelta, savedLevel, startLevel } from '../../../src/engine/adaptive';
import { CALIBRATION_BLOCKS } from '../../../src/engine/phases';
import { lapseLimit } from '../../../src/engine/reaction/stability';
import { penalizedScore } from '../../../src/engine/reaction/summary';
import type { Outcome } from '../../../src/engine/reaction/types';
import { mean, median, sd } from '../../../src/engine/stats';
import type { BandModuleId } from '../../../src/engine/types';
import { FLOOR_HITS, bandFloors } from '../../../src/engine/windowFloor';
import { bandIndex, withFloor } from '../../../src/modules/reaction/common';
import { bandModules } from '../../../src/modules/registry';
import { Rand, learn } from './learner';

/**
 * The load ladders over 90 days (spec §8.4; ported from the fixes simulation ladder.ts). Ex-Gaussian learners play
 * every band module's blocks; the load of each band changes their μ, τ and error rates. The rules are the app's: the
 * window is withFloor(params(L), floor) with the floors of bandFloors over the clean hits of each band, the
 * band is bandIndex, the level moves by levelDelta (the penalised s, the first block of a session's segment, the
 * first CALIBRATION_BLOCKS blocks ever, the previous s, CV_all and lapses of the model with the module's cvMax), the
 * session starts at startLevel and L_saved is savedLevel. Parameters are expert judgement, labelled where they are.
 */

/** The load of a band relative to the test format: μ and τ factors, error rates added (spec §8.4). */
export interface BandLoad {
  mu: number;
  tau: number;
  wrong: number;
  /** False starts among the `press` trials. */
  fs: number;
  /** Presses on no-go trials. */
  com: number;
}

export interface LadderModule {
  /** Share of no-go trials (they come first in the block). */
  noGo: number;
  /** Ex-Gaussian RT of the test format: μ, σ; τ of the steady and of the typical learner. */
  mu: number;
  sigma: number;
  tauSteady: number;
  tauTypical: number;
  /** Error rates of the test format. */
  wrong: number;
  fs: number;
  com: number;
  /** The load of bands 0, 1, …; a band past the list plays the last one. */
  loads: readonly BandLoad[];
}

const ld = (mu: number, tau: number, wrong = 0, fs = 0, com = 0): BandLoad => ({ mu, tau, wrong, fs, com });

/**
 * The learners and their loads (expert judgement; the script's MODS). The script orders two middle bands of
 * Помехоустойчивость and Струп a little differently from the app (near figures as a band of their own, Струп band 3 at
 * 75 % mismatches instead of the short ISI); the strength of the loads is the same (spec §8.4).
 */
export const LADDER_MODULES: Readonly<Record<BandModuleId, LadderModule>> = {
  pzmr: {
    noGo: 0,
    mu: 222,
    sigma: 18,
    tauSteady: 32,
    tauTypical: 48,
    wrong: 0,
    fs: 0.005,
    com: 0,
    loads: [
      ld(1, 1),
      ld(1, 1),
      ld(1.02, 1.1, 0, 0.01),
      ld(1.06, 1.15, 0, 0.01),
      ld(1.08, 1.25, 0, 0.012),
      ld(1.11, 1.3, 0, 0.012),
      ld(1.11, 1.35, 0, 0.012),
      ld(1.12, 1.4, 0, 0.013),
    ],
  },
  szmr: {
    noGo: 0,
    mu: 300,
    sigma: 30,
    tauSteady: 50,
    tauTypical: 72,
    wrong: 0.02,
    fs: 0.003,
    com: 0,
    loads: [
      ld(1, 1),
      ld(1, 1),
      ld(1.08, 1.1, 0.01),
      ld(1.17, 1.2, 0.02),
      ld(1.22, 1.25, 0.025),
      ld(1.3, 1.35, 0.035),
      ld(1.37, 1.45, 0.045),
      ld(1.5, 1.7, 0.07),
      ld(1.53, 1.75, 0.075),
      ld(1.57, 1.8, 0.08),
    ],
  },
  gonogo: {
    noGo: 0.2,
    mu: 240,
    sigma: 20,
    tauSteady: 38,
    tauTypical: 55,
    wrong: 0,
    fs: 0.005,
    com: 0.05,
    loads: [
      ld(1, 1),
      ld(1, 1),
      ld(0.98, 1.05, 0, 0.005, 0.03),
      ld(0.96, 1.1, 0, 0.01, 0.06),
      ld(1.04, 1.15, 0, 0.01, 0.09),
      ld(1.1, 1.2, 0, 0.01, 0.14),
      ld(1.12, 1.25, 0, 0.012, 0.16),
      ld(1.15, 1.3, 0, 0.012, 0.18),
    ],
  },
  pomeh: {
    noGo: 0,
    mu: 237,
    sigma: 18,
    tauSteady: 37,
    tauTypical: 55,
    wrong: 0,
    fs: 0.005,
    com: 0,
    loads: [
      ld(1, 1),
      ld(1, 1),
      ld(1.05, 1.15, 0, 0.005),
      ld(1.25, 1.25, 0.02, 0.005),
      ld(1.3, 1.3, 0.025, 0.005),
      ld(1.33, 1.35, 0.03, 0.005),
      ld(1.36, 1.4, 0.035, 0.006),
      ld(1.4, 1.45, 0.04, 0.006),
    ],
  },
  stroop: {
    noGo: 0,
    mu: 420,
    sigma: 50,
    tauSteady: 90,
    tauTypical: 125,
    wrong: 0.015,
    fs: 0.002,
    com: 0,
    loads: [ld(1, 1), ld(1.08, 1.1, 0.005), ld(1.18, 1.2, 0.012), ld(1.22, 1.25, 0.02), ld(1.35, 1.4, 0.04), ld(1.38, 1.45, 0.045), ld(1.42, 1.5, 0.05)],
  },
  taskswitch: {
    noGo: 0,
    mu: 480,
    sigma: 55,
    tauSteady: 100,
    tauTypical: 140,
    wrong: 0.025,
    fs: 0.002,
    com: 0,
    loads: [ld(1, 1), ld(1, 1), ld(1.12, 1.15, 0.015), ld(1.2, 1.2, 0.02), ld(1.28, 1.3, 0.035), ld(1.31, 1.35, 0.04), ld(1.35, 1.4, 0.045)],
  },
};

/** Steady: τ as in §8.3, 1 % lapses; typical: τ × 1.4–1.5, 2 % lapses. */
export type LadderLearner = 'steady' | 'typical';
const LAPSE_SHARE: Readonly<Record<LadderLearner, number>> = { steady: 0.01, typical: 0.02 };
/** A lapse adds 300…700 ms. */
const LAPSE_MIN_MS = 300;
const LAPSE_SPAN_MS = 400;
/** Practice: μ × 1.08 → 1 and τ × 1.3 → 1, exponential in trials played with this scale. */
const PRACTICE_SCALE = 2500;
/** An answer is late up to this long after the window, then a lapse (F2). */
const LATE_LIMIT_MS = 1000;
/** Lapses: answers above this many medians of the block. */
const LAPSE_FACTOR = 1.5;

/** The course: the module every 3 days from day 0 to day 90, 7 blocks a session, 8 % of the days missed. */
const DAY_STEP = 3;
const LAST_DAY = 90;
const BLOCKS_PER_SESSION = 7;
const MISSED_DAY = 0.08;
/** The overload probe follows this block of each session (k = 2): the next band at the window of the current one. */
const OVERLOAD_AFTER = 2;
/** The finisher sound of an overload block: μ × 1.04, τ × 1.08, wrong keys + 0.005. */
const OVERLOAD_SOUND = { mu: 1.04, tau: 1.08, wrong: 0.005 } as const;
/** The old start drop (before F6): always 2 levels. */
const OLD_DROP = 2;

export interface LadderOptions {
  /** 'new': startLevel (F6); 'old': always −2. */
  drop: 'new' | 'old';
  /** 'F-R1': the app's stability caps; 'zero': CV_all above cvMax caps ΔL at 0 too (lapses = lapseLimit). */
  cvCap: 'F-R1' | 'zero';
}

export interface LadderCourse {
  /** Normal blocks: the penalised s and the errors (wrong keys, false starts, no-go presses) per trial. */
  scores: number[];
  errors: number[];
  /** Normal blocks started at L ≤ L_saved − 1. */
  below: boolean[];
  /** Overload blocks: the penalised s. */
  overload: number[];
  /** L_saved after the session of each course day played. */
  savedByDay: Map<number, number>;
}

interface Played {
  s: number;
  errors: number;
  hits: number[];
  cvAll: number | null;
  lapses: number;
  lapseLimit: number;
  n: number;
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

/** L_saved on day `day`: after the last session played that day or before; 0 before the first. */
export function savedOn(course: LadderCourse, day: number): number {
  let level = 0;
  for (const [d, l] of course.savedByDay) if (d <= day) level = l;
  return level;
}

/** One learner's 90-day course of a band module; seed `seed` (1…12 in the tests). */
export function runLadder(id: BandModuleId, learner: LadderLearner, seed: number, o: LadderOptions): LadderCourse {
  const m = bandModules[id];
  const mod = LADDER_MODULES[id];
  const bands = m.bands ?? [];
  const r = new Rand(seed * 7919 + id.length);
  const loadOf = (band: number): BandLoad => mod.loads[Math.min(band, mod.loads.length - 1)] as BandLoad;
  const tau0 = learner === 'steady' ? mod.tauSteady : mod.tauTypical;
  const hits = new Map<number, number[]>();

  /** One block of n trials at window W: no-go trials first, then `press` trials (RT, false start, wrong key, lapse). */
  const play = (load: BandLoad, W: number, n: number, practice: number): Played => {
    const muP = learn(1.08, 1, practice, PRACTICE_SCALE);
    const tauP = learn(1.3, 1, practice, PRACTICE_SCALE);
    const noGo = Math.round(mod.noGo * n);
    const counts = { ...ZERO_COUNTS };
    const clean: number[] = [];
    const answers: number[] = [];
    let misses = 0;
    for (let i = 0; i < n; i++) {
      if (i < noGo) {
        if (r.next() < mod.com + load.com) counts.commission++;
        else counts.correct_reject++;
        continue;
      }
      if (r.next() < mod.fs + load.fs) {
        counts.false_start++;
        continue;
      }
      let rt = mod.mu * muP * load.mu + mod.sigma * r.normal() + r.exp(tau0 * tauP * load.tau);
      if (r.next() < LAPSE_SHARE[learner]) rt += LAPSE_MIN_MS + LAPSE_SPAN_MS * r.next();
      const wrongKey = r.next() < mod.wrong + load.wrong;
      if (rt <= W) {
        if (wrongKey) counts.wrong++;
        else {
          counts.hit++;
          clean.push(rt);
          answers.push(rt);
        }
      } else if (rt <= W + LATE_LIMIT_MS) {
        counts.late++;
        if (!wrongKey) answers.push(rt);
      } else {
        counts.miss++;
        misses++;
      }
    }
    const nPress = n - noGo;
    const md = answers.length === 0 ? 0 : median(answers);
    return {
      s: penalizedScore(counts, n),
      errors: (counts.wrong + counts.false_start + counts.commission) / n,
      hits: clean,
      cvAll: answers.length < 3 ? null : sd(answers) / mean(answers),
      lapses: misses + answers.filter((x) => x > LAPSE_FACTOR * md).length,
      lapseLimit: lapseLimit(nPress),
      n,
    };
  };

  const course: LadderCourse = { scores: [], errors: [], below: [], overload: [], savedByDay: new Map() };
  const ends: number[] = [];
  let lSaved = 0;
  let lastDay = 0;
  let practice = 0;
  let lifetime = 0;
  for (let day = 0; day <= LAST_DAY; day += DAY_STEP) {
    if (r.next() < MISSED_DAY) continue;
    let L = ends.length === 0 ? 0 : o.drop === 'new' ? startLevel(lSaved, day - lastDay) : Math.max(0, lSaved - OLD_DROP);
    lastDay = day;
    let prev: number | null = null;
    for (let k = 0; k < BLOCKS_PER_SESSION; k++) {
      // The block's own band at L with the window the app plays (withFloor), as the session's bandBlock builds it.
      const blockL = L;
      const band = bandIndex(m, blockL);
      const floor = bandFloors(hits, bands)(band);
      const own = withFloor(m.params(blockL), floor);
      const block = play(loadOf(band), own.windowMs, m.trials(own), practice);
      practice += block.n;
      course.below.push(L <= lSaved - 1);
      course.scores.push(block.s);
      course.errors.push(block.errors);
      hits.set(band, [...(hits.get(band) ?? []), ...block.hits].slice(-FLOOR_HITS));
      const uneven = o.cvCap === 'zero' && block.cvAll !== null && m.cvMax !== null && block.cvAll > m.cvMax;
      L = Math.max(
        0,
        L +
          levelDelta({
            score: block.s,
            calibration: lifetime < CALIBRATION_BLOCKS,
            prevScoreSameSession: prev,
            firstOfSegment: k === 0,
            cvAll: block.cvAll,
            lapses: uneven ? block.lapseLimit : block.lapses,
            lapseLimit: block.lapseLimit,
            cvMax: m.cvMax,
            timingUnreliable: false,
          }),
      );
      prev = block.s;
      lifetime++;
      if (k === OVERLOAD_AFTER) {
        // The next band's load with the finisher sound at this block's level and window (the floor of its own band),
        // as the session plans an overload block: window and trials from the same L. The level and the floors stay.
        const over = withFloor(m.params(blockL, band + 1), floor);
        const next = loadOf(band + 1);
        const loud = { ...next, mu: next.mu * OVERLOAD_SOUND.mu, tau: next.tau * OVERLOAD_SOUND.tau, wrong: next.wrong + OVERLOAD_SOUND.wrong };
        course.overload.push(play(loud, over.windowMs, m.trials(over), practice).s);
      }
    }
    ends.push(L);
    lSaved = savedLevel(ends);
    course.savedByDay.set(day, lSaved);
  }
  return course;
}
