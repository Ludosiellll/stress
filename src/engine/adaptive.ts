import { mean, median } from './stats';

/** Target block success rate p* (spec §6.2). */
export const TARGET = 0.8;

const MIN_DELTA = -2;
const MAX_DELTA = 3;
/** The step cap when CV_all is above cvMax and the lapses are below their limit (F2 with F-R1). */
export const CV_HOLD_CAP = 0.5;
/** The step cap when the lapses reach their limit (F2); it wins over CV_HOLD_CAP. */
export const LAPSE_HOLD_CAP = 0;
/** g = 2 also follows a block of the same module in this session with s ≥ 0.95. */
const BOOST_PREV_SCORE = 0.95;
/** A break longer than this many days costs 3 levels instead of 2. */
const LONG_BREAK_DAYS = 4;
/** L_saved is the median of this many latest session-end levels. */
const SAVED_WINDOW = 3;
/** Sessions without a strict new maximum of L_saved that make a plateau. */
const PLATEAU_SESSIONS = 5;
const FATIGUE_MIN_BLOCKS = 4;
const FATIGUE_RT_RISE = 1.12;
const FATIGUE_SCORE_DROP = 0.15;
/**
 * Tolerance for float noise in ≥ thresholds and level maxima. Scores are k/n fractions
 * with n ≤ 100 and steps are multiples of 5/n, so real differences are far above 1e-9.
 */
const EPS = 1e-9;

/** Rounds to 12 decimals (and turns −0 into +0) so that e.g. (0.9 − 0.8)/0.2 is exactly 0.5. */
function snap(x: number): number {
  return Math.round(x * 1e12) / 1e12 + 0;
}

export interface DeltaInput {
  /** Block success rate s ∈ [0, 1]. */
  score: number;
  /** One of the first 3 blocks of the module ever (lifetimeBlocks < 3). */
  calibration: boolean;
  /** s of the previous block of the same module in this session, if any. */
  prevScoreSameSession: number | null;
  /** CV_all of the block (stabilityOf); null: too few answers, or a module without RTs. */
  cvAll: number | null;
  /** Lapses of the block (stabilityOf); 0 for modules without RTs. */
  lapses: number;
  /** This many lapses hold the level (lapseLimit); 0 for modules without RTs. */
  lapseLimit: number;
  /** The module's CV_all limit; null: no stability rule (РДО, tables, memory). */
  cvMax: number | null;
  timingUnreliable: boolean;
}

/** ΔL before the stability rule: g·(s − 0.8)/0.2 clamped to [−2, +3]; 0 for a block whose timing is unreliable. */
function staircaseStep(i: DeltaInput): number {
  if (!(i.score >= 0 && i.score <= 1)) {
    throw new RangeError(`score must be within [0, 1], got ${String(i.score)}`);
  }
  if (i.timingUnreliable) return 0;
  const boosted =
    i.calibration ||
    (i.prevScoreSameSession !== null && i.prevScoreSameSession >= BOOST_PREV_SCORE - EPS);
  const g = boosted ? 2 : 1;
  const raw = snap((g * (i.score - TARGET)) / (1 - TARGET));
  return Math.min(MAX_DELTA, Math.max(MIN_DELTA, raw));
}

/**
 * The cap of the stability rule (F2 with F-R1): with s > 0.8 and a cvMax, lapses at their limit cap ΔL at 0, else CV_all
 * above cvMax caps it at +0.5; null when neither holds.
 */
function stabilityCap(i: DeltaInput): number | null {
  if (!(i.score > TARGET) || i.cvMax === null) return null;
  if (i.lapses >= i.lapseLimit) return LAPSE_HOLD_CAP;
  return i.cvAll !== null && i.cvAll > i.cvMax ? CV_HOLD_CAP : null;
}

/** null: the rule did not fire (s ≤ 0.8, no cvMax, CV and lapses within limits). held: it lowered ΔL. */
export function stabilityHold(i: DeltaInput): { cap: number; held: boolean } | null {
  const step = staircaseStep(i);
  const cap = stabilityCap(i);
  return cap === null ? null : { cap, held: cap < step };
}

/**
 * Weighted staircase step ΔL = g·(s − 0.8)/0.2 clamped to [−2, +3] (spec §6.2), capped by the stability rule
 * (stabilityHold): at +0.5 for an uneven block, at 0 for one with too many lapses.
 */
export function levelDelta(i: DeltaInput): number {
  const step = staircaseStep(i);
  const cap = stabilityCap(i);
  return cap === null ? step : Math.min(step, cap);
}

export function nextLevel(L: number, i: DeltaInput): number {
  return Math.max(0, L + levelDelta(i));
}

/** L_start = max(0, L_saved − 2), or − 3 after more than 4 days; negative daysSince acts as 0. */
export function startLevel(lSaved: number, daysSince: number): number {
  const drop = Math.max(0, daysSince) > LONG_BREAK_DAYS ? 3 : 2;
  return Math.max(0, lSaved - drop);
}

/** Median of the last 3 session-end levels (fewer if fewer sessions); 0 without sessions. */
export function savedLevel(sessionEndLevels: readonly number[]): number {
  if (sessionEndLevels.length === 0) return 0;
  return median(sessionEndLevels.slice(-SAVED_WINDOW));
}

/** ≥ 5 sessions since the last strict new maximum of L_saved; the first value is the initial maximum. */
export function isPlateau(savedLevelHistory: readonly number[]): boolean {
  let max = -Infinity;
  let sinceMax = 0;
  for (const level of savedLevelHistory) {
    if (level > max + EPS) {
      max = level;
      sinceMax = 0;
    } else {
      sinceMax++;
    }
  }
  return sinceMax >= PLATEAU_SESSIONS;
}

export interface FatigueBlock {
  hitRts: readonly number[];
  score: number;
}

/**
 * Blocks of one module in this session, chronological, already without fatigued or
 * timing_unreliable flags. Fatigue: pooled hit-RT median of the last 2 blocks is more
 * than 12% above that of the first 2, and mean s dropped by ≥ 0.15.
 */
export function detectFatigue(blocks: readonly FatigueBlock[]): boolean {
  if (blocks.length < FATIGUE_MIN_BLOCKS) return false;
  const first = blocks.slice(0, 2);
  const last = blocks.slice(-2);
  const firstRts = first.flatMap((b) => b.hitRts);
  const lastRts = last.flatMap((b) => b.hitRts);
  if (firstRts.length === 0 || lastRts.length === 0) return false;
  const rtRose = median(lastRts) > FATIGUE_RT_RISE * median(firstRts);
  const scoreDrop = mean(first.map((b) => b.score)) - mean(last.map((b) => b.score));
  return rtRose && scoreDrop >= FATIGUE_SCORE_DROP - EPS;
}
