import { TARGET, stabilityHold } from '../../../src/engine/adaptive';
import { stabilityOf } from '../../../src/engine/reaction/stability';
import { summarize } from '../../../src/engine/reaction/summary';
import type { Outcome, TrialCond, TrialResult, TrialSpec } from '../../../src/engine/reaction/types';
import type { BandModuleId } from '../../../src/engine/types';
import { reactionModules } from '../../../src/modules/registry';
import { Rand } from './learner';

/**
 * Ex-Gaussian learners of the six band modules (spec §8.3; ported from the fixes simulation cvmax.ts): RT =
 * μ + σ·N(0, 1) + Exp(τ), lapses add 300…700 ms. The hard condition of Помехоустойчивость, Струп and Переключение
 * shifts μ and stretches τ. Load k: μ × (1 + 0.06k), τ × (1 + 0.1k). The window is the personal floor's fixed point
 * W = 1.2 × P80 of the hits ≤ W (F3). The rules are the app's: a block is built as trial specs and results and scored
 * by summarize (the penalised s), stabilityOf and stabilityHold, with the module's own cvMax.
 */

export interface ExGaussLearner {
  mu: number;
  sigma: number;
  tau: number;
  /** Share of answers with a lapse (+300…700 ms). */
  lapse: number;
  /** Share of false starts among the `press` trials. */
  fs: number;
  /** Share of answers with the wrong key. */
  wrong: number;
  /** Share of presses on a no-go trial. */
  commission: number;
  /** Share of trials in the hard condition (0: the module has none). */
  condShare: number;
  /** μ added in the hard condition, ms. */
  condShift: number;
  /** τ factor in the hard condition. */
  condTau: number;
  /** Share of no-go trials (they come first in the block). */
  noGo: number;
  /** Trials in a block. */
  n: number;
}

export type LearnerKind = 'steady' | 'unsteady';

const BASE = { fs: 0.005, wrong: 0, commission: 0, condShare: 0, condShift: 0, condTau: 1, noGo: 0, n: 20 };

/** Steady: τ 32–100 ms, 1 % lapses (the best 10–25 %); unsteady: τ 60–180 ms, 4 % lapses, more errors. */
export const LEARNERS: Readonly<Record<BandModuleId, Readonly<Record<LearnerKind, ExGaussLearner>>>> = {
  pzmr: {
    steady: { ...BASE, mu: 222, sigma: 18, tau: 32, lapse: 0.01, n: 15 },
    unsteady: { ...BASE, mu: 222, sigma: 22, tau: 60, lapse: 0.04, fs: 0.015, n: 15 },
  },
  szmr: {
    steady: { ...BASE, mu: 300, sigma: 30, tau: 50, lapse: 0.01, fs: 0.003, wrong: 0.02 },
    unsteady: { ...BASE, mu: 300, sigma: 35, tau: 90, lapse: 0.04, fs: 0.01, wrong: 0.04 },
  },
  gonogo: {
    steady: { ...BASE, mu: 240, sigma: 20, tau: 38, lapse: 0.01, commission: 0.05, noGo: 0.2 },
    unsteady: { ...BASE, mu: 240, sigma: 25, tau: 70, lapse: 0.04, fs: 0.015, commission: 0.1, noGo: 0.2 },
  },
  pomeh: {
    steady: { ...BASE, mu: 225, sigma: 18, tau: 35, lapse: 0.01, condShare: 0.5, condShift: 25, condTau: 1.15 },
    unsteady: { ...BASE, mu: 225, sigma: 22, tau: 65, lapse: 0.04, fs: 0.015, condShare: 0.5, condShift: 40, condTau: 1.2 },
  },
  stroop: {
    steady: { ...BASE, mu: 450, sigma: 50, tau: 90, lapse: 0.01, fs: 0.002, wrong: 0.02, condShare: 0.6, condShift: 70, condTau: 1.15 },
    unsteady: { ...BASE, mu: 450, sigma: 60, tau: 160, lapse: 0.04, fs: 0.005, wrong: 0.05, condShare: 0.6, condShift: 90, condTau: 1.2 },
  },
  taskswitch: {
    steady: { ...BASE, mu: 500, sigma: 55, tau: 100, lapse: 0.01, fs: 0.002, wrong: 0.03, condShare: 0.3, condShift: 90, condTau: 1.15 },
    unsteady: { ...BASE, mu: 500, sigma: 65, tau: 180, lapse: 0.04, fs: 0.005, wrong: 0.06, condShare: 0.3, condShift: 120, condTau: 1.2 },
  },
};

/** The easy and the hard condition of the modules with conditions. */
const CONDS: Partial<Record<BandModuleId, readonly [easy: TrialCond, hard: TrialCond]>> = {
  pomeh: ['quiet', 'noisy'],
  stroop: ['congruent', 'incongruent'],
  taskswitch: ['repeat', 'switch'],
};

const SEED = 7;
const BLOCKS = 8000;
const FLOOR_ITERATIONS = 40;
const FLOOR_SAMPLES = 20_000;
const STIMULUS: TrialSpec['stimulus'] = { kind: 'shape', shape: 'circle', color: 'red' };

/** One ex-Gaussian RT, μ + σ·N(0, 1) + Exp(τ), with a lapse of +300…700 ms at the rate `lapse`. */
export function exGaussRt(r: Rand, mu: number, sigma: number, tau: number, lapse: number): number {
  let x = mu + sigma * r.normal() + r.exp(tau);
  if (r.next() < lapse) x += 300 + 400 * r.next();
  return x;
}

function rt(r: Rand, l: ExGaussLearner, hard: boolean, load: number): number {
  const mu = (l.mu + (hard ? l.condShift : 0)) * (1 + 0.06 * load);
  const tau = l.tau * (hard ? l.condTau : 1) * (1 + 0.1 * load);
  return exGaussRt(r, mu, l.sigma, tau, l.lapse);
}

/** The value at rank ⌊p·n⌋ of the sorted values (the script's quantile). */
function quantile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

/** Fixed point of the personal floor: W = 1.2 × P80 of the RTs ≤ W. */
function floorFixedPoint(r: Rand, l: ExGaussLearner, load: number): number {
  let W = 3000;
  for (let it = 0; it < FLOOR_ITERATIONS; it++) {
    const hits: number[] = [];
    for (let i = 0; i < FLOOR_SAMPLES; i++) {
      const x = rt(r, l, r.next() < l.condShare, load);
      if (x <= W) hits.push(x);
    }
    W = 1.2 * quantile(hits, 0.8);
  }
  return W;
}

const result = (idx: number, kind: TrialResult['kind'], outcome: Outcome, rtMs: number | null, wrongKey = false): TrialResult => ({
  idx,
  kind,
  outcome,
  success: outcome === 'hit' || outcome === 'correct_reject',
  rtMs,
  errorMs: null,
  key: rtMs === null ? null : wrongKey ? 'KeyJ' : 'KeyF',
  frameDropped: false,
  practice: false,
});

/**
 * One block at window W, the script's draws in its order: no-go trials first (a press or not), then per `press` trial a
 * false start, the condition, the RT and a wrong key. An RT beyond the window is a late answer, also beyond W + 1000 ms.
 */
function playBlock(r: Rand, m: BandModuleId, l: ExGaussLearner, W: number, load: number): { specs: TrialSpec[]; results: TrialResult[] } {
  const noGoCount = Math.round(l.noGo * l.n);
  const conds = CONDS[m];
  const specs: TrialSpec[] = [];
  const results: TrialResult[] = [];
  for (let i = 0; i < l.n; i++) {
    if (i < noGoCount) {
      specs.push({ isiMs: 0, windowMs: W, stimulus: STIMULUS, expected: { kind: 'withhold' } });
      results.push(result(i, 'withhold', r.next() < l.commission ? 'commission' : 'correct_reject', null));
      continue;
    }
    const spec: TrialSpec = { isiMs: 0, windowMs: W, stimulus: STIMULUS, expected: { kind: 'press', key: 'KeyF' } };
    if (r.next() < l.fs) {
      specs.push(spec);
      results.push(result(i, 'press', 'false_start', null));
      continue;
    }
    const hard = r.next() < l.condShare;
    const x = rt(r, l, hard, load);
    const wrongKey = r.next() < l.wrong;
    specs.push(conds === undefined ? spec : { ...spec, cond: conds[hard ? 1 : 0] });
    if (x <= W) results.push(result(i, 'press', wrongKey ? 'wrong' : 'hit', x, wrongKey));
    else results.push(result(i, 'press', 'late', x, wrongKey));
  }
  return { specs, results };
}

const shares = new Map<string, number>();

/**
 * Of the blocks with s > 0.8 (the only ones the rule can touch), the share where stabilityHold fires: 8000 blocks at the
 * fixed-point window, Rand(7) for each cell.
 */
export function fireShare(m: BandModuleId, kind: LearnerKind, load: number): number {
  const key = `${m}:${kind}:${String(load)}`;
  const known = shares.get(key);
  if (known !== undefined) return known;
  const r = new Rand(SEED);
  const l = LEARNERS[m][kind];
  const W = floorFixedPoint(r, l, load);
  const { cvMax } = reactionModules[m];
  let eligible = 0;
  let fired = 0;
  for (let b = 0; b < BLOCKS; b++) {
    const { specs, results } = playBlock(r, m, l, W, load);
    const score = summarize(results).penalizedScore;
    if (!(score > TARGET)) continue;
    eligible++;
    const { cvAll, lapses, lapseLimit } = stabilityOf(specs, results);
    const input = { score, calibration: false, prevScoreSameSession: null, firstOfSegment: false, cvAll, lapses, lapseLimit, cvMax, timingUnreliable: false };
    if (stabilityHold(input) !== null) fired++;
  }
  const share = fired / Math.max(1, eligible);
  shares.set(key, share);
  return share;
}
