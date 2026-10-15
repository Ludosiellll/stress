import { describe, expect, it } from 'vitest';
import { mean } from '../../src/engine/stats';
import { runSzmrCourse } from './models/ddmSzmr';

/**
 * F1 (spec §2.1, §8.2): with the share of successes as the block score, a player who maximises it gains levels by
 * guessing fast (the audit: 12–17 % errors). Under the penalised score a wrong key costs one success more, so the
 * best boundary is a careful one. The learner of models/ddmSzmr.ts picks the boundary with the best expected
 * penalised score over a 90-day СЗМР course (12 seeds); its errors are judged in equilibrium, days 46–90.
 */
describe('penalty simulation (F1)', () => {
  it('a score-maximising player keeps errors at ≤ 6 % in equilibrium (wave 1, spec §2.1)', () => {
    const runs = Array.from({ length: 12 }, (_, i) => runSzmrCourse(i + 1, { floors: false, policy: 'opt' }));
    const late = runs.flatMap((r) => r.blocks.filter((b) => b.day >= 46));
    expect(mean(late.map((b) => b.errorRate))).toBeLessThanOrEqual(0.06);
  }, 120_000);
});
