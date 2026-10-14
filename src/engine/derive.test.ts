import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isPlateau, savedLevel } from './adaptive';
import {
  MODULE_IDS,
  defaultModuleState,
  deriveModuleStates,
  deriveRatings,
  isCleanBlock,
  isCountedSession,
} from './derive';
import { R0, updateRating, type Rating } from './elo';
import { effectiveDifficulty } from './itemLimit';
import type { BlockFlag, FamilyId, ModuleId, SessionKind } from './types';

interface S {
  id: string;
  startedAt: string;
  kind: SessionKind;
}
interface B {
  sessionId: string;
  module: ModuleId;
  lAfter: number;
  flags: BlockFlag[];
  startedAt: string;
}

const day = (d: number, hh = 8, mm = 0): string =>
  `2026-10-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`;
const ses = (id: string, startedAt: string, kind: SessionKind = 'training'): S => ({ id, startedAt, kind });
const blk = (sessionId: string, module: ModuleId, lAfter: number, startedAt: string, flags: BlockFlag[] = []): B => ({
  sessionId,
  module,
  lAfter,
  flags,
  startedAt,
});

describe('isCountedSession', () => {
  it('counts training and free sessions, never diagnostics', () => {
    expect(isCountedSession('training')).toBe(true);
    expect(isCountedSession('free')).toBe(true);
    expect(isCountedSession('diagnostic')).toBe(false);
  });
});

describe('deriveModuleStates', () => {
  it('returns defaults for every module of the catalogue without history', () => {
    const states = deriveModuleStates([], []);
    expect(Object.keys(states)).toEqual([...MODULE_IDS]);
    for (const m of MODULE_IDS) {
      expect(states[m]).toEqual({
        module: m,
        lSaved: 0,
        sessionEndLevels: [],
        savedHistory: [],
        plateau: false,
        lastTrainedAt: null,
        lifetimeBlocks: 0,
      });
      expect(states[m]).toEqual(defaultModuleState(m));
    }
  });

  it('derive handles unfinished session', () => {
    // Sessions carry no endedAt here at all: an unfinished session counts like any other.
    const states = deriveModuleStates([ses('s1', day(1))], [blk('s1', 'pzmr', 4, day(1, 8, 1)), blk('s1', 'pzmr', 5, day(1, 8, 3))]);
    expect(states.pzmr.sessionEndLevels).toEqual([5]);
    expect(states.pzmr.lSaved).toBe(5);
    expect(states.pzmr.lifetimeBlocks).toBe(2);
    expect(states.pzmr.lastTrainedAt).toBe(day(1, 8, 3));
  });

  it('takes the last clean block by startedAt, whatever the input order', () => {
    const states = deriveModuleStates(
      [ses('s2', day(2)), ses('s1', day(1))],
      [
        blk('s2', 'szmr', 7, day(2, 8, 9)),
        blk('s1', 'szmr', 3, day(1, 8, 9)),
        blk('s2', 'szmr', 6, day(2, 8, 1)),
        blk('s1', 'szmr', 2, day(1, 8, 1)),
      ],
    );
    expect(states.szmr.sessionEndLevels).toEqual([3, 7]);
    expect(states.szmr.savedHistory).toEqual([3, 5]);
    expect(states.szmr.lastTrainedAt).toBe(day(2, 8, 9));
  });

  it('skips fatigued and timing_unreliable blocks for end levels but counts them in lifetime and lastTrainedAt', () => {
    const states = deriveModuleStates(
      [ses('s1', day(1)), ses('s2', day(2))],
      [
        blk('s1', 'gonogo', 3, day(1, 8, 1), ['calibration']),
        blk('s1', 'gonogo', 9, day(1, 8, 2), ['fatigued']),
        blk('s1', 'gonogo', 8, day(1, 8, 3), ['timing_unreliable']),
        blk('s2', 'gonogo', 1, day(2, 8, 1), ['fatigued', 'calibration']),
      ],
    );
    expect(states.gonogo.sessionEndLevels).toEqual([3]);
    expect(states.gonogo.savedHistory).toEqual([3]);
    expect(states.gonogo.lSaved).toBe(3);
    expect(states.gonogo.lifetimeBlocks).toBe(4);
    expect(states.gonogo.lastTrainedAt).toBe(day(2, 8, 1));
  });

  it('skips overload blocks for end levels but counts them in lifetime and lastTrainedAt', () => {
    const states = deriveModuleStates(
      [ses('s1', day(1)), ses('s2', day(2))],
      [
        blk('s1', 'szmr', 6, day(1, 8, 1)),
        blk('s1', 'szmr', 11, day(1, 8, 2), ['overload']),
        // s2 plays the module only in overload blocks (a finisher): no end level for s2.
        blk('s2', 'szmr', 14, day(2, 8, 1), ['overload']),
        blk('s2', 'szmr', 15, day(2, 8, 2), ['overload']),
      ],
    );
    expect(states.szmr.sessionEndLevels).toEqual([6]);
    expect(states.szmr.savedHistory).toEqual([6]);
    expect(states.szmr.lSaved).toBe(6);
    expect(states.szmr.lifetimeBlocks).toBe(4);
    expect(states.szmr.lastTrainedAt).toBe(day(2, 8, 2));
  });

  it('isCleanBlock: a block without fatigued, timing_unreliable or overload', () => {
    expect(isCleanBlock([])).toBe(true);
    expect(isCleanBlock(['calibration'])).toBe(true);
    for (const f of ['fatigued', 'timing_unreliable', 'overload'] as const) expect(isCleanBlock(['calibration', f])).toBe(false);
  });

  it('ignores diagnostic sessions and blocks of unknown sessions; free sessions count', () => {
    const states = deriveModuleStates(
      [ses('d', day(3), 'diagnostic'), ses('f', day(2), 'free'), ses('t', day(1))],
      [
        blk('t', 'rdo', 2, day(1, 8, 1)),
        blk('f', 'rdo', 4, day(2, 8, 1)),
        blk('d', 'rdo', 20, day(3, 8, 1)),
        blk('ghost', 'rdo', 30, day(4, 8, 1)),
        blk('d', 'gorbov', 20, day(3, 8, 2)),
      ],
    );
    expect(states.rdo.sessionEndLevels).toEqual([2, 4]);
    expect(states.rdo.lifetimeBlocks).toBe(2);
    expect(states.rdo.lastTrainedAt).toBe(day(2, 8, 1));
    expect(states.gorbov).toEqual(defaultModuleState('gorbov'));
  });

  it('keeps modules independent and skips sessions without the module', () => {
    const states = deriveModuleStates(
      [ses('s1', day(1)), ses('s2', day(2)), ses('s3', day(3))],
      [blk('s1', 'schulte', 1, day(1, 9)), blk('s2', 'gorbov', 3, day(2, 9)), blk('s3', 'schulte', 2, day(3, 9))],
    );
    expect(states.schulte.sessionEndLevels).toEqual([1, 2]);
    expect(states.gorbov.sessionEndLevels).toEqual([3]);
    expect(states.gorbov.lifetimeBlocks).toBe(1);
  });

  it('orders by instant, not by text, when offsets differ', () => {
    // 10:00+03:00 is 07:00Z, before 08:00Z.
    const states = deriveModuleStates(
      [ses('late', day(1, 8)), ses('early', '2026-10-01T10:00:00.000+03:00')],
      [blk('late', 'pzmr', 9, day(1, 8, 5)), blk('early', 'pzmr', 1, '2026-10-01T10:05:00.000+03:00')],
    );
    expect(states.pzmr.sessionEndLevels).toEqual([1, 9]);
    expect(states.pzmr.lastTrainedAt).toBe(day(1, 8, 5));
  });

  it('falls back to text order for unparseable dates and keeps input order on ties', () => {
    const states = deriveModuleStates(
      [ses('b', 'zzz'), ses('a', 'aaa')],
      [blk('b', 'pzmr', 2, 'x'), blk('a', 'pzmr', 1, 'x'), blk('a', 'pzmr', 3, 'x')],
    );
    expect(states.pzmr.sessionEndLevels).toEqual([3, 2]);
    expect(states.pzmr.lastTrainedAt).toBe('x');

    const three = deriveModuleStates(
      [ses('m', 'mmm'), ses('z', 'zzz'), ses('a', 'aaa'), ses('d', day(1))],
      [blk('m', 'rdo', 2, day(1)), blk('z', 'rdo', 3, day(1)), blk('a', 'rdo', 1, day(1)), blk('d', 'rdo', 0, day(1))],
    );
    // Text order: '2026-…' < 'aaa' < 'mmm' < 'zzz'.
    expect(three.rdo.sessionEndLevels).toEqual([0, 1, 2, 3]);
  });

  it('flags a plateau after 5 sessions without a new maximum', () => {
    const sessions = [1, 2, 3, 4, 5, 6].map((d) => ses(`s${String(d)}`, day(d)));
    const blocks = sessions.map((s) => blk(s.id, 'gorbov', 5, s.startedAt));
    expect(deriveModuleStates(sessions.slice(0, 5), blocks.slice(0, 5)).gorbov.plateau).toBe(false);
    expect(deriveModuleStates(sessions, blocks).gorbov.plateau).toBe(true);
  });

  it('number series have no level: no end levels and never a plateau, but blocks and dates still count (M9)', () => {
    const sessions = [1, 2, 3, 4, 5, 6, 7].map((d) => ses(`s${String(d)}`, day(d)));
    const blocks = sessions.map((s) => blk(s.id, 'numseries', 0, s.startedAt));
    expect(deriveModuleStates(sessions, blocks).numseries).toEqual({
      ...defaultModuleState('numseries'),
      lifetimeBlocks: 7,
      lastTrainedAt: day(7),
    });
  });

  it('savedHistory, lSaved and plateau agree with savedLevel and isPlateau', () => {
    const flagArb = fc.subarray<BlockFlag>(['fatigued', 'timing_unreliable', 'calibration']);
    const sessionArb = fc.array(fc.record({ lAfter: fc.integer({ min: 0, max: 40 }), flags: flagArb }), { minLength: 1, maxLength: 4 });
    fc.assert(
      fc.property(fc.array(sessionArb, { maxLength: 15 }), (plan) => {
        const sessions = plan.map((_, i) => ses(`s${String(i)}`, day(1 + i)));
        const blocks = plan.flatMap((bs, i) => bs.map((b, j) => blk(`s${String(i)}`, 'pzmr', b.lAfter, day(1 + i, 9, j), b.flags)));
        const ends = plan.flatMap((bs) => {
          const clean = bs.filter((b) => !b.flags.includes('fatigued') && !b.flags.includes('timing_unreliable'));
          const last = clean.at(-1);
          return last ? [last.lAfter] : [];
        });
        const st = deriveModuleStates(sessions, blocks).pzmr;
        expect(st.sessionEndLevels).toEqual(ends);
        expect(st.savedHistory).toEqual(ends.map((_, i) => savedLevel(ends.slice(0, i + 1))));
        expect(st.lSaved).toBe(savedLevel(ends));
        expect(st.plateau).toBe(isPlateau(st.savedHistory));
        expect(st.lifetimeBlocks).toBe(blocks.length);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('deriveRatings', () => {
  const FAMS: readonly FamilyId[] = ['arith', 'geom', 'second', 'alt', 'fib', 'linrec', 'powers', 'opcycle'];

  it('is empty without items', () => {
    expect(deriveRatings([])).toEqual(new Map());
  });

  it('counts success only when correct within 40 s for rows without a limit', () => {
    const start: Rating = { rating: R0, n: 0 };
    const at = (correct: boolean, timeMs: number) =>
      deriveRatings([{ family: 'geom', difficulty: 900, correct, timeMs, timeLimitMs: null }]).get('geom');
    expect(at(true, 40000)).toEqual(updateRating(start, 900, true));
    expect(at(true, 40000.5)).toEqual(updateRating(start, 900, false));
    expect(at(false, 1000)).toEqual(updateRating(start, 900, false));
  });

  it('deriveRatings uses the stored limit and the effective difficulty', () => {
    const start: Rating = { rating: R0, n: 0 };
    const dEff = effectiveDifficulty(950, 11900);
    const at = (timeMs: number) =>
      deriveRatings([{ family: 'arith', difficulty: 950, correct: true, timeMs, timeLimitMs: 11900 }]).get('arith');
    expect(at(11000)).toEqual(updateRating(start, dEff, true));
    expect(at(11900)).toEqual(updateRating(start, dEff, true));
    expect(at(12000)).toEqual(updateRating(start, dEff, false));
  });

  it('rebuild gives W1 ratings for rows without a limit', () => {
    const itemArb = fc.record({
      family: fc.constantFrom(...FAMS),
      difficulty: fc.integer({ min: 500, max: 2000 }),
      correct: fc.boolean(),
      timeMs: fc.integer({ min: 0, max: 80000 }),
      timeLimitMs: fc.constant(null),
    });
    fc.assert(
      fc.property(fc.array(itemArb, { maxLength: 60 }), (items) => {
        const expected = new Map<FamilyId, Rating>();
        for (const it of items) {
          const r = expected.get(it.family) ?? { rating: R0, n: 0 };
          expected.set(it.family, updateRating(r, it.difficulty, it.correct && it.timeMs <= 40000));
        }
        expect(deriveRatings(items)).toEqual(expected);
      }),
      { numRuns: 1000 },
    );
  });
});
