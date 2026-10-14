import { describe, expect, it } from 'vitest';
import { diagnosticSegmentSeed, planDiagnostic } from '../engine/diagnostic';
import type { Segment } from '../engine/planner';
import type { Outcome, ReactionSummary } from '../engine/reaction/types';
import { createRng, deriveSeed } from '../engine/rng';
import { pzmr } from '../modules/reaction/pzmr';
import { gorbovMetrics } from '../modules/tables/gorbov';
import { perfectPlayer, playTimeline } from '../testing/sessionPlayers';
import {
  diagnosticBlockSeed,
  diagnosticResults,
  planBlock,
  scaledCount,
  scaledPractice,
  scoreReaction,
  scoreSeries,
  trainingBlockSeed,
} from './blocks';
import type { StepOf } from './steps';

const counts = {} as Record<Outcome, number>;
const summary = (over: Partial<ReactionSummary>): ReactionSummary => ({
  n: 10,
  score: 0.9,
  meanRt: null,
  medianRt: null,
  sdRt: null,
  cvRt: null,
  counts,
  meanAbsErrorMs: null,
  meanSignedErrorMs: null,
  timingUnreliable: false,
  ...over,
});

describe('scale', () => {
  it('block sizes and item counts: max(3, round(n·scale))', () => {
    expect([scaledCount(15, 1), scaledCount(15, 0.02), scaledCount(50, 0.1), scaledCount(10, 2)]).toEqual([15, 3, 5, 20]);
  });

  it('practice trials only shrink under scale < 1, never below 1', () => {
    expect([scaledPractice(5, 1), scaledPractice(5, 2), scaledPractice(5, 0.02), scaledPractice(5, 0.5), scaledPractice(0, 0.02)]).toEqual([
      5, 5, 1, 3, 0,
    ]);
  });
});

describe('seeds', () => {
  it('training: deriveSeed(plan.seed, segment:block:attempt)', () => {
    expect(trainingBlockSeed(7, 2, 3, 1)).toBe(deriveSeed(7, '2:3:1'));
  });

  it('diagnostic: the segment seed, then run:i for later blocks, retry:k after a discard', () => {
    const seg = diagnosticSegmentSeed(5, 'gorbov');
    expect(diagnosticBlockSeed(5, 'gorbov', 0, 0)).toBe(seg);
    expect(diagnosticBlockSeed(5, 'gorbov', 2, 0)).toBe(deriveSeed(seg, 'run:2'));
    expect(diagnosticBlockSeed(5, 'gorbov', 0, 1)).toBe(deriveSeed(seg, 'retry:1'));
    expect(diagnosticBlockSeed(5, 'gorbov', 1, 2)).toBe(deriveSeed(deriveSeed(seg, 'run:1'), 'retry:2'));
  });
});

describe('planBlock', () => {
  it('diagnostic series: count capped by the 20-item schedule, total limit scaled', () => {
    const segment = planDiagnostic(1).segments[5] as Segment;
    expect(planBlock({ ...segment, items: 50 }, 0, 0, { layout: 'keyboard', scale: 1, diagnostic: true })).toEqual({
      kind: 'numseries',
      diagnostic: true,
      count: 20,
      perItemLimitMs: null,
      totalLimitMs: 600_000,
    });
    const noLimit: Segment = { module: 'numseries', budgetMs: 0, purpose: 'diagnostic', items: 20 };
    expect(planBlock(noLimit, 0, 0, { layout: 'keyboard', scale: 0.5, diagnostic: true })).toMatchObject({
      count: 10,
      totalLimitMs: null,
    });
  });
});

describe('scoreReaction', () => {
  it('null when every trial is practice (nothing to score)', () => {
    const specs = pzmr.generateBlock(pzmr.params(0), createRng(1), 'keyboard', 3).map((t) => ({ ...t, practice: true }));
    expect(scoreReaction(specs, playTimeline(specs, perfectPlayer))).toBeNull();
  });

  it('hit RTs of press trials outside practice', () => {
    const base = pzmr.generateBlock(pzmr.params(0), createRng(1), 'keyboard', 3);
    const specs = [...base.slice(0, 1).map((t) => ({ ...t, practice: true })), ...base];
    const scored = scoreReaction(specs, playTimeline(specs, (spec, i) => (i === 3 ? null : { key: 'Space', rtMs: 250 + i })));
    expect(scored?.hitRts).toEqual([251, 252]);
    expect(scored?.summary.n).toBe(3);
  });
});

describe('scoreSeries', () => {
  const step = (perItemLimitMs: number | null, totalLimitMs: number | null): StepOf<'numseries_block'> => ({
    kind: 'numseries_block',
    items: [1, 2, 3].map((i) => ({ id: `arith:${String(i)}`, family: 'arith', seed: i, shown: [1, 2, 3], answer: 4, difficulty: 800 })),
    perItemLimitMs,
    totalLimitMs,
  });
  const answers = [
    { itemId: 'arith:1', given: 4, timeMs: 30_000 },
    { itemId: 'arith:2', given: 5, timeMs: 1000 },
    { itemId: 'arith:3', given: 4, timeMs: 41_000 },
  ];

  it('per-item limit (training)', () => {
    expect(scoreSeries(step(40_000, null), answers).map((o) => [o.correct, o.success])).toEqual([
      [true, true],
      [false, false],
      [true, false],
    ]);
  });

  it('total limit (diagnostic): cumulative time', () => {
    expect(scoreSeries(step(null, 31_000), answers).map((o) => o.success)).toEqual([true, false, false]);
    expect(scoreSeries(step(null, null), answers).map((o) => o.success)).toEqual([true, false, true]);
  });
});

describe('diagnosticResults', () => {
  it('fills each metric from its block; Gorbov needs all three runs completed', () => {
    const all = diagnosticResults([
      { module: 'pzmr', summary: summary({ medianRt: 301 }) },
      { module: 'szmr', summary: summary({ medianRt: 402 }) },
      { module: 'gonogo', summary: summary({ score: 57 / 60 }) },
      { module: 'rdo', summary: summary({ meanAbsErrorMs: 23.5 }) },
      { module: 'gorbov', run: 0, seconds: 30 },
      { module: 'gorbov', run: 1, seconds: 35 },
      { module: 'gorbov', run: 2, seconds: 70 },
      { module: 'numseries', correct: 14 },
    ]);
    expect(all).toEqual({
      pzmrMedianRt: 301,
      szmrMedianRt: 402,
      gonogoScore: (57 / 60) * 100,
      rdoMeanAbsErrorMs: 23.5,
      gorbov: gorbovMetrics(30, 35, 70),
      numseriesCorrect: 14,
    });
    expect(diagnosticResults([{ module: 'gorbov', run: 0, seconds: 30 }, { module: 'gorbov', run: 1, seconds: null }, { module: 'gorbov', run: 2, seconds: 70 }]).gorbov).toBeNull();
    expect(diagnosticResults([{ module: 'gorbov', run: 0, seconds: 30 }, { module: 'gorbov', run: 2, seconds: 70 }]).gorbov).toBeNull();
    expect(diagnosticResults([])).toEqual({
      pzmrMedianRt: null,
      szmrMedianRt: null,
      gonogoScore: null,
      rdoMeanAbsErrorMs: null,
      gorbov: null,
      numseriesCorrect: null,
    });
  });
});
