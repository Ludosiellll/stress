import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cv, sd } from '../stats';
import { resolveBlock } from './resolve';
import { PENALTY, isCleanHitRt, penalizedScore, penaltyPoints, summarize } from './summary';
import type { Outcome, ReactionSummary, TrialResult, TrialSpec } from './types';

function res(over: Partial<TrialResult> = {}): TrialResult {
  return {
    idx: 0,
    kind: 'press',
    outcome: 'hit',
    success: true,
    rtMs: 300,
    errorMs: null,
    key: 'Space',
    frameDropped: false,
    practice: false,
    ...over,
  };
}

const miss = (over: Partial<TrialResult> = {}) =>
  res({ outcome: 'miss', success: false, rtMs: null, key: null, ...over });

describe('isCleanHitRt', () => {
  it('takes the RT of a press hit outside practice whose onset frame was not dropped', () => {
    expect(isCleanHitRt(res())).toBe(true);
  });

  it.each<[string, Partial<TrialResult>]>([
    ['a practice hit', { practice: true }],
    ['a hit on a dropped onset frame', { frameDropped: true }],
    ['a timed hit', { kind: 'timed', errorMs: 10 }],
    ['a wrong key', { outcome: 'wrong', success: false }],
    ['a late press', { outcome: 'late', success: false }],
    ['a hit without an RT', { rtMs: null }],
  ])('leaves out %s', (_name, over) => {
    expect(isCleanHitRt(res(over))).toBe(false);
  });
});

const ZERO_COUNTS: Record<Outcome, number> = {
  hit: 0,
  wrong: 0,
  miss: 0,
  late: 0,
  false_start: 0,
  commission: 0,
  correct_reject: 0,
  early: 0,
  timing_late: 0,
};

const EMPTY: ReactionSummary = {
  n: 0,
  score: 0,
  penalizedScore: 0,
  meanRt: null,
  medianRt: null,
  sdRt: null,
  cvRt: null,
  counts: ZERO_COUNTS,
  meanAbsErrorMs: null,
  meanSignedErrorMs: null,
  timingUnreliable: false,
};

const TEN: TrialResult[] = [
  res({ rtMs: 200 }),
  res({ rtMs: 300 }),
  res({ rtMs: 400 }),
  res({ rtMs: 900 }),
  res({ outcome: 'wrong', success: false, rtMs: 250, key: 'KeyJ' }),
  miss(),
  res({ outcome: 'late', success: false, rtMs: 1200 }),
  res({ outcome: 'false_start', success: false, rtMs: 50 }),
  res({ kind: 'withhold', outcome: 'correct_reject', success: true, rtMs: null, key: null }),
  res({ kind: 'withhold', outcome: 'commission', success: false, rtMs: 300 }),
].map((r, idx) => ({ ...r, idx }));

describe('summarize', () => {
  it('known set of 10 results', () => {
    const s = summarize(TEN);
    expect(s.n).toBe(10);
    expect(s.score).toBe(0.5);
    // 5 successes − 1 wrong − 2·(1 false start + 1 no-go press) = 0.
    expect(s.penalizedScore).toBe(0);
    expect(s.meanRt).toBe(450);
    expect(s.medianRt).toBe(350);
    expect(s.sdRt).toBeCloseTo(310.9126, 3);
    expect(s.sdRt).toBe(sd([200, 300, 400, 900]));
    expect(s.cvRt).toBe(cv([200, 300, 400, 900]));
    expect(s.counts).toEqual({
      ...ZERO_COUNTS,
      hit: 4,
      wrong: 1,
      miss: 1,
      late: 1,
      false_start: 1,
      correct_reject: 1,
      commission: 1,
    });
    expect(s.meanAbsErrorMs).toBeNull();
    expect(s.meanSignedErrorMs).toBeNull();
    expect(s.timingUnreliable).toBe(false);
  });

  it('counts always has all nine outcomes', () => {
    expect(Object.keys(summarize([res()]).counts).sort()).toEqual(Object.keys(ZERO_COUNTS).sort());
  });

  it('RT statistics use only hits of press trials', () => {
    const s = summarize([
      res({ rtMs: 300 }),
      res({ rtMs: 500 }),
      res({ kind: 'timed', rtMs: 2000, errorMs: 0 }),
      res({ outcome: 'wrong', success: false, rtMs: 100 }),
      res({ outcome: 'late', success: false, rtMs: 1500 }),
    ]);
    expect(s.meanRt).toBe(400);
    expect(s.medianRt).toBe(400);
  });

  it('a single hit has sd and cv 0', () => {
    expect(summarize([res({ rtMs: 300 })])).toMatchObject({ meanRt: 300, medianRt: 300, sdRt: 0, cvRt: 0 });
  });

  it('no press hits → RT statistics are null', () => {
    const rejected = res({ kind: 'withhold', outcome: 'correct_reject', rtMs: null, key: null });
    expect(summarize([miss(), rejected])).toMatchObject({
      score: 0.5,
      meanRt: null,
      medianRt: null,
      sdRt: null,
      cvRt: null,
    });
  });

  it('error statistics use timed trials with an errorMs', () => {
    const timedRes = (outcome: Outcome, errorMs: number | null) =>
      res({
        kind: 'timed',
        outcome,
        success: outcome === 'hit',
        rtMs: errorMs === null ? null : 500 + errorMs,
        key: errorMs === null ? null : 'Space',
        errorMs,
      });
    const s = summarize([
      timedRes('hit', 5),
      timedRes('early', -20),
      timedRes('timing_late', 20),
      timedRes('miss', null),
      res({ kind: 'timed', outcome: 'wrong', success: false, rtMs: 400, errorMs: null, key: 'KeyF' }),
    ]);
    expect(s.meanAbsErrorMs).toBe(15);
    expect(s.meanSignedErrorMs).toBeCloseTo(5 / 3, 10);
    expect(s.meanRt).toBeNull();
    expect(s.score).toBe(0.2);
  });

  it('false starts never enter error statistics (resolveBlock → summarize, R10)', () => {
    const spec: TrialSpec = {
      isiMs: 1000,
      windowMs: 1000,
      stimulus: { kind: 'rdo', startDeg: 0, targetDeg: 90, periodMs: 2000 },
      expected: { kind: 'timed', key: 'Space', targetOffsetMs: 500, toleranceMs: 10 },
    };
    const sp = (ts: number) => ({ key: 'Space', ts });
    // trial 0: err +5 hit; trial 1: rt 50 false start; trial 2: ISI press marks it, then an on-target press
    const presses = [sp(1505), sp(3050), sp(4500), sp(5500)];
    const tl = { onsets: [1000, 3000, 5000], droppedOnset: [false, false, false], presses };
    const results = resolveBlock([spec, spec, spec], tl);
    const s = summarize(results);
    expect(s.counts.false_start).toBe(2);
    expect(s.meanAbsErrorMs).toBe(5);
    expect(s.meanSignedErrorMs).toBe(5);
  });

  it('practice trials do not affect anything', () => {
    const practice = [
      res({ rtMs: 5000, practice: true, frameDropped: true }),
      miss({ practice: true, frameDropped: true }),
      res({ kind: 'timed', rtMs: 900, errorMs: 400, practice: true }),
    ];
    expect(summarize([...practice, ...TEN])).toEqual(summarize(TEN));
  });

  it('timingUnreliable: 1 of 20 dropped (0.05) → false', () => {
    const rs = Array.from({ length: 20 }, (_, i) => res({ idx: i, frameDropped: i === 0 }));
    expect(summarize(rs).timingUnreliable).toBe(false);
  });

  it('timingUnreliable: 2 of 20 dropped (0.1 > 0.05) → true', () => {
    const rs = Array.from({ length: 20 }, (_, i) => res({ idx: i, frameDropped: i < 2 }));
    expect(summarize(rs).timingUnreliable).toBe(true);
  });

  it('timingUnreliable: a single dropped onset never flags a block, even in 15 trials (1/15 > 0.05)', () => {
    const rs = Array.from({ length: 15 }, (_, i) => res({ idx: i, frameDropped: i === 3 }));
    expect(summarize(rs).timingUnreliable).toBe(false);
  });

  it('timingUnreliable: 2 of 60 dropped (0.033) → false', () => {
    const rs = Array.from({ length: 60 }, (_, i) => res({ idx: i, frameDropped: i < 2 }));
    expect(summarize(rs).timingUnreliable).toBe(false);
  });

  it('timingUnreliable: 2 of 3 dropped → true (the share decides once there are 2)', () => {
    const rs = Array.from({ length: 3 }, (_, i) => res({ idx: i, frameDropped: i < 2 }));
    expect(summarize(rs).timingUnreliable).toBe(true);
  });

  it('RT statistics leave out hits with a dropped onset frame; score and counts keep them', () => {
    const s = summarize([res({ rtMs: 300 }), res({ rtMs: 500 }), res({ rtMs: 2000, frameDropped: true })]);
    expect(s).toMatchObject({ meanRt: 400, medianRt: 400, sdRt: sd([300, 500]), cvRt: cv([300, 500]), score: 1 });
    expect(s.counts.hit).toBe(3);
    expect(s.n).toBe(3);
  });

  it('only dropped-onset hits → RT statistics are null', () => {
    expect(summarize([res({ frameDropped: true })])).toMatchObject({ meanRt: null, medianRt: null, sdRt: null, cvRt: null });
  });

  it('empty set → score 0, statistics null', () => {
    expect(summarize([])).toEqual(EMPTY);
  });

  it('only practice trials → same as empty', () => {
    expect(summarize([res({ practice: true, frameDropped: true })])).toEqual(EMPTY);
  });
});

describe('penalizedScore (F1)', () => {
  const c = (o: Partial<Record<Outcome, number>>) => ({ ...ZERO_COUNTS, ...o });

  it('penalised score: wrong costs 2, a false start or a no-go press 3, late and miss 1 (spec §2.1)', () => {
    expect(penalizedScore(c({ hit: 20 }), 20)).toBe(1);
    expect(penalizedScore(c({ hit: 17, wrong: 2, false_start: 1 }), 20)).toBeCloseTo(0.65, 12);
    expect(penalizedScore(c({ hit: 16, correct_reject: 3, commission: 1 }), 20)).toBeCloseTo(0.85, 12);
    expect(penalizedScore(c({ hit: 10, miss: 3, late: 2 }), 15)).toBeCloseTo(10 / 15, 12);
    expect(penalizedScore(c({ hit: 8, early: 1, timing_late: 1 }), 10)).toBeCloseTo(0.8, 12);
    expect(penalizedScore(c({ hit: 2, false_start: 13 }), 15)).toBe(0);
    expect(penalizedScore(c({}), 0)).toBe(0);
    expect(penaltyPoints(c({ wrong: 2, false_start: 1 }))).toBe(4);
  });

  it('the penalty is the cost above a non-success: wrong 1, false start 2, no-go press 2', () => {
    expect(PENALTY).toEqual({ wrong: 1, false_start: 2, commission: 2 });
    expect(penaltyPoints(c({ hit: 9, miss: 4, late: 3, early: 2, timing_late: 1, correct_reject: 5 }))).toBe(0);
    expect(penaltyPoints(c({ wrong: 3, false_start: 2, commission: 1 }))).toBe(9);
  });

  it('for any results 0 ≤ penalizedScore ≤ score, equal without wrong keys, false starts and no-go presses', () => {
    const OUTCOMES = Object.keys(ZERO_COUNTS) as Outcome[];
    const result = fc
      .record({ outcome: fc.constantFrom(...OUTCOMES), practice: fc.boolean() })
      .map(({ outcome, practice }) => res({ outcome, success: outcome === 'hit' || outcome === 'correct_reject', practice }));
    fc.assert(
      fc.property(fc.array(result, { maxLength: 70 }), (results) => {
        const s = summarize(results);
        expect(s.penalizedScore).toBeGreaterThanOrEqual(0);
        expect(s.penalizedScore).toBeLessThanOrEqual(s.score);
        expect(s.penalizedScore).toBe(penalizedScore(s.counts, s.n));
        if (s.counts.wrong + s.counts.false_start + s.counts.commission === 0) expect(s.penalizedScore).toBe(s.score);
      }),
      { numRuns: 1000 },
    );
  });

  it('summarize counts the penalty over the non-practice trials only', () => {
    const practice = [
      res({ outcome: 'false_start', success: false, rtMs: 40, practice: true }),
      res({ outcome: 'wrong', success: false, key: 'KeyJ', practice: true }),
    ];
    const block = [
      ...Array.from({ length: 8 }, () => res()),
      res({ outcome: 'wrong', success: false, key: 'KeyJ' }),
      miss(),
    ];
    const s = summarize([...practice, ...block]);
    expect(s).toMatchObject({ n: 10, score: 0.8 });
    expect(s.penalizedScore).toBeCloseTo(0.7, 12);
  });
});
