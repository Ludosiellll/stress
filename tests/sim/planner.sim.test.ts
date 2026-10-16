import { describe, expect, it } from 'vitest';
import { deriveModuleStates, type DeriveBlock, type DeriveSession } from '../../src/engine/derive';
import { currentPhase, firstSessionAt } from '../../src/engine/phases';
import {
  L_NORM,
  OVERLOAD_LEVEL_STEP,
  TEST_FORMAT_FROM_DAY,
  TEST_FORMAT_ORDER,
  planTraining,
  type Segment,
  type TestFormatId,
} from '../../src/engine/planner';
import { MODULE_IDS, type BlockFlag, type ModuleId } from '../../src/engine/types';

/**
 * Ruling W2-R40 (I1): 120 days of daily training planned by the real planTraining, in the phase currentPhase
 * gives (no test date: «База», then «Развитие», «Перегрузка» from day 60), with module states from the real
 * deriveModuleStates over the history so far. Every module plays at its norm, so no module is weaker than another
 * and only recency, plateaus and the finisher steer the plan.
 *
 * Each segment adds BLOCKS_PER_SEGMENT blocks the way the session builds them (blocks.ts isOverloadBlock): a finisher
 * plays only overload blocks; a mix (plateau) alternates a normal block and an overload block; the warm-up plays
 * warm-up blocks (F5); other segments play normal blocks. A normal block ends at L_NORM, an overload block 3 levels higher.
 *
 * The finisher must not hide a module from its regular slot: every module gets a normal block at least every
 * MAX_GAP_DAYS days. Before the fix the finisher's overload blocks set lastTrainedAt, so the finisher module looked
 * trained yesterday, lost its slot and became the finisher again (taskswitch: no normal block in 120 days).
 */

const DAYS = 120;
const MAX_GAP_DAYS = 7;
const BLOCKS_PER_SEGMENT = 2;

/** Local 18:00 of day `day` of the course (local calendar days, DST-safe). */
const at = (day: number, minute: number): string => new Date(2026, 10, 2 + day, 18, minute).toISOString();

function isOverloadBlock(segment: Segment, blockIndex: number): boolean {
  return segment.overload === 'finisher' || (segment.overload === 'mix' && blockIndex % 2 === 1);
}

/** Days (0-based) on which each module played at least one normal (non-overload) block. */
function simulate(): Record<ModuleId, number[]> {
  const sessions: DeriveSession[] = [];
  const blocks: DeriveBlock[] = [];
  const regularDays = Object.fromEntries(MODULE_IDS.map((m) => [m, [] as number[]])) as Record<ModuleId, number[]>;
  for (let day = 0; day < DAYS; day++) {
    const today = at(day, 0);
    const states = deriveModuleStates(sessions, blocks);
    const phase = currentPhase({ firstSessionAt: firstSessionAt(sessions), today, testDate: null, states });
    const plan = planTraining(states, today, day + 1, phase);
    const sessionId = `s${String(day)}`;
    sessions.push({ id: sessionId, startedAt: today, kind: 'training' });
    let minute = 1;
    for (const segment of plan.segments) {
      for (let i = 0; i < BLOCKS_PER_SEGMENT; i++) {
        const overload = isOverloadBlock(segment, i);
        // The warm-up is no regular block (F5): it keeps out of L_saved and lastTrainedAt like an overload block.
        const warmup = segment.purpose === 'warmup';
        const flags: BlockFlag[] = overload ? ['overload'] : warmup ? ['warmup'] : [];
        const lAfter = L_NORM[segment.module] + (overload ? OVERLOAD_LEVEL_STEP : 0);
        // Blocks of the load bands (Р9): the levels count as played.
        const paramsJson = JSON.stringify({ band: Math.floor(lAfter / 4) });
        blocks.push({ sessionId, module: segment.module, lAfter, flags, startedAt: at(day, minute++), paramsJson });
        const days = regularDays[segment.module];
        if (flags.length === 0 && days.at(-1) !== day) days.push(day);
      }
    }
  }
  return regularDays;
}

/** The runs of days without a normal block, counting from the course start and up to its end. */
function gapsOf(days: readonly number[]): number[] {
  const points = [-1, ...days, DAYS];
  return points.slice(1).map((p, i) => p - (points[i] ?? 0));
}

const longestGap = (days: readonly number[]): number => Math.max(...gapsOf(days));

describe('planner simulation (W2-R40): 120 days with every module at its norm', () => {
  it(`every module plays a normal block at least every ${String(MAX_GAP_DAYS)} days`, () => {
    const regularDays = simulate();
    const gaps = Object.fromEntries(MODULE_IDS.map((m) => [m, longestGap(regularDays[m])]));
    const tooLong = Object.entries(gaps).filter(([, gap]) => gap > MAX_GAP_DAYS);
    expect(tooLong).toEqual([]);
  });

  it('ПЗМР gets a regular reaction slot at least once in 7 days on average (F5)', () => {
    const gaps = gapsOf(simulate().pzmr);
    expect(gaps.length).toBeGreaterThan(1);
    expect(gaps.reduce((a, b) => a + b, 0) / gaps.length).toBeLessThanOrEqual(MAX_GAP_DAYS);
  });
});

/**
 * F4 (spec §3.2): 90 days of training, 6 days a week (every 7th day is a rest day), planned by the real planTraining
 * with the stored runs as its extras; each run is stored as a block with the test_format flag, the other segments as
 * in simulate(). From day 15 the runs are counted by week (days 15–21, 22–28, …; the weeks that fit in the course).
 */
const RUN_DAYS = 90;
const REST_EVERY = 7;

function simulateRuns(): { runsByWeek: number[]; formats: Record<TestFormatId, number> } {
  const sessions: DeriveSession[] = [];
  const blocks: DeriveBlock[] = [];
  const runs: string[] = [];
  const runDays: number[] = [];
  const formats = Object.fromEntries(TEST_FORMAT_ORDER.map((f) => [f, 0])) as Record<TestFormatId, number>;
  for (let day = 0; day < RUN_DAYS; day++) {
    // Course day day + 1; every 7th day is a rest day.
    if ((day + 1) % REST_EVERY === 0) continue;
    const today = at(day, 0);
    const states = deriveModuleStates(sessions, blocks);
    const phase = currentPhase({ firstSessionAt: firstSessionAt(sessions), today, testDate: null, states });
    const plan = planTraining(states, today, day + 1, phase, { testFormatRuns: runs });
    const sessionId = `s${String(day)}`;
    sessions.push({ id: sessionId, startedAt: today, kind: 'training' });
    let minute = 1;
    for (const segment of plan.segments) {
      const startedAt = at(day, minute++);
      if (segment.purpose === 'test_format') {
        // One block at L_saved that moves nothing.
        const lAfter = states[segment.module].lSaved;
        blocks.push({ sessionId, module: segment.module, lAfter, flags: ['test_format'], startedAt, paramsJson: '{"band":0}' });
        runs.push(startedAt);
        runDays.push(phase.dayNumber);
        formats[segment.module as TestFormatId]++;
        continue;
      }
      const flags: BlockFlag[] = segment.overload === undefined ? (segment.purpose === 'warmup' ? ['warmup'] : []) : ['overload'];
      const lAfter = L_NORM[segment.module];
      blocks.push({ sessionId, module: segment.module, lAfter, flags, startedAt, paramsJson: JSON.stringify({ band: Math.floor(lAfter / 4) }) });
    }
  }
  const weeks = Math.floor((RUN_DAYS - TEST_FORMAT_FROM_DAY + 1) / 7);
  const runsByWeek = Array.from({ length: weeks }, (_, w) => {
    const from = TEST_FORMAT_FROM_DAY + 7 * w;
    return runDays.filter((d) => d >= from && d < from + 7).length;
  });
  expect(runDays.every((d) => d >= TEST_FORMAT_FROM_DAY)).toBe(true);
  return { runsByWeek, formats };
}

describe('planner simulation: test-format runs (F4)', () => {
  it('test-format runs: 1.7–2.0 a week from day 15, each format at least 5 times', () => {
    const { runsByWeek, formats } = simulateRuns();
    expect(runsByWeek.length).toBeGreaterThanOrEqual(10);
    const perWeek = runsByWeek.reduce((a, b) => a + b, 0) / runsByWeek.length;
    expect(perWeek).toBeGreaterThanOrEqual(1.7);
    expect(perWeek).toBeLessThanOrEqual(2.0);
    for (const f of TEST_FORMAT_ORDER) expect(formats[f], f).toBeGreaterThanOrEqual(5);
  });
});
