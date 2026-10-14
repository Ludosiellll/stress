import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FALSE_START_MS, resolveBlock } from './resolve';
import type { BlockTimeline, Expected, Outcome, Press, Stimulus, TrialSpec } from './types';

function press(key = 'Space', windowMs = 1000): TrialSpec {
  const stimulus: Stimulus = { kind: 'shape', shape: 'circle', color: 'red' };
  return { isiMs: 1000, windowMs, stimulus, expected: { kind: 'press', key } };
}

function withhold(windowMs = 1000): TrialSpec {
  const stimulus: Stimulus = { kind: 'shape', shape: 'circle', color: 'green' };
  return { isiMs: 1000, windowMs, stimulus, expected: { kind: 'withhold' } };
}

function timed(targetOffsetMs: number, toleranceMs: number, windowMs = 2000, key = 'Space'): TrialSpec {
  return {
    isiMs: 1000,
    windowMs,
    stimulus: { kind: 'rdo', startDeg: 0, targetDeg: 90, periodMs: 2000 },
    expected: { kind: 'timed', key, targetOffsetMs, toleranceMs },
  };
}

const p = (key: string, ts: number): Press => ({ key, ts });
const space = (ts: number): Press => p('Space', ts);

function timeline(onsets: number[], presses: Press[], droppedOnset?: boolean[]): BlockTimeline {
  return { onsets, droppedOnset: droppedOnset ?? onsets.map(() => false), presses };
}

/** One trial with onset at 1000 ms. */
const single = (spec: TrialSpec, presses: Press[]) => resolveBlock([spec], timeline([1000], presses));

describe('resolveBlock: validation', () => {
  it('throws RangeError when onsets do not match specs', () => {
    expect(() => resolveBlock([press(), press()], timeline([1000], []))).toThrow(RangeError);
  });

  it('throws RangeError when droppedOnset does not match specs', () => {
    expect(() => resolveBlock([press(), press()], timeline([1000, 3000], [], [false]))).toThrow(RangeError);
  });

  it('throws RangeError when onsets decrease', () => {
    expect(() => resolveBlock([press(), press()], timeline([3000, 1000], []))).toThrow(RangeError);
  });

  it('accepts equal onsets', () => {
    expect(resolveBlock([press(), press()], timeline([1000, 1000], []))).toHaveLength(2);
  });

  it('empty block gives no results', () => {
    expect(resolveBlock([], timeline([], [space(500)]))).toEqual([]);
  });
});

describe('rule 1: presses are sorted and belong to the last trial with onset ≤ ts', () => {
  it('sorts presses by ts before resolving', () => {
    expect(single(press('KeyF'), [p('KeyJ', 1210), p('KeyF', 1200)])).toMatchObject([
      { outcome: 'hit', rtMs: 200, key: 'KeyF' },
    ]);
  });

  it('breaks ts ties by key, so input order never matters', () => {
    const a = single(press('KeyJ'), [p('KeyJ', 1200), p('KeyF', 1200)]);
    const b = single(press('KeyJ'), [p('KeyF', 1200), p('KeyJ', 1200)]);
    expect(a).toMatchObject([{ outcome: 'wrong', key: 'KeyF' }]);
    expect(b).toEqual(a);
  });

  it('a press after the next onset belongs to the next trial even inside the previous window', () => {
    const r = resolveBlock([press(), press()], timeline([1000, 1500], [space(1700)]));
    expect(r).toMatchObject([
      { outcome: 'miss', rtMs: null },
      { outcome: 'hit', rtMs: 200 },
    ]);
  });

  it('a press exactly at onset belongs to that trial', () => {
    const r = resolveBlock([press(), withhold()], timeline([1000, 3000], [space(1300), space(3000)]));
    expect(r).toMatchObject([
      { outcome: 'hit', rtMs: 300 },
      { outcome: 'commission', rtMs: 0, key: 'Space' },
    ]);
  });

  it('press before first onset marks trial 0 false start even with a correct answer later', () => {
    expect(single(press(), [space(900), space(1250)])).toMatchObject([
      { outcome: 'false_start', success: false, rtMs: 250, key: 'Space' },
    ]);
  });

  it('false start before onset with no answer keeps rtMs and key null', () => {
    expect(single(press(), [space(900)])).toMatchObject([{ outcome: 'false_start', rtMs: null, key: null }]);
  });
});

describe('rule 2: the first press inside the window is the response', () => {
  it('hit with rt 250', () => {
    expect(single(press(), [space(1250)])).toMatchObject([
      { idx: 0, outcome: 'hit', success: true, rtMs: 250, key: 'Space', errorMs: null },
    ]);
  });

  it('a press exactly at onset + windowMs is inside the window', () => {
    expect(single(press('Space', 500), [space(1500)])).toMatchObject([{ outcome: 'hit', rtMs: 500 }]);
  });

  it('only first press in window counts', () => {
    expect(single(press('KeyF'), [p('KeyF', 1200), p('KeyJ', 1210)])).toMatchObject([
      { outcome: 'hit', rtMs: 200, key: 'KeyF' },
    ]);
  });

  it('a wrong first press is not corrected by a later right one', () => {
    expect(single(press('KeyF'), [p('KeyJ', 1200), p('KeyF', 1210)])).toMatchObject([
      { outcome: 'wrong', rtMs: 200, key: 'KeyJ' },
    ]);
  });
});

describe('rule 3: presses after the window', () => {
  it('late press after window counts as late for unanswered press trial', () => {
    expect(single(press('Space', 500), [space(1501)])).toMatchObject([
      { outcome: 'late', success: false, rtMs: 501, key: 'Space' },
    ]);
  });

  it('a late press stays late even under 100 ms (only possible with windowMs < 100)', () => {
    expect(single(press('Space', 50), [space(1080)])).toMatchObject([{ outcome: 'late', rtMs: 80, key: 'Space' }]);
  });

  it('only the first press after the window is late; the next one marks the next trial false start', () => {
    const presses = [space(1600), space(1700), space(3300)];
    const r = resolveBlock([press('Space', 500), press()], timeline([1000, 3000], presses));
    expect(r).toMatchObject([
      { outcome: 'late', rtMs: 600 },
      { outcome: 'false_start', rtMs: 300, key: 'Space' },
    ]);
  });

  it('press in ISI after answered trial marks next trial false start', () => {
    const r = resolveBlock([press(), press()], timeline([1000, 3000], [space(1250), space(2500), space(3250)]));
    expect(r).toMatchObject([
      { outcome: 'hit', rtMs: 250 },
      { outcome: 'false_start', success: false, rtMs: 250, key: 'Space' },
    ]);
  });

  it('press after a withhold window marks the next trial false start', () => {
    const r = resolveBlock([withhold(500), press()], timeline([1000, 3000], [space(2000), space(3250)]));
    expect(r).toMatchObject([
      { outcome: 'correct_reject', success: true, rtMs: null, key: null },
      { outcome: 'false_start', rtMs: 250 },
    ]);
  });

  it('press after a timed window marks the next trial false start', () => {
    const r = resolveBlock([timed(300, 20, 500), press()], timeline([1000, 3000], [space(2000), space(3250)]));
    expect(r).toMatchObject([
      { outcome: 'miss', rtMs: null },
      { outcome: 'false_start', rtMs: 250 },
    ]);
  });

  it('a false-start-marked press trial still takes its first late press; the trial after it stays clean', () => {
    const r = resolveBlock(
      [press(), press('Space', 500), press()],
      timeline([1000, 3000, 5000], [space(1250), space(2500), space(3600), space(5250)]),
    );
    expect(r).toMatchObject([
      { outcome: 'hit', rtMs: 250 },
      { outcome: 'false_start', rtMs: 600, key: 'Space' },
      { outcome: 'hit', rtMs: 250 },
    ]);
  });

  it('presses after the last window that would mark a next trial are ignored', () => {
    const r = resolveBlock([press(), withhold(500)], timeline([1000, 3000], [space(1250), space(4000), space(4100)]));
    expect(r).toMatchObject([{ outcome: 'hit' }, { outcome: 'correct_reject', rtMs: null }]);
    expect(single(press(), [space(1250), space(2500)])).toMatchObject([{ outcome: 'hit', rtMs: 250 }]);
  });
});

describe('rule 4: outcomes', () => {
  it('false start threshold is 100 ms', () => {
    expect(FALSE_START_MS).toBe(100);
  });

  it('press: rt 99 is false start', () => {
    expect(single(press(), [space(1099)])).toMatchObject([{ outcome: 'false_start', rtMs: 99, key: 'Space' }]);
  });

  it('press: rt 100 is hit', () => {
    expect(single(press(), [space(1100)])).toMatchObject([{ outcome: 'hit', rtMs: 100 }]);
  });

  it('press: wrong key → wrong', () => {
    expect(single(press('KeyF'), [p('KeyJ', 1300)])).toMatchObject([
      { outcome: 'wrong', success: false, rtMs: 300, key: 'KeyJ' },
    ]);
  });

  it('press: no response → miss', () => {
    expect(single(press(), [])).toMatchObject([{ outcome: 'miss', success: false, rtMs: null, key: null }]);
  });

  it('withhold: press in window → commission', () => {
    expect(single(withhold(), [space(1300)])).toMatchObject([
      { outcome: 'commission', success: false, rtMs: 300, key: 'Space' },
    ]);
  });

  it('withhold: a press under 100 ms is still commission', () => {
    expect(single(withhold(), [space(1050)])).toMatchObject([{ outcome: 'commission', rtMs: 50 }]);
  });

  it('withhold: no press → correct_reject', () => {
    expect(single(withhold(), [])).toMatchObject([{ outcome: 'correct_reject', success: true, rtMs: null, key: null }]);
  });

  it('timed: err +5 with tol 10 → hit, errorMs 5', () => {
    expect(single(timed(500, 10), [space(1505)])).toMatchObject([
      { outcome: 'hit', success: true, rtMs: 505, errorMs: 5, key: 'Space' },
    ]);
  });

  it('timed: err −20 with tol 10 → early', () => {
    expect(single(timed(500, 10), [space(1480)])).toMatchObject([
      { outcome: 'early', success: false, rtMs: 480, errorMs: -20 },
    ]);
  });

  it('timed: err +20 with tol 10 → timing_late', () => {
    expect(single(timed(500, 10), [space(1520)])).toMatchObject([
      { outcome: 'timing_late', success: false, rtMs: 520, errorMs: 20 },
    ]);
  });

  it('timed: |err| equal to tol is a hit', () => {
    expect(single(timed(500, 10), [space(1490)])).toMatchObject([{ outcome: 'hit', errorMs: -10 }]);
    expect(single(timed(500, 10), [space(1510)])).toMatchObject([{ outcome: 'hit', errorMs: 10 }]);
  });

  it('timed: wrong key → wrong, no errorMs', () => {
    expect(single(timed(500, 10), [p('KeyF', 1500)])).toMatchObject([
      { outcome: 'wrong', success: false, rtMs: 500, errorMs: null, key: 'KeyF' },
    ]);
  });

  it('timed: rt under 100 → false_start, errorMs null even for the right key (R10)', () => {
    expect(single(timed(500, 10), [space(1099)])).toMatchObject([
      { outcome: 'false_start', rtMs: 99, errorMs: null, key: 'Space' },
    ]);
  });

  it('timed: no response → miss', () => {
    expect(single(timed(500, 10), [])).toMatchObject([{ outcome: 'miss', rtMs: null, errorMs: null, key: null }]);
  });

  it('timed: a false-start mark overrides an on-target response and clears errorMs (R10)', () => {
    const presses = [space(1500), space(2500), space(3500)];
    const r = resolveBlock([timed(500, 10, 1000), timed(500, 10)], timeline([1000, 3000], presses));
    expect(r).toMatchObject([
      { outcome: 'hit', errorMs: 0 },
      { outcome: 'false_start', success: false, rtMs: 500, errorMs: null, key: 'Space' },
    ]);
  });
});

describe('result fields', () => {
  it('frameDropped copies droppedOnset', () => {
    const r = resolveBlock([press(), press(), press()], timeline([1000, 3000, 5000], [], [false, true, false]));
    expect(r.map((x) => x.frameDropped)).toEqual([false, true, false]);
  });

  it('copies idx, kind and practice (default false)', () => {
    const specs = [{ ...press(), practice: true }, withhold(), timed(500, 10)];
    const r = resolveBlock(specs, timeline([1000, 3000, 5000], []));
    expect(r.map(({ idx, kind, practice }) => ({ idx, kind, practice }))).toEqual([
      { idx: 0, kind: 'press', practice: true },
      { idx: 1, kind: 'withhold', practice: false },
      { idx: 2, kind: 'timed', practice: false },
    ]);
  });

  it('does not mutate the timeline', () => {
    const tl = timeline([1000], [space(1300), space(1200)]);
    resolveBlock([press()], tl);
    expect(tl.presses).toEqual([space(1300), space(1200)]);
  });
});

const KEYS = ['Space', 'KeyF', 'KeyJ'] as const;

const expectedArb: fc.Arbitrary<Expected> = fc.oneof(
  fc.constantFrom(...KEYS).map((key): Expected => ({ kind: 'press', key })),
  fc.constant<Expected>({ kind: 'withhold' }),
  fc
    .record({
      key: fc.constantFrom(...KEYS),
      targetOffsetMs: fc.integer({ min: 0, max: 1500 }),
      toleranceMs: fc.integer({ min: 0, max: 100 }),
    })
    .map((t): Expected => ({ kind: 'timed', ...t })),
);

const specArb: fc.Arbitrary<TrialSpec> = fc.record(
  {
    isiMs: fc.integer({ min: 0, max: 3000 }),
    windowMs: fc.integer({ min: 0, max: 2000 }),
    stimulus: fc.constant({ kind: 'shape', shape: 'circle', color: 'red' } as const),
    expected: expectedArb,
    practice: fc.boolean(),
  },
  { requiredKeys: ['isiMs', 'windowMs', 'stimulus', 'expected'] },
);

const blockArb = fc
  .record({
    trials: fc.array(fc.record({ spec: specArb, gap: fc.integer({ min: 0, max: 2500 }), dropped: fc.boolean() }), {
      minLength: 1,
      maxLength: 15,
    }),
    start: fc.integer({ min: 0, max: 2000 }),
  })
  .chain(({ trials, start }) => {
    const onsets: number[] = [];
    let t = start;
    for (const { gap } of trials) {
      t += gap;
      onsets.push(t);
    }
    const pressArb = fc.record({ key: fc.constantFrom(...KEYS), ts: fc.integer({ min: 0, max: t + 3000 }) });
    return fc.array(pressArb, { maxLength: 40 }).map((presses) => ({
      specs: trials.map((x) => x.spec),
      tl: { onsets, droppedOnset: trials.map((x) => x.dropped), presses },
    }));
  });

const ALLOWED: Record<Expected['kind'], readonly Outcome[]> = {
  press: ['hit', 'wrong', 'miss', 'late', 'false_start'],
  withhold: ['commission', 'correct_reject', 'false_start'],
  timed: ['hit', 'early', 'timing_late', 'wrong', 'miss', 'false_start'],
};

const NEEDS_RT: readonly Outcome[] = ['hit', 'wrong', 'late', 'commission'];
const WITH_ERROR: readonly Outcome[] = ['hit', 'early', 'timing_late'];

describe('resolveBlock properties', () => {
  it('one consistent result per trial', () => {
    fc.assert(
      fc.property(blockArb, ({ specs, tl }) => {
        const results = resolveBlock(specs, tl);
        expect(results).toHaveLength(specs.length);
        results.forEach((r, i) => {
          const spec = specs[i];
          expect(r.idx).toBe(i);
          expect(r.kind).toBe(spec?.expected.kind);
          expect(ALLOWED[r.kind]).toContain(r.outcome);
          expect(r.success).toBe(r.outcome === 'hit' || r.outcome === 'correct_reject');
          if (NEEDS_RT.includes(r.outcome)) expect(r.rtMs).not.toBeNull();
          expect(r.rtMs === null).toBe(r.key === null);
          if (r.rtMs !== null) expect(r.rtMs).toBeGreaterThanOrEqual(0);
          if (r.errorMs !== null) {
            expect(r.kind).toBe('timed');
            expect(WITH_ERROR).toContain(r.outcome);
          }
          expect(r.frameDropped).toBe(tl.droppedOnset[i]);
          expect(r.practice).toBe(spec?.practice ?? false);
        });
      }),
      { numRuns: 1000 },
    );
  });

  it('does not depend on the order presses are given in', () => {
    const arb = blockArb.chain((block) =>
      fc
        .shuffledSubarray(block.tl.presses, { minLength: block.tl.presses.length })
        .map((shuffled) => ({ ...block, shuffled })),
    );
    fc.assert(
      fc.property(arb, ({ specs, tl, shuffled }) => {
        expect(resolveBlock(specs, { ...tl, presses: shuffled })).toEqual(resolveBlock(specs, tl));
      }),
      { numRuns: 1000 },
    );
  });
});
