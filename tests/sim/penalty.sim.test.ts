import { describe, expect, it } from 'vitest';
import { mean, median } from '../../src/engine/stats';
import { runSzmrCourse, type SzmrCourse } from './models/ddmSzmr';

/**
 * F1 with F3 (spec §2.1, §3.1.9, §8.2): with the share of successes as the block score, a player who maximises it gains
 * levels by guessing fast (the audit: 12–17 % errors). Under the penalised score a wrong key costs one success more,
 * and the personal window floor keeps the window from closing below the player's own answers, so the best boundary
 * is a careful one. The learner of models/ddmSzmr.ts picks the boundary with the best expected penalised score over a
 * 90-day СЗМР course (12 seeds); its errors are judged in equilibrium, days 46–90.
 */

/** L_saved after the last session on or before `day`. */
function savedOn(course: SzmrCourse, day: number): number {
  let level = 0;
  for (const [d, l] of course.savedByDay) if (d <= day) level = l;
  return level;
}

describe('penalty simulation (F1, F3)', () => {
  it('with the personal floor a score-maximising player keeps errors at ≤ 5 % and L_saved grows over 90 days (wave 2)', () => {
    const runs = Array.from({ length: 12 }, (_, i) => runSzmrCourse(i + 1, { floors: true, policy: 'opt' }));
    const late = runs.flatMap((r) => r.blocks.filter((b) => b.day >= 46));
    expect(mean(late.map((b) => b.errorRate))).toBeLessThanOrEqual(0.05);
    expect(median(runs.map((r) => savedOn(r, 90)))).toBeGreaterThan(median(runs.map((r) => savedOn(r, 21))));
  }, 120_000);
});
