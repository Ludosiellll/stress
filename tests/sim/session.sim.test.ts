import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../../src/data/memoryRepository';
import { planFree } from '../../src/engine/planner';
import { createRng } from '../../src/engine/rng';
import { mean } from '../../src/engine/stats';
import { SessionController } from '../../src/session/controller';
import { playTimeline, type Respond } from '../../src/testing/sessionPlayers';

/**
 * Ruling R6: many sessions through the real SessionController and MemoryRepository. Each session starts at
 * startLevel(L_saved, days) (−2, or −3 after a break), L_saved is the median of the last 3 session-end levels.
 * The player succeeds on a trial with p(L) = 1 / (1 + e^(L − ability)), so the staircase settles where
 * p = 0.8: L* = ability − ln 4. L_saved must stay near L* and must not drift down over the months.
 */

const SESSIONS = 60;
/** Clock advance per block: 8 blocks fit the 5-minute free segment. */
const BLOCK_MS = 40_000;
const DAY_MS = 86_400_000;
const START = new Date('2026-11-02T18:00:00').getTime();

/** Days between consecutive sessions: daily with a day off each week, one 6-day break after session 35. */
function gapBefore(session: number): number {
  if (session === 35) return 6;
  return session % 6 === 0 ? 2 : 1;
}

/** Logistic player on ПЗМР: a success presses inside the window, a failure misses. RT is constant (CV 0). */
function player(ability: number, seed: number): { respond: (L: number) => Respond } {
  const rng = createRng(seed);
  return {
    respond: (L) => (spec) => {
      const e = spec.expected;
      if (e.kind !== 'press') throw new Error('ПЗМР trials are press trials');
      const p = 1 / (1 + Math.exp(L - ability));
      return rng.next() < p ? { key: e.key, rtMs: Math.min(250, spec.windowMs - 10) } : null;
    },
  };
}

async function runMonths(ability: number, seed: number): Promise<{ lSaved: number; savedHistory: number[]; blocks: number }> {
  const repo = new MemoryRepository();
  const p = player(ability, seed);
  let day = 0;
  let blocks = 0;
  for (let s = 0; s < SESSIONS; s++) {
    day += s === 0 ? 0 : gapBefore(s);
    let nowMs = START + day * DAY_MS;
    const c = await SessionController.start({
      repo,
      plan: planFree('pzmr', seed * 1000 + s),
      layout: 'keyboard',
      now: () => new Date(nowMs),
      appVersion: 'sim',
      sleep: () => Promise.resolve(),
    });
    for (let guard = 0; c.step.kind !== 'done'; guard++) {
      if (guard > 100) throw new Error('session did not finish');
      const step = c.step;
      switch (step.kind) {
        case 'instruction':
          c.ackInstruction();
          break;
        case 'reaction_block':
          nowMs += BLOCK_MS;
          blocks++;
          await c.submitReaction(playTimeline(step.specs, p.respond(step.L)));
          break;
        case 'summary':
        case 'fatigue_prompt': // the logistic player never tires; kept for safety
          await (step.kind === 'summary' ? c.continueAfterSummary() : c.answerFatigue(false));
          break;
        default:
          throw new Error(`unexpected step ${step.kind}`);
      }
    }
  }
  const st = (await repo.getModuleStates()).pzmr;
  return { lSaved: st.lSaved, savedHistory: st.savedHistory, blocks };
}

const CASES = [
  { ability: 10, seed: 1 },
  { ability: 18, seed: 2 },
  { ability: 18, seed: 3 },
  { ability: 30, seed: 4 },
];

describe('session simulation (R6): months of daily sessions through the controller', () => {
  it.each(CASES)('ability $ability, seed $seed: L_saved stays near L* = ability − ln 4 without drifting down', async ({ ability, seed }) => {
    const { lSaved, savedHistory, blocks } = await runMonths(ability, seed);
    const equilibrium = ability - Math.log(4);
    expect(blocks).toBe(SESSIONS * 8);
    expect(savedHistory).toHaveLength(SESSIONS);
    expect(Math.abs(lSaved - equilibrium)).toBeLessThanOrEqual(2);
    expect(mean(savedHistory.slice(-10))).toBeGreaterThanOrEqual(mean(savedHistory.slice(19, 30)) - 1);
  });
});
