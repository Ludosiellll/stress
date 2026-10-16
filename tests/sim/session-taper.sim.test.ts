import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../../src/data/memoryRepository';
import { localDayIso } from '../../src/engine/dates';
import { warmupLevel } from '../../src/engine/planner';
import { mean } from '../../src/engine/stats';
import { playSession, responder, warmupAndSlot, type Player } from './models/pzmrSessions';

/**
 * The taper over 90-day ПЗМР courses (F5); the player and the sessions live in models/pzmrSessions.ts. The mean over
 * all 20 seeds is one assertion, so the four seed groups stay together in this file.
 */

/** Local 18:00 of course day `day` (local calendar days, DST-safe). */
const courseDay = (day: number): Date => new Date(2026, 10, 2 + day, 18);
const COURSE_DAYS = 90;
const TAPER_CHECK_DAYS = 10;

/** The taper player: the mixed player, whose window the personal floor keeps from binding (T-R43). */
const TAPER_PLAYER: Player = { ability: 18, medianRt: 220 };
/** A course swings with its seed (SD of the drop ≈ 0.6): the mean of 20 seeds measures the taper. */
const TAPER_SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

interface TaperCourse {
  /** L_saved of ПЗМР at the start of each course day. */
  lSaved: number[];
  /** Warm-up blocks that did not play at warmupLevel(L_saved) or moved their level (F5): none expected. */
  offWarmups: string[];
}

/**
 * Daily sessions with a day off after every 6, the test on day 90, so the last 9 days are the taper (shorter warm-up
 * and slot).
 */
async function runCourse(seed: number): Promise<TaperCourse> {
  const repo = new MemoryRepository();
  const respond = responder(TAPER_PLAYER, seed);
  const testDate = localDayIso(courseDay(COURSE_DAYS).toISOString());
  const lSaved: number[] = [];
  const offWarmups: string[] = [];
  for (let day = 0; day <= COURSE_DAYS; day++) {
    const saved = (await repo.getModuleStates()).pzmr.lSaved;
    lSaved.push(saved);
    if (day === COURSE_DAYS || day % 7 === 6) continue;
    const start = courseDay(day);
    const plan = await warmupAndSlot(seed * 1000 + day, repo, start.toISOString(), testDate);
    const stored = (await repo.listBlocks()).length;
    await playSession(repo, plan, start.getTime(), 28_000, respond);
    const L = warmupLevel(saved);
    for (const b of (await repo.listBlocks()).slice(stored)) {
      if (b.flags.includes('warmup') && (b.lBefore !== L || b.lAfter !== L)) offWarmups.push(`day ${String(day)}: ${String(b.lBefore)} → ${String(b.lAfter)}, not ${String(L)}`);
    }
  }
  return { lSaved, offWarmups };
}

/** The seeds in groups of 5, one test each: a course takes about 7 s through the controller. */
const TAPER_GROUPS = [0, 5, 10, 15].map((from) => ({ seeds: TAPER_SEEDS.slice(from, from + 5), name: `${String(from + 1)}–${String(from + 5)}` }));
describe('session simulation (F5): the taper', () => {
  /** The drop of L_saved over the taper per seed: test day − 10 days before; filled by the seed groups. */
  const drops = new Map<number, number>();

  it.each(TAPER_GROUPS)(
    'seeds $name: every warm-up plays at warmupLevel(L_saved) and keeps it (F5)',
    async ({ seeds }) => {
      // 90 daily sessions (a day off after every 6), test date = day 90; plan = the day's warm-up + a ПЗМР reaction
      // segment of 5 min (taperBudget in the taper); TAPER_PLAYER.
      for (const seed of seeds) {
        const { lSaved, offWarmups } = await runCourse(seed);
        expect(offWarmups, `seed ${String(seed)}`).toEqual([]);
        drops.set(seed, (lSaved[COURSE_DAYS] ?? NaN) - (lSaved[COURSE_DAYS - TAPER_CHECK_DAYS] ?? NaN));
      }
    },
    120_000,
  );

  it('the taper does not pull ПЗМР L_saved down (F5): test day ≥ 10 days before − 0.25, mean of 20 seeds', () => {
    expect(drops.size, 'the seed groups above fill the drops: run the whole describe').toBe(TAPER_SEEDS.length);
    expect(mean([...drops.values()])).toBeGreaterThanOrEqual(-0.25);
  });
});
