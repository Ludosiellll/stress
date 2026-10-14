import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../../src/data/memoryRepository';
import { planFree, planTraining, type SessionPlan } from '../../src/engine/planner';
import { createRng } from '../../src/engine/rng';
import { mean } from '../../src/engine/stats';
import { pzmr } from '../../src/modules/reaction/pzmr';
import { SessionController } from '../../src/session/controller';
import { playTimeline, type Respond } from '../../src/testing/sessionPlayers';

/**
 * Rulings R6 / R28a: months of sessions through the real SessionController and MemoryRepository on ПЗМР.
 * Each session starts at startLevel(L_saved, days) (−2, or −3 after a break); L_saved is the median of the
 * last 3 session-end levels.
 *
 * Player: on each trial it tries with p(L) = 1 / (1 + e^(L − ability)); a try has a lognormal RT (median m,
 * CV 0.15) and is a miss when the RT is beyond the window. So the window and the CV stability rule
 * (cvMax) both take part. L* is where the expected score is 0.8:
 * p(L) · P(100 ≤ RT ≤ window(L)) = 0.8, found by bisection. The stability rule is not in L*: it can only
 * hold the level back.
 */

const SESSIONS = 60;
const DAY_MS = 86_400_000;
const START = new Date('2026-11-02T18:00:00').getTime();
const RT_CV = 0.15;
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

interface Player {
  ability: number;
  /** Median RT of a try, ms. */
  medianRt: number;
}

const tryChance = (p: Player, L: number): number => 1 / (1 + Math.exp(L - p.ability));

function expectedScore(p: Player, L: number): number {
  const window = pzmr.params(L).windowMs;
  const inWindow = phi(Math.log(window / p.medianRt) / SIGMA) - phi(Math.log(100 / p.medianRt) / SIGMA);
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

function responder(p: Player, seed: number): (L: number) => Respond {
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

interface SimCase {
  name: string;
  player: Player;
  seed: number;
  /** Clock advance per block. */
  blockMs: number;
  /** Blocks that fit the segment budget at that pace. */
  blocksPerSession: number;
  plan: (session: number, repo: MemoryRepository, todayIso: string) => Promise<SessionPlan>;
}

/** Free ПЗМР: 5 minutes, 8 blocks of 40 s. */
const free = (seed: number) => (session: number): Promise<SessionPlan> => Promise.resolve(planFree('pzmr', seed * 1000 + session));

/** A training session cut to its first segment: the 2-minute ПЗМР warm-up, 5 blocks of 28 s. */
const warmup =
  (seed: number) =>
  async (session: number, repo: MemoryRepository, todayIso: string): Promise<SessionPlan> => {
    const plan = planTraining(await repo.getModuleStates(), todayIso, seed * 1000 + session);
    return { ...plan, segments: plan.segments.slice(0, 1) };
  };

async function runMonths(c: SimCase): Promise<{ lSaved: number; savedHistory: number[]; blocks: number }> {
  const repo = new MemoryRepository();
  const respond = responder(c.player, c.seed);
  let day = 0;
  let blocks = 0;
  for (let s = 0; s < SESSIONS; s++) {
    day += s === 0 ? 0 : gapBefore(s);
    let nowMs = START + day * DAY_MS;
    const ctl = await SessionController.start({
      repo,
      plan: await c.plan(s, repo, new Date(nowMs).toISOString()),
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
          nowMs += c.blockMs;
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
  }
  const st = (await repo.getModuleStates()).pzmr;
  return { lSaved: st.lSaved, savedHistory: st.savedHistory, blocks };
}

const CASES: SimCase[] = [
  { name: 'free, logistic-limited', player: { ability: 10, medianRt: 300 }, seed: 1, blockMs: 40_000, blocksPerSession: 8, plan: free(1) },
  { name: 'free, mixed', player: { ability: 18, medianRt: 220 }, seed: 2, blockMs: 40_000, blocksPerSession: 8, plan: free(2) },
  { name: 'free, window-limited', player: { ability: 30, medianRt: 250 }, seed: 3, blockMs: 40_000, blocksPerSession: 8, plan: free(3) },
  { name: 'training warm-up, mixed', player: { ability: 18, medianRt: 220 }, seed: 4, blockMs: 28_000, blocksPerSession: 5, plan: warmup(4) },
];

describe('session simulation (R6, R28a): months of daily sessions through the controller', () => {
  it.each(CASES)('$name: L_saved stays within 1 of L* and does not drift down', async (c) => {
    const { lSaved, savedHistory, blocks } = await runMonths(c);
    expect(blocks).toBe(SESSIONS * c.blocksPerSession);
    expect(savedHistory).toHaveLength(SESSIONS);
    expect(Math.abs(lSaved - equilibrium(c.player))).toBeLessThanOrEqual(1);
    expect(mean(savedHistory.slice(-10))).toBeGreaterThanOrEqual(mean(savedHistory.slice(19, 30)) - 0.5);
  });
});
