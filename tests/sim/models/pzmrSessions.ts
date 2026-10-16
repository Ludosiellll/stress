import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../../../src/data/memoryRepository';
import { currentPhase, firstSessionAt } from '../../../src/engine/phases';
import { planFree, planTraining, taperBudget, type Segment, type SessionPlan } from '../../../src/engine/planner';
import { createRng } from '../../../src/engine/rng';
import { mean } from '../../../src/engine/stats';
import { FLOOR_FACTOR } from '../../../src/engine/windowFloor';
import { pzmr } from '../../../src/modules/reaction/pzmr';
import { SessionController } from '../../../src/session/controller';
import { playTimeline, type Respond } from '../../../src/testing/sessionPlayers';

/**
 * The ПЗМР sessions through the controller and their player, shared by session-free, session-warmup and
 * session-taper.sim.test.ts: one file per long part, so vitest's workers run them side by side (T-R49).
 *
 * Rulings R6 / R28a: months of sessions through the real SessionController and MemoryRepository on ПЗМР.
 * Each session starts at startLevel(L_saved, days) (−1 up to 4 days, −2 for 5–14, −3 beyond; F6); L_saved is the median of the
 * last 3 session-end levels.
 *
 * Player: on each trial it tries with p(L) = 1 / (1 + e^(L − ability)); a try has a lognormal RT (median m,
 * CV 0.15) and is a miss when the RT is beyond the window. So the window and the CV stability rule
 * (cvMax) both take part. The window is the nominal one of L or the personal floor (F3), whichever is larger; the
 * floor of a player whose band stays settles at W*, the fixed point of W = 1.2 · P80 of its hits (the tries ≤ W).
 * L* is where the expected score is 0.8: p(L) · P(100 ≤ RT ≤ max(window(L), W*)) = 0.8, found by bisection. The
 * stability rule is not in L*: it can only hold the level back.
 *
 * Ruling R29: every case runs on 5 seeds and is judged on window means, not on single values:
 * - each seed: the mean L_saved over sessions 31–60 is within 1 of L*;
 * - the case: the drift mean(sessions 51–60) − mean(sessions 21–30), averaged over its seeds, is ≥ −0.5.
 *   A single seed's drift has SD ≈ 0.22 (window means of a noisy staircase), so a per-seed −0.5 bound
 *   would fail on noise alone for some seed in about every other set of 20 runs; the mean of 5 seeds
 *   (SD ≈ 0.1) still catches a real drift of 0.5 levels per 30 sessions.
 */

const SESSIONS = 60;
const DAY_MS = 86_400_000;
const START = new Date('2026-11-02T18:00:00').getTime();
const RT_CV = 0.15;
const SEEDS = [1, 2, 3, 4, 5];
const SIGMA = Math.sqrt(Math.log(1 + RT_CV ** 2));

/** Days between consecutive sessions: daily with a day off each week, one 6-day break after session 35. */
function gapBefore(session: number): number {
  if (session === 35) return 6;
  return session % 6 === 0 ? 2 : 1;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1.5e-7). */
function phi(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp((-x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export interface Player {
  ability: number;
  /** Median RT of a try, ms. */
  medianRt: number;
}

const tryChance = (p: Player, L: number): number => 1 / (1 + Math.exp(L - p.ability));

/** P(RT ≤ x) of the player's tries (lognormal). */
const rtCdf = (p: Player, x: number): number => phi(Math.log(x / p.medianRt) / SIGMA);

/** The 0.8-quantile of the try RTs truncated to [100, W]: bisection on the CDF. */
function q80(p: Player, W: number): number {
  const from = rtCdf(p, 100);
  const target = from + 0.8 * (rtCdf(p, W) - from);
  let lo = 100;
  let hi = W;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (rtCdf(p, mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** W*: the fixed point of W = 1.2 · q80(W), 50 steps from W = 3000 — the window the personal floor settles at. */
function floorWindow(p: Player): number {
  let W = 3000;
  for (let i = 0; i < 50; i++) W = FLOOR_FACTOR * q80(p, W);
  return W;
}

function expectedScore(p: Player, L: number): number {
  const window = Math.max(pzmr.params(L).windowMs, Math.round(floorWindow(p)));
  const inWindow = rtCdf(p, window) - rtCdf(p, 100);
  return tryChance(p, L) * inWindow;
}

/** L where the expected score falls to 0.8 (it falls monotonically with L). */
function equilibrium(p: Player): number {
  let lo = 0;
  let hi = 200;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (expectedScore(p, mid) > 0.8) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function responder(p: Player, seed: number): (L: number) => Respond {
  const rng = createRng(seed);
  const normal = (): number => Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
  return (L) => (spec) => {
    const e = spec.expected;
    if (e.kind !== 'press') throw new Error('ПЗМР trials are press trials');
    if (rng.next() >= tryChance(p, L)) return null;
    const rtMs = p.medianRt * Math.exp(SIGMA * normal());
    return rtMs <= spec.windowMs ? { key: e.key, rtMs } : null;
  };
}

export interface SimCase {
  name: string;
  player: Player;
  /** Clock advance per block. */
  blockMs: number;
  /** Blocks that fit the segment budget at that pace. */
  blocksPerSession: number;
  /** Plan of session `session`; `planSeed` differs per session. */
  plan: (planSeed: number, repo: MemoryRepository, todayIso: string) => Promise<SessionPlan>;
}

/** Free ПЗМР: 5 minutes, 8 blocks of 40 s. */
const free = (planSeed: number): Promise<SessionPlan> => Promise.resolve(planFree('pzmr', planSeed));

/** A ПЗМР reaction slot: 5 minutes, 11 blocks of 28 s (in the taper × 0.6: 7 blocks). */
const pzmrSlot = (taper: boolean): Segment => ({ module: 'pzmr', budgetMs: taper ? taperBudget(300_000) : 300_000, purpose: 'reaction' });

/**
 * A training session cut to the day's ПЗМР warm-up (2 minutes, 5 blocks of 28 s; 1 minute, 3 blocks in the taper)
 * and a ПЗМР reaction slot (F5: ПЗМР is in the reaction pool, and only that slot moves L_saved). Planned as Home
 * does: the phase from the first session (firstSessionAt).
 */
export async function warmupAndSlot(planSeed: number, repo: MemoryRepository, todayIso: string, testDate: string | null = null): Promise<SessionPlan> {
  const [states, sessions] = await Promise.all([repo.getModuleStates(), repo.listSessions()]);
  const phase = currentPhase({ firstSessionAt: firstSessionAt(sessions), today: todayIso, testDate, states });
  const plan = planTraining(states, todayIso, planSeed, phase);
  const warmup = plan.segments.find((s) => s.purpose === 'warmup');
  if (warmup === undefined) throw new Error('a training plan starts with the warm-up');
  return { ...plan, segments: [warmup, pzmrSlot(phase.phase === 'taper')] };
}

/** Plays one session through the controller, `blockMs` of the clock per block; the number of blocks played. */
export async function playSession(repo: MemoryRepository, plan: SessionPlan, startMs: number, blockMs: number, respond: (L: number) => Respond): Promise<number> {
  let nowMs = startMs;
  let blocks = 0;
  const ctl = await SessionController.start({
    repo,
    plan,
    layout: 'keyboard',
    now: () => new Date(nowMs),
    appVersion: 'sim',
    sleep: () => Promise.resolve(),
  });
  for (let guard = 0; ctl.step.kind !== 'done'; guard++) {
    if (guard > 100) throw new Error('session did not finish');
    const step = ctl.step;
    switch (step.kind) {
      case 'instruction':
        ctl.ackInstruction();
        break;
      case 'reaction_block':
        nowMs += blockMs;
        blocks++;
        await ctl.submitReaction(playTimeline(step.specs, respond(step.L)));
        break;
      case 'summary':
        await ctl.continueAfterSummary();
        break;
      case 'fatigue_prompt': // this player never tires; kept for safety
        await ctl.answerFatigue(false);
        break;
      case 'wellbeing':
        await ctl.submitWellbeing(null);
        break;
      default:
        throw new Error(`unexpected step ${step.kind}`);
    }
  }
  return blocks;
}

async function runMonths(c: SimCase, seed: number): Promise<{ savedHistory: number[]; blocks: number }> {
  const repo = new MemoryRepository();
  const respond = responder(c.player, seed);
  let day = 0;
  let blocks = 0;
  for (let s = 0; s < SESSIONS; s++) {
    day += s === 0 ? 0 : gapBefore(s);
    const startMs = START + day * DAY_MS;
    blocks += await playSession(repo, await c.plan(seed * 1000 + s, repo, new Date(startMs).toISOString()), startMs, c.blockMs, respond);
  }
  return { savedHistory: (await repo.getModuleStates()).pzmr.savedHistory, blocks };
}

/** The free ПЗМР cases (session-free.sim.test.ts). */
export const FREE_CASES: SimCase[] = [
  { name: 'free, logistic-limited', player: { ability: 10, medianRt: 300 }, blockMs: 40_000, blocksPerSession: 8, plan: free },
  { name: 'free, mixed', player: { ability: 18, medianRt: 220 }, blockMs: 40_000, blocksPerSession: 8, plan: free },
  { name: 'free, window-limited', player: { ability: 30, medianRt: 250 }, blockMs: 40_000, blocksPerSession: 8, plan: free },
];

/** The training case: the day's warm-up and a ПЗМР reaction slot (session-warmup.sim.test.ts). */
export const WARMUP_CASES: SimCase[] = [
  {
    name: 'training warm-up and ПЗМР reaction slot, mixed',
    player: { ability: 18, medianRt: 220 },
    blockMs: 28_000,
    blocksPerSession: 16,
    plan: (planSeed, repo, todayIso) => warmupAndSlot(planSeed, repo, todayIso),
  },
];

/** Registers the R29 check of these cases, one test per case. */
export function describeMonths(cases: readonly SimCase[]): void {
  describe('session simulation (R6, R28a, R29): months of daily sessions through the controller', () => {
    it.each(cases)(
      '$name: mean L_saved of sessions 31–60 within 1 of L* for every seed, no downward drift',
      async (c) => {
        const target = equilibrium(c.player);
        const offTarget: Array<{ seed: number; gap: number }> = [];
        const drifts: number[] = [];
        for (const seed of SEEDS) {
          const { savedHistory, blocks } = await runMonths(c, seed);
          expect(blocks).toBe(SESSIONS * c.blocksPerSession);
          expect(savedHistory).toHaveLength(SESSIONS);
          const gap = mean(savedHistory.slice(30, 60)) - target;
          if (Math.abs(gap) > 1) offTarget.push({ seed, gap });
          drifts.push(mean(savedHistory.slice(50, 60)) - mean(savedHistory.slice(20, 30)));
        }
        expect(offTarget).toEqual([]);
        expect(mean(drifts)).toBeGreaterThanOrEqual(-0.5);
      },
      120_000,
    );
  });
}
