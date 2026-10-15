import { describe, expect, it } from 'vitest';
import { L_NORM } from '../../src/engine/planner';
import { mean, median } from '../../src/engine/stats';
import { BAND_MODULES, type BandModuleId } from '../../src/engine/types';
import { runLadder, savedOn, type LadderCourse, type LadderLearner, type LadderOptions } from './models/ladder';

/**
 * F3 with F1, F2 (and F-R1) and F6 (spec §3.1.9, §2.4, §8.4, Р1): every band module over a 90-day course (the module
 * every 3 days, 7 blocks, 8 % of the days missed), 12 seeds, the medians of L_saved on day 90. The learners and their
 * loads are those of models/ladder.ts; the rules are the app's.
 */

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const LEARNERS: readonly LadderLearner[] = ['steady', 'typical'];
const APP: LadderOptions = { drop: 'new', cvCap: 'F-R1' };
const OLD_DROP: LadderOptions = { drop: 'old', cvCap: 'F-R1' };
const ZERO_CAP: LadderOptions = { drop: 'new', cvCap: 'zero' };
/** The modules where a steady learner gets a band past the test format (L_norm + 4) within 90 days (spec §3.1.9). */
const PAST_FORMAT: readonly BandModuleId[] = ['pzmr', 'szmr', 'gonogo', 'pomeh'];

const cache = new Map<string, LadderCourse[]>();
/** The 12 courses of a module, learner and set of rules (each simulated once per file). */
function courses(m: BandModuleId, learner: LadderLearner, o: LadderOptions): LadderCourse[] {
  const key = `${m}:${learner}:${o.drop}:${o.cvCap}`;
  let runs = cache.get(key);
  if (runs === undefined) {
    runs = SEEDS.map((seed) => runLadder(m, learner, seed, o));
    cache.set(key, runs);
  }
  return runs;
}

/** The median over the seeds of L_saved on day 90. */
const day90 = (m: BandModuleId, learner: LadderLearner, o: LadderOptions = APP): number =>
  median(courses(m, learner, o).map((c) => savedOn(c, 90)));
/** A measure of all the blocks of all the seeds. */
const all = (m: BandModuleId, learner: LadderLearner, o: LadderOptions, pick: (c: LadderCourse) => readonly number[]): number =>
  mean(courses(m, learner, o).flatMap((c) => [...pick(c)]));
const belowShare = (m: BandModuleId, learner: LadderLearner, o: LadderOptions): number =>
  all(m, learner, o, (c) => c.below.map(Number));

describe('load bands over 90 days (F3, spec §3.1.9, §8.4)', () => {
  it('steady: L_saved on day 90 ≥ L_norm everywhere and ≥ L_norm + 4 in ПЗМР, СЗМР, Go/No-Go, Помехоустойчивость; ПЗМР ≤ 40', () => {
    for (const m of BAND_MODULES) {
      const level = day90(m, 'steady');
      expect(level, m).toBeGreaterThanOrEqual(L_NORM[m] + (PAST_FORMAT.includes(m) ? 4 : 0));
    }
    // No run-away: the ladder's tail holds a steady learner.
    expect(day90('pzmr', 'steady')).toBeLessThanOrEqual(40);
  }, 120_000);

  it('normal blocks: errors ≤ 5 %, mean s 0.82–0.92; overload blocks: mean s 0.65–0.85', () => {
    for (const m of BAND_MODULES) {
      for (const learner of LEARNERS) {
        const label = `${m}, ${learner}`;
        expect(all(m, learner, APP, (c) => c.errors), label).toBeLessThanOrEqual(0.05);
        const s = all(m, learner, APP, (c) => c.scores);
        expect(s, label).toBeGreaterThanOrEqual(0.82);
        expect(s, label).toBeLessThanOrEqual(0.92);
        const overload = all(m, learner, APP, (c) => c.overload);
        expect(overload, label).toBeGreaterThanOrEqual(0.65);
        expect(overload, label).toBeLessThanOrEqual(0.85);
      }
    }
  }, 120_000);

  it('blocks started ≥ 1 level below L_saved: ≤ 52 % and ≥ 5 points fewer than with the old drop (F6)', () => {
    for (const m of BAND_MODULES) {
      for (const learner of LEARNERS) {
        const label = `${m}, ${learner}`;
        const share = belowShare(m, learner, APP);
        expect(share, label).toBeLessThanOrEqual(0.52);
        expect(belowShare(m, learner, OLD_DROP) - share, label).toBeGreaterThanOrEqual(0.05);
      }
    }
  }, 120_000);

  it('F-R1: a typical learner reaches L_norm by day 90 in ПЗМР, СЗМР, Go/No-Go, Помехоустойчивость, and ends ≥ 0.5 level higher on average than with a zero cap', () => {
    for (const m of PAST_FORMAT) expect(day90(m, 'typical'), m).toBeGreaterThanOrEqual(L_NORM[m]);
    const gain = mean(BAND_MODULES.map((m) => day90(m, 'typical') - day90(m, 'typical', ZERO_CAP)));
    expect(gain).toBeGreaterThanOrEqual(0.5);
  }, 120_000);
});
