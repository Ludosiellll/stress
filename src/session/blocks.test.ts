import { describe, expect, it } from 'vitest';
import { diagnosticSegmentSeed, diagnosticSeriesSchedule, planDiagnostic } from '../engine/diagnostic';
import { R0, updateRating, type Rating } from '../engine/elo';
import { effectiveDifficulty } from '../engine/itemLimit';
import type { Segment } from '../engine/planner';
import type { Outcome, ReactionSummary } from '../engine/reaction/types';
import type { FamilyId } from '../engine/types';
import { createRng, deriveSeed } from '../engine/rng';
import { generateMemoryTrials } from '../modules/memory/generate';
import { memoryParams } from '../modules/memory/params';
import { generateItem, type TimedSeriesItem } from '../modules/numseries/generate';
import { NO_STRESSORS } from '../modules/reaction/common';
import { pomeh } from '../modules/reaction/pomeh';
import { pzmr } from '../modules/reaction/pzmr';
import { gorbovMetrics } from '../modules/tables/gorbov';
import { perfectPlayer, playTimeline } from '../testing/sessionPlayers';
import {
  blockInstruction,
  buildBlock,
  diagnosticBlockSeed,
  diagnosticResults,
  planBlock,
  scaledCount,
  scaledPractice,
  scoreReaction,
  scoreSeries,
  trainingBlockSeed,
  updatedRatings,
} from './blocks';
import { logicItemRows } from './rowsBuild';
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
      totalLimitMs: 600_000,
    });
    const noLimit: Segment = { module: 'numseries', budgetMs: 0, purpose: 'diagnostic', items: 20 };
    expect(planBlock(noLimit, 0, 0, { layout: 'keyboard', scale: 0.5, diagnostic: true })).toMatchObject({
      count: 10,
      totalLimitMs: null,
    });
  });

  it('memory: mode by block index, level params, 6 trials (3 under the e2e scale); keys and text per mode', () => {
    const segment: Segment = { module: 'memory', budgetMs: 300_000, purpose: 'free' };
    const ctx = { layout: 'pult' as const, scale: 1, diagnostic: false };
    const plan = planBlock(segment, 9, 2, ctx);
    expect(plan).toEqual({ kind: 'memory', L: 9, mode: 'card', params: memoryParams(9), count: 6 });
    expect(planBlock(segment, 9, 0, { ...ctx, scale: 0.02 })).toMatchObject({ mode: 'digits', count: 3 });
    expect(blockInstruction(plan, 'pult')).toEqual({
      text: 'На карточке 7 цифр. Запомни их по строкам, слева направо. Потом набери и нажми Enter.',
      keysHint: 'Цифры, Backspace, Enter',
    });
    expect(blockInstruction(planBlock(segment, 9, 1, ctx), 'pult').keysHint).toBe('Мышь, Enter');
    const { step, paramsJson } = buildBlock(plan, 42, 'pult', new Map());
    expect(step).toEqual({
      kind: 'memory_block',
      L: 9,
      mode: 'card',
      params: memoryParams(9),
      trials: generateMemoryTrials(memoryParams(9), 'card', 6, createRng(42)),
      protocol: 'fixed',
    });
    expect(JSON.parse(paramsJson)).toEqual({ mode: 'card', length: 7, itemMs: 630, gapMs: 158, trials: 6 });
  });
});

describe('reaction blocks', () => {
  const ctx = { layout: 'keyboard', scale: 1, diagnostic: false } as const;
  const free = (module: Segment['module']): Segment => ({ module, budgetMs: 300_000, purpose: 'free' });

  it('keys come from keyCount', () => {
    expect(planBlock(free('pzmr'), 30, 0, ctx)).toMatchObject({ kind: 'reaction', keys: ['Space'] });
    // СЗМР as before: 3 colours on 2 keys at L 8, 4 keys at L 16.
    expect(planBlock(free('szmr'), 8, 0, ctx)).toMatchObject({ keys: ['KeyF', 'KeyJ'] });
    expect(planBlock(free('szmr'), 16, 0, ctx)).toMatchObject({ keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'] });
    // Струп: one key per colour.
    expect(planBlock(free('stroop'), 0, 0, ctx)).toMatchObject({ keys: ['KeyF', 'KeyJ'], layout: 'keyboard', size: 20 });
    expect(planBlock(free('stroop'), 8, 0, ctx)).toMatchObject({ keys: ['KeyD', 'KeyF', 'KeyJ'] });
    expect(planBlock(free('stroop'), 8, 0, { ...ctx, layout: 'mouse' })).toMatchObject({
      keys: ['KeyD', 'KeyF', 'KeyJ'],
      layout: 'keyboard',
    });
  });

  it('reaction step carries the legend', () => {
    const build = (module: Segment['module'], L: number, layout: 'keyboard' | 'pult' = 'keyboard') =>
      buildBlock(planBlock(free(module), L, 0, { ...ctx, layout }), 1, layout, new Map()).step;
    expect(build('stroop', 0)).toMatchObject({ kind: 'reaction_block', legend: 'красный — F · зелёный — J' });
    expect(build('stroop', 0, 'pult')).toMatchObject({ legend: 'красный — ← · зелёный — →' });
    expect(build('stroop', 12)).toMatchObject({ legend: null });
    expect(build('szmr', 0)).toMatchObject({ legend: null });
  });

  it('reaction step carries the module stressors and a layers seed', () => {
    const build = (module: Segment['module'], L: number, seed: number) =>
      buildBlock(planBlock(free(module), L, 0, ctx), seed, 'keyboard', new Map()).step;
    expect(build('pomeh', 18, 7)).toMatchObject({
      kind: 'reaction_block',
      layers: {
        noise: pomeh.params(18).noise,
        audio: { layers: ['hum'], gain: 0.5 },
        gate: 'noisy',
        seed: deriveSeed(7, 'layers'),
      },
    });
    expect(build('pomeh', 0, 7)).toMatchObject({ layers: { audio: null, gate: 'noisy' } });
    expect(build('pzmr', 0, 7)).toMatchObject({ layers: { ...NO_STRESSORS, seed: deriveSeed(7, 'layers') } });
    // The noise is visual only on noisy trials: the block has both kinds.
    const step = build('pomeh', 18, 7);
    if (step.kind !== 'reaction_block') throw new Error('expected a reaction block');
    expect(new Set(step.specs.map((t) => t.cond))).toEqual(new Set(['quiet', 'noisy']));
  });

  it('scoreReaction adds the per-condition statistics', () => {
    const { step } = buildBlock(planBlock(free('stroop'), 8, 0, ctx), 3, 'keyboard', new Map());
    if (step.kind !== 'reaction_block') throw new Error('expected a reaction block');
    const scored = scoreReaction(step.specs, playTimeline(step.specs, perfectPlayer));
    expect(scored?.conditions).toEqual({
      incongruent: { n: 13, errors: 0, medianRt: 300 },
      congruent: { n: 7, errors: 0, medianRt: 300 },
    });
    const pz = pzmr.generateBlock(pzmr.params(0), createRng(1), 'keyboard', 3);
    expect(scoreReaction(pz, playTimeline(pz, perfectPlayer))?.conditions).toEqual({});
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

  it('hit RTs leave out trials with a dropped onset frame, like the summary RT statistics', () => {
    const specs = pzmr.generateBlock(pzmr.params(0), createRng(1), 'keyboard', 3);
    const tl = playTimeline(specs, (_spec, i) => ({ key: 'Space', rtMs: 250 + i }));
    const scored = scoreReaction(specs, { ...tl, droppedOnset: [false, true, false] });
    expect(scored?.hitRts).toEqual([250, 252]);
  });
});

describe('number series', () => {
  const seriesItem = (i: number, timeLimitMs: number | null, difficulty = 800): TimedSeriesItem => ({
    id: `arith:${String(i)}`,
    family: 'arith',
    seed: i,
    shown: [1, 2, 3],
    answer: 4,
    difficulty,
    timeLimitMs,
  });
  const step = (limits: Array<number | null>, totalLimitMs: number | null): StepOf<'numseries_block'> => ({
    kind: 'numseries_block',
    items: limits.map((limit, i) => seriesItem(i + 1, limit)),
    totalLimitMs,
  });
  const answers = [
    { itemId: 'arith:1', given: 4, timeMs: 30_000 },
    { itemId: 'arith:2', given: 5, timeMs: 1000 },
    { itemId: 'arith:3', given: 4, timeMs: 41_000 },
  ];

  it('per-item limit (training)', () => {
    expect(scoreSeries(step([40_000, 40_000, 40_000], null), answers).map((o) => [o.correct, o.success])).toEqual([
      [true, true],
      [false, false],
      [true, false],
    ]);
  });

  it('scoreSeries uses each item\'s limit', () => {
    const outcomes = scoreSeries(step([11_900, 40_000], null), [
      { itemId: 'arith:1', given: 4, timeMs: 12_000 },
      { itemId: 'arith:2', given: 4, timeMs: 12_000 },
    ]);
    expect(outcomes.map((o) => [o.correct, o.success])).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it('total limit (diagnostic): cumulative time', () => {
    expect(scoreSeries(step([null, null, null], 31_000), answers).map((o) => o.success)).toEqual([true, false, false]);
    expect(scoreSeries(step([null, null, null], null), answers).map((o) => o.success)).toEqual([true, false, true]);
  });

  it('updatedRatings uses the effective difficulty', () => {
    const start = new Map<FamilyId, Rating>([['arith', { rating: 1400, n: 30 }]]);
    const s: StepOf<'numseries_block'> = { kind: 'numseries_block', items: [seriesItem(1, 11_900, 950), seriesItem(2, 40_000, 900)], totalLimitMs: null };
    const outcomes = scoreSeries(s, [
      { itemId: 'arith:1', given: 4, timeMs: 11_000 },
      { itemId: 'arith:2', given: 4, timeMs: 20_000 },
    ]);
    const first = updateRating({ rating: 1400, n: 30 }, effectiveDifficulty(950, 11_900), true);
    expect(updatedRatings(start, outcomes).get('arith')).toEqual(updateRating(first, 900, true));
    expect(updatedRatings(new Map(), outcomes.slice(1)).get('arith')).toEqual(updateRating({ rating: R0, n: 0 }, 900, true));
  });

  it('logicItemRows store timeLimitMs', () => {
    const outcomes = scoreSeries(step([11_900, null], null), [
      { itemId: 'arith:1', given: 4, timeMs: 5000 },
      { itemId: 'arith:2', given: null, timeMs: 7000 },
    ]);
    const rows = logicItemRows('b1', outcomes, '2026-10-14T10:00:00.000Z');
    expect(rows.map((r) => [r.timeLimitMs, r.timeMs, r.given])).toEqual([
      [11_900, 5000, 4],
      [null, 7000, null],
    ]);
  });

  it('diagnostic items have no per-item limit', () => {
    const segment = planDiagnostic(1).segments[5] as Segment;
    const plan = planBlock(segment, 0, 0, { layout: 'keyboard', scale: 1, diagnostic: true });
    const seed = diagnosticBlockSeed(1, 'numseries', 0, 0);
    const { step: built, paramsJson } = buildBlock(plan, seed, 'keyboard', new Map());
    if (built.kind !== 'numseries_block') throw new Error(built.kind);
    const schedule = diagnosticSeriesSchedule();
    expect(built.items).toEqual(
      schedule.map((e, i) => ({ ...generateItem(e.family, e.targetD, deriveSeed(seed, 'item:' + String(i))), timeLimitMs: null })),
    );
    expect(built.totalLimitMs).toBe(600_000);
    expect(JSON.parse(paramsJson)).toEqual({ items: 20, itemLimitsMs: Array<null>(20).fill(null), totalLimitMs: 600_000 });
    // The total limit applies as in W1: a slow answer is still a success while the block time lasts.
    const slow = built.items.map((it) => ({ itemId: it.id, given: it.answer, timeMs: 50_000 }));
    expect(scoreSeries(built, slow).map((o) => o.success)).toEqual(built.items.map((_, i) => (i + 1) * 50_000 <= 600_000));
  });

  it('training blocks store each item\'s limit in paramsJson', () => {
    const plan = planBlock({ module: 'numseries', budgetMs: 0, purpose: 'logic' }, 0, 0, { layout: 'keyboard', scale: 1, diagnostic: false });
    const ratings = new Map<FamilyId, Rating>([['arith', { rating: 1900, n: 50 }]]);
    const { step: built, paramsJson } = buildBlock(plan, 9, 'keyboard', ratings);
    if (built.kind !== 'numseries_block') throw new Error(built.kind);
    expect(built.totalLimitMs).toBeNull();
    expect(JSON.parse(paramsJson)).toEqual({ items: 10, itemLimitsMs: built.items.map((it) => it.timeLimitMs), totalLimitMs: null });
    expect(built.items.every((it) => it.timeLimitMs !== null)).toBe(true);
  });
});

describe('diagnosticResults', () => {
  it('lists the reaction modules whose stored block was timingUnreliable, keeping their values (I1)', () => {
    const r = diagnosticResults([
      { module: 'pzmr', summary: summary({ medianRt: 301, timingUnreliable: true }) },
      { module: 'szmr', summary: summary({ medianRt: 402 }) },
      { module: 'rdo', summary: summary({ meanAbsErrorMs: 20, timingUnreliable: true }) },
      { module: 'gorbov', run: 0, seconds: 30 },
    ]);
    expect(r.unreliable).toEqual(['pzmr', 'rdo']);
    expect(r.pzmrMedianRt).toBe(301);
    expect(r.rdoMeanAbsErrorMs).toBe(20);
  });

  it('fills each metric from its block; Gorbov needs all three runs completed', () => {
    const all = diagnosticResults([
      { module: 'pzmr', summary: summary({ medianRt: 301 }) },
      { module: 'szmr', summary: summary({ medianRt: 402 }) },
      { module: 'gonogo', summary: summary({ score: 57 / 60 }) },
      { module: 'rdo', summary: summary({ meanAbsErrorMs: 23.5 }) },
      { module: 'gorbov', run: 0, seconds: 30 },
      { module: 'gorbov', run: 1, seconds: 35 },
      { module: 'gorbov', run: 2, seconds: 70 },
      { module: 'numseries', correct: 14, total: 20 },
    ]);
    expect(all).toEqual({
      pzmrMedianRt: 301,
      szmrMedianRt: 402,
      gonogoScore: (57 / 60) * 100,
      rdoMeanAbsErrorMs: 23.5,
      gorbov: gorbovMetrics(30, 35, 70),
      numseriesCorrect: 14,
      unreliable: [],
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
      unreliable: [],
    });
  });
});
