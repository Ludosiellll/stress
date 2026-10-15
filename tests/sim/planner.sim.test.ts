import { describe, expect, it } from 'vitest';
import { deriveModuleStates, type DeriveBlock, type DeriveSession } from '../../src/engine/derive';
import { currentPhase, firstSessionAt } from '../../src/engine/phases';
import { L_NORM, OVERLOAD_LEVEL_STEP, planTraining, type Segment } from '../../src/engine/planner';
import { MODULE_IDS, type BlockFlag, type ModuleId } from '../../src/engine/types';

/**
 * Ruling W2-R40 (I1): 120 days of daily training planned by the real planTraining, in the phase currentPhase
 * gives (no test date: «База», then «Развитие», «Перегрузка» from day 60), with module states from the real
 * deriveModuleStates over the history so far. Every module plays at its norm, so no module is weaker than another
 * and only recency, plateaus and the finisher steer the plan.
 *
 * Each segment adds BLOCKS_PER_SEGMENT blocks the way the session builds them (blocks.ts isOverloadBlock): a finisher
 * plays only overload blocks; a mix (plateau) alternates a normal block and an overload block; other segments play
 * normal blocks. A normal block ends at L_NORM, an overload block 3 levels higher.
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
        const flags: BlockFlag[] = overload ? ['overload'] : [];
        const lAfter = L_NORM[segment.module] + (overload ? OVERLOAD_LEVEL_STEP : 0);
        blocks.push({ sessionId, module: segment.module, lAfter, flags, startedAt: at(day, minute++) });
        const days = regularDays[segment.module];
        if (!overload && days.at(-1) !== day) days.push(day);
      }
    }
  }
  return regularDays;
}

/** The longest run of days without a normal block, counting from the course start and up to its end. */
function longestGap(days: readonly number[]): number {
  const points = [-1, ...days, DAYS];
  let longest = 0;
  for (let i = 1; i < points.length; i++) longest = Math.max(longest, (points[i] ?? 0) - (points[i - 1] ?? 0));
  return longest;
}

describe('planner simulation (W2-R40): 120 days with every module at its norm', () => {
  it(`every module plays a normal block at least every ${String(MAX_GAP_DAYS)} days`, () => {
    const regularDays = simulate();
    const gaps = Object.fromEntries(MODULE_IDS.map((m) => [m, longestGap(regularDays[m])]));
    const tooLong = Object.entries(gaps).filter(([, gap]) => gap > MAX_GAP_DAYS);
    expect(tooLong).toEqual([]);
  });
});
