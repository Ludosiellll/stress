import { describe, expect, it } from 'vitest';
import { BAND_MODULES } from '../../src/engine/types';
import { fireShare } from './models/exgauss';

/**
 * F2 (spec §2.2, §8.3): stability over every answer (hits and late presses up to window + 1000 ms) and lapses. The
 * modules' cvMax were chosen so that the rule holds back a steady learner in about one block in five and an unsteady
 * one in most blocks, at any load. The old rule over in-window hits bound in 0–2 % of the blocks.
 */
describe('stability rule simulation (F2)', () => {
  it.each(BAND_MODULES)('%s: the rule fires in 15–25 % of a steady learner\'s blocks with s > 0.8 and in > 50 % of an unsteady one\'s (k = 0, 2, 4)', (m) => {
    for (const k of [0, 2, 4]) {
      expect(fireShare(m, 'steady', k)).toBeGreaterThanOrEqual(0.15);
      expect(fireShare(m, 'steady', k)).toBeLessThanOrEqual(0.25);
      expect(fireShare(m, 'unsteady', k)).toBeGreaterThan(0.5);
    }
  }, 120_000);
});
