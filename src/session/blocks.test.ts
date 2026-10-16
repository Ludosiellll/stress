import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { deriveRatings } from '../engine/derive';
import { DIAGNOSTIC_VOLUME, EMPTY_METRICS, EMPTY_RESULTS, diagnosticSegmentSeed, diagnosticSeriesSchedule, planDiagnostic } from '../engine/diagnostic';
import { R0, updateRating, type Rating } from '../engine/elo';
import { block, session } from '../data/repository.contract';
import { effectiveDifficulty } from '../engine/itemLimit';
import { FINISHER_AUDIO } from '../engine/audio/stressors';
import { noiseFrame } from '../engine/noise';
import { OVERLOAD_LEVEL_STEP, TEST_FORMAT_ORDER, type Segment, type TestFormatId } from '../engine/planner';
import { MIN_COND_RTS, condPairOf, type CondPair } from '../engine/reaction/conditions';
import type { Outcome, ReactionSummary, Stimulus, TrialSpec } from '../engine/reaction/types';
import { BAND_MODULES, REACTION_MODULE_IDS, isReactionModule, type FamilyId, type ModuleId, type ReactionModuleId } from '../engine/types';
import { createRng, deriveSeed } from '../engine/rng';
import { sdTrimmed } from '../engine/stats';
import { generateMemoryTrials, SPAN_PROTOCOL_PARAMS, spanProtocolTrials } from '../modules/memory/generate';
import { memoryModeForBlock, memoryParams } from '../modules/memory/params';
import { FAMILIES } from '../modules/numseries/families';
import { generateItem, type TimedSeriesItem } from '../modules/numseries/generate';
import { NO_STRESSORS, bandIndex } from '../modules/reaction/common';
import { DIAGNOSTIC_PARAMS } from '../modules/reaction/diagnosticParams';
import { gonogo, isSwappedSegment } from '../modules/reaction/gonogo';
import { pomeh } from '../modules/reaction/pomeh';
import { pzmr } from '../modules/reaction/pzmr';
import { rdo } from '../modules/reaction/rdo';
import { szmr } from '../modules/reaction/szmr';
import { bandModules, reactionModules } from '../modules/registry';
import { gorbovMetrics } from '../modules/tables/gorbov';
import { perfectPlayer, playTimeline } from '../testing/sessionPlayers';
import {
  blockInstruction,
  buildBlock,
  diagnosticBlockSeed,
  diagnosticResults,
  E2E_COND_MARGIN,
  e2eCondFloor,
  FEEDBACK_MODULES,
  floorsFrom,
  isOverloadBlock,
  planBlock,
  scaledCount,
  scaledPractice,
  scoreReaction,
  scoreSeries,
  trainingBlockSeed,
  updatedRatings,
  type BlockPlan,
  type PlanContext,
  type WindowFloors,
} from './blocks';
import { appendPast, pastBlocks } from './pastBlocks';
import { logicItemRows } from './rowsBuild';
import { MEMORY_SPAN_INSTRUCTION, OVERLOAD_PREFIX, OVERLOAD_SOUND_PREFIX, overloadBandPrefix, type StepOf } from './steps';
import { testFormatInstruction } from './testFormat';

const counts: Record<Outcome, number> = { hit: 0, wrong: 0, miss: 0, late: 0, false_start: 0, commission: 0, correct_reject: 0, early: 0, timing_late: 0 };
/** penalizedScore differs from score: the diagnostic reads the share of successes, never the penalised s (F1). */
const summary = (over: Partial<ReactionSummary>): ReactionSummary => ({
  n: 10,
  score: 0.9,
  penalizedScore: 0.7,
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

/** A plan seed and segment index whose Go/No-Go colours are swapped (F8), or are not; no window floors (F3), no marks (F15). */
function segmentWhere(swapped: boolean): Pick<PlanContext, 'planSeed' | 'segmentIndex' | 'floors' | 'feedback'> {
  for (let planSeed = 1; planSeed <= 100; planSeed++) {
    if (isSwappedSegment(planSeed, 2) === swapped) return { planSeed, segmentIndex: 2, floors: null, feedback: 'none' };
  }
  throw new Error('no such plan seed');
}
const SWAPPING = segmentWhere(true);
const PLAIN = segmentWhere(false);

/** The reaction modules with trial conditions (COND_PAIRS). */
const CONDITION_MODULES: readonly ReactionModuleId[] = ['stroop', 'pomeh', 'taskswitch'];

const freeSegment = (module: ReactionModuleId): Segment => ({ module, budgetMs: 300_000, purpose: 'free' });
/** The segment of a test-format run of `module` (F4), as planTraining makes it. */
const runSegment = (module: TestFormatId): Segment => ({
  module,
  budgetMs: 0,
  purpose: 'test_format',
  trialCount: DIAGNOSTIC_VOLUME[module].trialCount,
  practiceTrials: 5,
});

/** The first block of `seg` at level L, which must be a reaction block. */
function reactionPlan(seg: Segment, L: number, ctx: PlanContext): Extract<BlockPlan, { kind: 'reaction' }> {
  const plan = planBlock(seg, L, 0, ctx);
  if (plan.kind !== 'reaction') throw new Error('expected a reaction plan');
  return plan;
}

describe('scale', () => {
  it('block sizes and item counts: max(3, round(n·scale))', () => {
    expect([scaledCount(15, 1), scaledCount(15, 0.02), scaledCount(50, 0.1), scaledCount(10, 2)]).toEqual([15, 3, 5, 20]);
  });

  it('scaledCount takes another floor: max(min, round(n·scale))', () => {
    expect([scaledCount(40, 0.02, 12), scaledCount(48, 0.5, 12), scaledCount(20, 1, 12), scaledCount(20, 0.02, 3)]).toEqual([12, 24, 20, 3]);
  });

  it('under the e2e scale pomeh, stroop and taskswitch blocks hold MIN_COND_RTS + 2 trials per condition; the others 3', () => {
    const ctx = { layout: 'keyboard', scale: 0.02, diagnostic: true, ...PLAIN } as const;
    const sizes = planDiagnostic(1).segments.flatMap((seg) => {
      const plan = planBlock(seg, seg.fixedL ?? 0, 0, ctx);
      return plan.kind === 'reaction' ? [[plan.module, plan.L, plan.size, plan.practice]] : [];
    });
    // pomeh: runs of 5 and 3 leave the other condition 5 trials at 15; stroop L 8 (0.66): 5 congruent at 14;
    // taskswitch L 5 (0.3): round(0.3·15) = 5 switches at 16.
    expect(sizes).toEqual([
      ['pzmr', 0, 3, 1],
      ['szmr', 0, 3, 1],
      ['gonogo', 10, 3, 1],
      ['rdo', 0, 3, 1],
      ['pomeh', 8, 15, 1],
      ['stroop', 8, 14, 1],
      ['taskswitch', 5, 16, 1],
    ]);
    // A free (or first training) block at L 0; never below 12. taskswitch at 0.2 needs 24 for 5 switches.
    const freeCtx = { ...ctx, diagnostic: false };
    expect(CONDITION_MODULES.map((m) => reactionPlan(freeSegment(m), 0, freeCtx).size)).toEqual([12, 15, 24]);
  });

  it('pins the margin (W2-R30): at the levels e2e plays, every condition of every seed keeps MIN_COND_RTS + 2 trials', () => {
    expect(E2E_COND_MARGIN).toBe(2);
    const need = MIN_COND_RTS + E2E_COND_MARGIN;
    const ctx = { layout: 'keyboard', scale: 0.02, diagnostic: true, ...PLAIN } as const;
    // The diagnostic plays each at its fixedL; free training (and a new module's first training) plays L 0.
    const diag = planDiagnostic(1)
      .segments.filter((seg) => CONDITION_MODULES.includes(seg.module as ReactionModuleId))
      .map((seg) => reactionPlan(seg, seg.fixedL ?? 0, ctx));
    const free = CONDITION_MODULES.map((m) => reactionPlan(freeSegment(m), 0, { ...ctx, diagnostic: false }));
    expect(diag.map((p) => [p.module, p.L])).toEqual([
      ['pomeh', 8],
      ['stroop', 8],
      ['taskswitch', 5],
    ]);
    for (const plan of [...diag, ...free]) {
      const pair = condPairOf(plan.module) as CondPair;
      for (let seed = 0; seed < 300; seed++) {
        const { step } = buildBlock(plan, seed, 'keyboard', new Map());
        if (step.kind !== 'reaction_block') throw new Error('expected a reaction block');
        const counted = step.specs.filter((t) => t.practice !== true);
        for (const cond of [pair.slow, pair.fast]) {
          expect(counted.filter((t) => t.cond === cond).length, `${plan.module} L ${String(plan.L)} ${cond}, seed ${String(seed)}`).toBeGreaterThanOrEqual(need);
        }
      }
    }
  });

  it('the e2e floor holds at every level 0–60, and scale 1 keeps the planned sizes', () => {
    const need = MIN_COND_RTS + E2E_COND_MARGIN;
    for (const module of CONDITION_MODULES) {
      const mod = reactionModules[module];
      const diagSeg = planDiagnostic(1).segments.find((s) => s.module === module) as Segment;
      for (let L = 0; L <= 60; L++) {
        for (const seg of [diagSeg, freeSegment(module)]) {
          const diagnostic = seg.purpose === 'diagnostic';
          const e2e = reactionPlan(seg, L, { layout: 'keyboard', scale: 0.02, diagnostic, ...PLAIN });
          expect(mod.minCondTrials?.(e2e.params, e2e.size), `${module} L ${String(L)}`).toBeGreaterThanOrEqual(need);
          const real = reactionPlan(seg, L, { layout: 'keyboard', scale: 1, diagnostic, ...PLAIN });
          expect(real.size, `${module} L ${String(L)}`).toBe(seg.trialCount ?? mod.trials(real.params));
        }
      }
    }
  });

  it('a real block never starves a condition: MIN_COND_RTS trials each at every level, on its band and the next (T-R18)', () => {
    for (const module of CONDITION_MODULES) {
      const mod = reactionModules[module];
      for (let L = 0; L <= 80; L += 0.5) {
        const band = bandIndex(mod, L);
        for (const loadBand of [band, band + 1]) {
          const p = mod.params(L, loadBand);
          const fewest = mod.minCondTrials?.(p, mod.trials(p)) ?? 0;
          expect(fewest, `${module} L ${String(L)}, band ${String(loadBand)}`).toBeGreaterThanOrEqual(MIN_COND_RTS);
        }
      }
    }
    // The tightest: Струп with the reverse rule, 20 trials, at most 12 of them framed.
    expect(reactionModules.stroop.minCondTrials?.(reactionModules.stroop.params(16), 20)).toBe(MIN_COND_RTS);
  });

  it('the block size is the trials of its band: 30, 45 and 60 in the long bands', () => {
    const ctx = { layout: 'keyboard', scale: 1, diagnostic: false, ...PLAIN } as const;
    expect([0, 24, 28, 32, 60].map((L) => reactionPlan(freeSegment('pzmr'), L, ctx).size)).toEqual([15, 30, 45, 60, 60]);
    expect([0, 40, 44, 48].map((L) => reactionPlan(freeSegment('szmr'), L, ctx).size)).toEqual([20, 30, 45, 60]);
    expect(reactionPlan({ ...freeSegment('pzmr'), trialCount: 50 }, 32, ctx).size).toBe(50);
    expect(reactionPlan(freeSegment('rdo'), 40, ctx).size).toBe(10);
  });

  it('the modules with trial conditions are exactly the ones that report their fewest trials per condition', () => {
    expect(REACTION_MODULE_IDS.filter((m) => condPairOf(m) !== null).sort()).toEqual([...CONDITION_MODULES].sort());
    for (const m of REACTION_MODULE_IDS) expect(reactionModules[m].minCondTrials !== undefined, m).toBe(condPairOf(m) !== null);
  });

  it('e2eCondFloor refuses a module whose conditions never reach the margin', () => {
    const lopsided = { ...reactionModules.stroop, minCondTrials: () => 0 };
    expect(() => e2eCondFloor(lopsided, reactionModules.stroop.params(0))).toThrow(RangeError);
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
    expect(planBlock({ ...segment, items: 50 }, 0, 0, { layout: 'keyboard', scale: 1, diagnostic: true, ...PLAIN })).toEqual({
      kind: 'numseries',
      diagnostic: true,
      count: 20,
      totalLimitMs: 600_000,
    });
    const noLimit: Segment = { module: 'numseries', budgetMs: 0, purpose: 'diagnostic', items: 20 };
    expect(planBlock(noLimit, 0, 0, { layout: 'keyboard', scale: 0.5, diagnostic: true, ...PLAIN })).toMatchObject({
      count: 10,
      totalLimitMs: null,
    });
  });

  it('memory: mode by block index, level params, 6 trials (3 under the e2e scale); keys and text per mode', () => {
    const segment: Segment = { module: 'memory', budgetMs: 300_000, purpose: 'free' };
    const ctx = { layout: 'pult' as const, scale: 1, diagnostic: false, ...PLAIN };
    const plan = planBlock(segment, 9, 2, ctx);
    expect(plan).toEqual({ kind: 'memory', protocol: 'fixed', L: 9, mode: 'card', params: memoryParams(9), count: 6, overload: false });
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

  it('diagnostic memory: the span protocol, digits at 1000 / 250 ms, the first scaledCount(20) trials', () => {
    const segment = planDiagnostic(1).segments[9] as Segment;
    expect(segment.module).toBe('memory');
    const ctx = { layout: 'keyboard' as const, scale: 1, diagnostic: true, ...PLAIN };
    const plan = planBlock(segment, 0, 0, ctx);
    expect(plan).toEqual({
      kind: 'memory',
      protocol: 'span',
      L: 0,
      mode: 'digits',
      params: { length: 3, itemMs: 1000, gapMs: 250 },
      count: 20,
      overload: false,
    });
    expect(planBlock(segment, 0, 0, { ...ctx, scale: 0.02 })).toMatchObject({ protocol: 'span', count: 3 });
    expect(blockInstruction(plan, 'keyboard')).toEqual({ text: MEMORY_SPAN_INSTRUCTION, keysHint: 'Цифры, Backspace, Enter' });
    const { step, paramsJson } = buildBlock(plan, 42, 'keyboard', new Map());
    expect(step).toEqual({
      kind: 'memory_block',
      L: 0,
      mode: 'digits',
      params: { length: 3, itemMs: 1000, gapMs: 250 },
      trials: spanProtocolTrials(createRng(42)),
      protocol: 'span',
    });
    expect(JSON.parse(paramsJson)).toEqual({ protocol: 'span', mode: 'digits', length: 3, itemMs: 1000, gapMs: 250, trials: 20 });
    const short = buildBlock(planBlock(segment, 0, 0, { ...ctx, scale: 0.02 }), 42, 'keyboard', new Map()).step as StepOf<'memory_block'>;
    expect(short.trials).toEqual(spanProtocolTrials(createRng(42)).slice(0, 3));
  });
});

describe('diagnostic reaction blocks', () => {
  // A plan rate of marks never reaches a diagnostic (F15): the snapshots below hold with 'every'.
  const ctx = { layout: 'keyboard', scale: 1, diagnostic: true, ...SWAPPING, feedback: 'every' } as const;
  /** Plan and step of block 0, attempt 0 of every reaction segment of diagnostic n. */
  const diagnosticBlocks = (n: number) =>
    planDiagnostic(n).segments.flatMap((seg) => {
      if (!isReactionModule(seg.module)) return [];
      const plan = planBlock(seg, seg.fixedL ?? 0, 0, ctx);
      const { step } = buildBlock(plan, diagnosticBlockSeed(n, seg.module, 0, 0), 'keyboard', new Map());
      if (step.kind !== 'reaction_block') throw new Error('expected a reaction block');
      return [{ plan, step }];
    });
  const diagnosticSteps = (n: number) => diagnosticBlocks(n).map((b) => b.step);
  /** The diagnostic segment of `module` (diagnostic 1; the segments of every diagnostic are the same). */
  const diagnosticSegment = (module: ModuleId): Segment => {
    const seg = planDiagnostic(1).segments.find((s) => s.module === module);
    if (seg === undefined) throw new Error(`expected a ${module} segment`);
    return seg;
  };

  it('diagnostic reaction blocks are those of 0.2.0', () => {
    for (const n of [1, 2, 3]) {
      for (const { module, specs, layers } of diagnosticSteps(n)) {
        // The layer fields are listed one by one: a new field (noiseGate, …) must not change the snapshot.
        expect({ specs, noise: layers.noise, audio: layers.audio, gate: layers.gate }).toMatchSnapshot(`${String(n)} ${module}`);
      }
    }
  });

  it('diagnostic keys, legends and instructions are those of 0.2.0', () => {
    // The key mapping and the layout of the day (F9) must not reach a diagnostic: every diagnostic is pinned, as its
    // plan seed differs.
    for (const n of [1, 2, 3]) {
      for (const { plan, step } of diagnosticBlocks(n)) {
        const { keys, layout, legend, L } = step;
        expect({ keys, layout, legend, L, instruction: blockInstruction(plan, 'keyboard') }).toMatchSnapshot(`${String(n)} ${step.module} keys`);
      }
    }
  });

  it('the span protocol and the Горбов runs of the diagnostic keep their 0.2.0 parameters', () => {
    expect(SPAN_PROTOCOL_PARAMS).toMatchSnapshot('span protocol params');
    expect(planBlock(diagnosticSegment('memory'), 0, 0, ctx)).toMatchSnapshot('memory plan');
    const gorbov = diagnosticSegment('gorbov');
    for (const run of [0, 1, 2]) {
      expect(planBlock(gorbov, gorbov.fixedL ?? 0, run, ctx)).toMatchSnapshot(`gorbov run ${String(run)}`);
    }
  });

  it('a diagnostic block takes DIAGNOSTIC_PARAMS, never params(fixedL)', () => {
    const spy = vi.spyOn(reactionModules.gonogo, 'params');
    try {
      const seg = planDiagnostic(1).segments.find((s) => s.module === 'gonogo') as Segment;
      expect(planBlock(seg, seg.fixedL ?? 0, 0, ctx)).toMatchObject({ kind: 'reaction', L: 10, params: DIAGNOSTIC_PARAMS.gonogo });
      expect(spy).not.toHaveBeenCalled();
      planBlock(freeSegment('gonogo'), 7, 0, { ...ctx, ...PLAIN, diagnostic: false });
      expect(spy).toHaveBeenCalledWith(7, 1);
    } finally {
      spy.mockRestore();
    }
  });

  it('a swapped segment plays swapped colours in training and free, never in a diagnostic', () => {
    const goOf = (plan: BlockPlan): Stimulus => {
      const { step } = buildBlock(plan, 9, 'keyboard', new Map());
      if (step.kind !== 'reaction_block') throw new Error('expected a reaction block');
      return (step.specs.find((t) => t.expected.kind === 'press') as TrialSpec).stimulus;
    };
    const green: Stimulus = { kind: 'shape', shape: 'circle', color: 'green' };
    const training: Segment = { module: 'gonogo', budgetMs: 360_000, purpose: 'reaction' };
    for (const seg of [training, freeSegment('gonogo')]) {
      const swapped = reactionPlan(seg, 12, { ...ctx, ...SWAPPING, diagnostic: false });
      expect(swapped.params).toEqual({ ...gonogo.params(12), swapped: true });
      expect(goOf(swapped)).toEqual(green);
      expect(reactionPlan(seg, 12, { ...ctx, ...PLAIN, diagnostic: false }).params).toEqual(gonogo.params(12));
    }
    // ctx has the swapping plan seed and segment: the diagnostic keeps its colours (the snapshots above too).
    const diag = reactionPlan(diagnosticSegment('gonogo'), 10, ctx);
    expect(diag.params).toBe(DIAGNOSTIC_PARAMS.gonogo);
    expect(goOf(diag)).toEqual({ kind: 'shape', shape: 'circle', color: 'red' });
  });

  it('the distractors of the diagnostic Помехоустойчивость are those of 0.2.0', () => {
    const box = { halfW: 16 / 9 / 2, halfH: 0.5 };
    for (const n of [1, 2, 3]) {
      const step = diagnosticSteps(n).find((s) => s.module === 'pomeh');
      if (step === undefined) throw new Error('expected a pomeh block');
      for (const t of [0, 610, 1220]) {
        expect(noiseFrame(DIAGNOSTIC_PARAMS.pomeh.noise, step.layers.seed, t, box)).toMatchSnapshot(`${String(n)} pomeh noise ${String(t)} ms`);
      }
    }
  });
});

describe('reaction blocks', () => {
  const ctx = { layout: 'keyboard', scale: 1, diagnostic: false, ...PLAIN } as const;
  const free = (module: Segment['module']): Segment => ({ module, budgetMs: 300_000, purpose: 'free' });

  it('keys come from keyCount', () => {
    expect(planBlock(free('pzmr'), 30, 0, ctx)).toMatchObject({ kind: 'reaction', keys: ['Space'] });
    // СЗМР: 3 colours on 2 keys at L 8, 4 keys at L 12 (F3).
    expect(planBlock(free('szmr'), 8, 0, ctx)).toMatchObject({ keys: ['KeyF', 'KeyJ'] });
    expect(planBlock(free('szmr'), 12, 0, ctx)).toMatchObject({ keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'] });
    // Струп: one key per colour.
    expect(planBlock(free('stroop'), 0, 0, ctx)).toMatchObject({ keys: ['KeyF', 'KeyJ'], layout: 'keyboard', size: 20 });
    expect(planBlock(free('stroop'), 4, 0, ctx)).toMatchObject({ keys: ['KeyD', 'KeyF', 'KeyJ'] });
    expect(planBlock(free('stroop'), 4, 0, { ...ctx, layout: 'mouse' })).toMatchObject({
      keys: ['KeyD', 'KeyF', 'KeyJ'],
      layout: 'keyboard',
    });
  });

  it('reaction step carries the legend', () => {
    const build = (module: Segment['module'], L: number, layout: 'keyboard' | 'pult' = 'keyboard') =>
      buildBlock(planBlock(free(module), L, 0, { ...ctx, layout }), 1, layout, new Map()).step;
    expect(build('stroop', 0)).toMatchObject({ kind: 'reaction_block', legend: 'красный — F · зелёный — J' });
    expect(build('stroop', 0, 'pult')).toMatchObject({ legend: 'красный — ← · зелёный — →' });
    expect(build('stroop', 8)).toMatchObject({ legend: null });
    expect(build('szmr', 0)).toMatchObject({ legend: null });
  });

  it('reaction step carries the module stressors and a layers seed', () => {
    const build = (module: Segment['module'], L: number, seed: number) =>
      buildBlock(planBlock(free(module), L, 0, ctx), seed, 'keyboard', new Map()).step;
    expect(build('pomeh', 8, 7)).toMatchObject({
      kind: 'reaction_block',
      layers: {
        noise: pomeh.params(8).noise,
        audio: { layers: ['hum'], gain: 0.5 },
        gate: 'noisy',
        noiseGate: 'noisy',
        seed: deriveSeed(7, 'layers'),
      },
    });
    expect(build('pomeh', 0, 7)).toMatchObject({ layers: { audio: null, gate: 'noisy', noiseGate: 'noisy' } });
    expect(build('rdo', 0, 7)).toMatchObject({ layers: { ...NO_STRESSORS, seed: deriveSeed(7, 'layers') } });
    expect(build('pzmr', 0, 7)).toMatchObject({ layers: { noise: null, audio: null, seed: deriveSeed(7, 'layers') } });
    // ПЗМР from band 3: the far figures on every trial (noiseGate all, F3).
    expect(build('pzmr', 16, 7)).toMatchObject({
      layers: { noise: pzmr.params(16).noise, audio: { layers: ['hum', 'beeps'], gain: 0.6 }, gate: 'all', noiseGate: 'all' },
    });
    // The noise is visual only on noisy trials: the block has both kinds.
    const step = build('pomeh', 8, 7);
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

describe('overload blocks', () => {
  const ctx = { layout: 'keyboard', scale: 1, diagnostic: false, ...PLAIN } as const;
  const seg = (module: Segment['module'], overload?: 'finisher' | 'mix'): Segment => ({
    module,
    budgetMs: 300_000,
    purpose: overload === 'finisher' ? 'finisher' : 'reaction',
    ...(overload === undefined ? {} : { overload }),
  });

  it('isOverloadBlock: every finisher block, the odd blocks of a mix, nothing else', () => {
    expect([0, 1, 2, 3].map((i) => isOverloadBlock(seg('szmr', 'finisher'), i))).toEqual([true, true, true, true]);
    expect([0, 1, 2, 3].map((i) => isOverloadBlock(seg('szmr', 'mix'), i))).toEqual([false, true, false, true]);
    expect([0, 1, 2, 3].map((i) => isOverloadBlock(seg('szmr'), i))).toEqual([false, false, false, false]);
  });

  it('РДО, tables and memory still overload at L + 3; a finisher plays at the level it is given', () => {
    expect(OVERLOAD_LEVEL_STEP).toBe(3);
    expect(planBlock(seg('rdo', 'mix'), 10, 0, ctx)).toMatchObject({ kind: 'reaction', L: 10, overload: false, load: null });
    expect(planBlock(seg('rdo', 'mix'), 10, 1, ctx)).toEqual({ ...planBlock(seg('rdo'), 13, 1, ctx), overload: true });
    expect(planBlock(seg('rdo', 'mix'), 10, 1, ctx)).toMatchObject({ params: rdo.params(13), load: null });
    expect(planBlock(seg('rdo', 'finisher'), 13, 0, ctx)).toMatchObject({ L: 13, overload: true, load: null });
    expect(planBlock(seg('rdo'), 10, 1, ctx)).toMatchObject({ L: 10, overload: false });
    expect(planBlock(seg('schulte', 'mix'), 4, 1, ctx)).toMatchObject({ kind: 'table', L: 7, overload: true });
    expect(planBlock(seg('gorbov', 'mix'), 4, 1, ctx)).toMatchObject({ kind: 'table', L: 7, task: 'red_down', overload: true });
    expect(planBlock(seg('memory', 'mix'), 9, 1, ctx)).toMatchObject({ kind: 'memory', L: 12, mode: memoryModeForBlock(0), overload: true });
    expect(planBlock(seg('memory', 'mix'), 9, 2, ctx)).toMatchObject({ kind: 'memory', L: 9, overload: false });
  });

  it('a memory mix gives every mode a normal and an overload block (W2-R27); other segments cycle by block index', () => {
    const modes = (overload: 'finisher' | 'mix' | undefined) =>
      Array.from({ length: 8 }, (_, i) => planBlock(seg('memory', overload), 9, i, ctx)).map((p) =>
        p.kind === 'memory' ? `${p.mode}${p.overload ? '+3' : ''}` : p.kind,
      );
    expect(modes('mix')).toEqual(['digits', 'digits+3', 'positions', 'positions+3', 'card', 'card+3', 'letters', 'letters+3']);
    const cycle = ['digits', 'positions', 'card', 'letters', 'digits', 'positions', 'card', 'letters'];
    expect(modes(undefined)).toEqual(cycle);
    expect(modes('finisher')).toEqual(cycle.map((m) => m + '+3'));
  });

  it('an overload reaction block adds the finisher sound for every trial; the noise keeps its own trials (W2-R10)', () => {
    const build = (module: Segment['module'], L: number, overload?: 'finisher' | 'mix') =>
      buildBlock(planBlock(seg(module, overload), L, 0, ctx), 7, 'keyboard', new Map()).step;
    expect(build('pzmr', 5, 'finisher')).toMatchObject({
      layers: { noise: null, audio: FINISHER_AUDIO, gate: 'all', seed: deriveSeed(7, 'layers') },
    });
    // The load of the next band (band 5 at L 18: hum, beeps and metronome at 0.75) with the finisher sound.
    const pomehStep = build('pomeh', 18, 'finisher');
    expect(pomeh.params(18, 5).audio).toEqual({ layers: ['hum', 'beeps', 'metronome'], gain: 0.75 });
    expect(pomehStep).toMatchObject({
      layers: {
        noise: pomeh.params(18, 5).noise,
        audio: { layers: ['hum', 'beeps', 'metronome', 'babble'], gain: 0.8 },
        gate: 'all',
        noiseGate: 'noisy',
      },
    });
    // A band module's noise keeps its every-trial gate; ПЗМР at L 12 plays band 4, the far figures and its own sound.
    expect(build('pzmr', 12, 'finisher')).toMatchObject({
      layers: { noise: pzmr.params(12, 4).noise, audio: { layers: ['hum', 'beeps', 'babble'], gain: 0.8 }, noiseGate: 'all' },
    });
    if (pomehStep.kind !== 'reaction_block') throw new Error('expected a reaction block');
    // Quiet trials stay visually quiet: the trial conditions do not change (band 5 adds only the metronome).
    const normal = build('pomeh', 18);
    if (normal.kind !== 'reaction_block') throw new Error('expected a reaction block');
    expect(pomehStep.specs).toEqual(normal.specs);
    expect(pomeh.params(36).audio?.layers).toEqual(['hum', 'beeps', 'metronome', 'babble']);
    expect(build('pomeh', 36, 'finisher')).toMatchObject({
      layers: { audio: { layers: ['hum', 'beeps', 'metronome', 'babble'], gain: 1 }, gate: 'all' },
    });
  });

  it('an overload table or memory block changes only the level', () => {
    const table = buildBlock(planBlock(seg('schulte', 'finisher'), 7, 0, ctx), 3, 'keyboard', new Map());
    const plain = buildBlock(planBlock(seg('schulte'), 7, 0, ctx), 3, 'keyboard', new Map());
    expect(table).toEqual(plain);
    const memory = buildBlock(planBlock(seg('memory', 'finisher'), 9, 0, ctx), 3, 'keyboard', new Map());
    expect(memory).toEqual(buildBlock(planBlock(seg('memory'), 9, 0, ctx), 3, 'keyboard', new Map()));
  });

  it('the instruction of an overload table or memory block starts with OVERLOAD_PREFIX', () => {
    expect(OVERLOAD_PREFIX).toBe('Блок с перегрузкой: уровень на 3 выше обычного. ');
    for (const module of ['gorbov', 'schulte', 'memory'] as const) {
      const normal = blockInstruction(planBlock(seg(module), 5, 0, ctx), 'keyboard');
      const over = blockInstruction(planBlock(seg(module, 'finisher'), 5, 0, ctx), 'keyboard');
      expect(over).toEqual({ text: OVERLOAD_PREFIX + normal.text, keysHint: normal.keysHint });
    }
  });

  it('the instruction of an overload reaction block announces the sound it plays (M1) and, in a band module, the load (Р16)', () => {
    expect(OVERLOAD_SOUND_PREFIX).toBe('Блок с перегрузкой: уровень на 3 выше обычного, со звуковыми помехами. Надень наушники. ');
    for (const module of REACTION_MODULE_IDS) {
      for (const overload of ['finisher', 'mix'] as const) {
        const plan = planBlock(seg(module, overload), 5, 1, ctx);
        if (plan.kind !== 'reaction') throw new Error('a reaction plan');
        // The module's own text without its sound note (M2): the prefix announces the sound.
        const normal = blockInstruction({ ...plan, overload: false }, 'keyboard');
        const own = reactionModules[module].instruction('keyboard', plan.params, true);
        // A band module plays the next band's load, named by the prefix and by the load line at the end.
        const text =
          plan.load === null
            ? OVERLOAD_SOUND_PREFIX + own
            : overloadBandPrefix(plan.load.loadBandLabel ?? '') + own + ` Нагрузка: ${plan.load.loadBandLabel ?? ''}.`;
        expect(plan.load === null, module).toBe(module === 'rdo');
        expect(blockInstruction(plan, 'keyboard')).toEqual({ text, keysHint: normal.keysHint });
        const built = buildBlock(plan, 3, 'keyboard', new Map());
        expect(built.step.kind === 'reaction_block' && built.step.layers.audio).toBeTruthy();
      }
    }
  });

  it('a band that shares the load of the band below it has chain 1.0: its overload only adds the sound (T-R25)', () => {
    for (const module of BAND_MODULES) {
      const bands = bandModules[module].bands ?? [];
      bands.forEach((b, i) => {
        if (i > 0 && b.label === bands[i - 1]?.label) expect(b.chain, `${module} band ${String(i)}`).toBe(1);
      });
    }
    // ПЗМР band 0 → 1: the same red circle, the same window.
    const plan = planBlock(seg('pzmr', 'finisher'), 2, 0, { ...ctx, floors: () => 400 });
    expect(plan).toMatchObject({ load: { band: 0, loadBand: 1, bandLabel: 'красный круг', loadBandLabel: 'красный круг', floorMs: 400 } });
    // At the ladder's last band there is no next one: the overload plays that band's load.
    expect(planBlock(seg('pzmr', 'finisher'), 50, 0, ctx)).toMatchObject({ L: 50, load: { band: 12, loadBand: 12 } });
  });
});

describe('the personal window floor and the overload band (F3)', () => {
  const ctx: PlanContext = { layout: 'keyboard', scale: 1, diagnostic: false, ...PLAIN };
  /** Floors that answer `value` and note what they were asked. */
  const recording = (value: number | null): { floors: WindowFloors; asked: Array<[ReactionModuleId, number]> } => {
    const asked: Array<[ReactionModuleId, number]> = [];
    return {
      asked,
      floors: (module, band) => {
        asked.push([module, band]);
        return value;
      },
    };
  };

  it('floorsFrom: bandFloors of the stored clean hits with the module\'s ladder; null without bands', () => {
    const rts = (n: number, v: number): string => JSON.stringify({ cleanHitRts: Array<number>(n).fill(v) });
    const past = pastBlocks(
      [
        block('a', 't', '2026-10-10T09:01:00', { module: 'szmr', paramsJson: '{"band":1}', summaryJson: rts(20, 500) }),
        block('b', 't', '2026-10-10T09:02:00', { module: 'pzmr', paramsJson: '{"band":0}', summaryJson: rts(14, 300) }),
        block('c', 't', '2026-10-10T09:03:00', { module: 'rdo', paramsJson: '{"band":0}', summaryJson: rts(20, 300) }),
      ],
      [session('t', '2026-10-10T09:00:00')],
    );
    const floors = floorsFrom(past);
    // СЗМР: band 1 has its own 20 hits; band 0 none; band 2 by chain × 1.1, band 3 × 1.1 again.
    expect([0, 1, 2, 3].map((b) => floors('szmr', b))).toEqual([null, 600, 660, expect.closeTo(726, 9)]);
    // ПЗМР: 14 hits are not enough for band 0.
    expect(floors('pzmr', 0)).toBeNull();
    expect(floors('rdo', 0)).toBeNull();
    // A new WindowFloors reads the blocks stored since: 15 hits, P80 the 12th of them.
    appendPast(past, block('e', 'now', '2026-10-15T09:01:00', { module: 'pzmr', paramsJson: '{"band":0}', summaryJson: rts(1, 310) }), 'free');
    expect(floorsFrom(past)('pzmr', 0)).toBeCloseTo(1.2 * 300, 9);
  });

  it('the window is the larger of the nominal and the floor', () => {
    const high = recording(412);
    const plan = reactionPlan(freeSegment('pzmr'), 12, { ...ctx, floors: high.floors });
    expect(high.asked).toEqual([['pzmr', 3]]);
    expect(plan.params).toEqual({ ...pzmr.params(12), windowMs: 412 });
    expect(plan.load).toEqual({ band: 3, bandLabel: 'интервал 0,3–3 с, помехи', loadBand: null, loadBandLabel: null, nominalWindowMs: 233, floorMs: 412 });
    const { step, paramsJson } = buildBlock(plan, 5, 'keyboard', new Map());
    if (step.kind !== 'reaction_block') throw new Error('expected a reaction block');
    expect(step.specs.map((t) => t.windowMs)).toEqual(Array<number>(15).fill(412));
    expect(JSON.parse(paramsJson)).toEqual({ ...pzmr.params(12), windowMs: 412, nominalWindowMs: 233, floorMs: 412 });

    const low = reactionPlan(freeSegment('pzmr'), 12, { ...ctx, floors: () => 200 });
    expect(low.params).toEqual(pzmr.params(12));
    expect(low.load).toMatchObject({ nominalWindowMs: 233, floorMs: 200 });
    // The window takes round(floor).
    expect(reactionPlan(freeSegment('pzmr'), 12, { ...ctx, floors: () => 411.6 }).params).toMatchObject({ windowMs: 412 });
    // No floor of the band, or no floors at all: the nominal window and floorMs null.
    expect(reactionPlan(freeSegment('pzmr'), 12, { ...ctx, floors: () => null }).load).toMatchObject({ floorMs: null, nominalWindowMs: 233 });
    const none = reactionPlan(freeSegment('pzmr'), 12, ctx);
    expect([none.params, none.load?.floorMs]).toEqual([pzmr.params(12), null]);
    expect(JSON.parse(buildBlock(none, 5, 'keyboard', new Map()).paramsJson)).toMatchObject({ windowMs: 233, nominalWindowMs: 233, floorMs: null });
  });

  it('a swapped Go/No-Go keeps its colours under the floor', () => {
    const plan = reactionPlan(freeSegment('gonogo'), 16, { ...ctx, ...SWAPPING, floors: () => 500 });
    expect(plan.params).toMatchObject({ swapped: true, windowMs: 500, bandLabel: 'no-go — зелёный квадрат, интервал 0,3–1 с' });
    expect(plan.load).toMatchObject({ band: 4, bandLabel: 'no-go — зелёный квадрат, интервал 0,3–1 с', nominalWindowMs: 207, floorMs: 500 });
  });

  it('an overload block of a band module plays the next band\'s load at the window of its own band', () => {
    const { floors, asked } = recording(null);
    const own: WindowFloors = (module, band) => floors(module, band) ?? (band === 2 ? 700 : 900);
    const mix: Segment = { module: 'szmr', budgetMs: 300_000, purpose: 'reaction', overload: 'mix' };
    const plan = planBlock(mix, 9, 1, { ...ctx, floors: own });
    if (plan.kind !== 'reaction') throw new Error('expected a reaction plan');
    expect(asked).toEqual([['szmr', 2]]);
    expect(plan).toMatchObject({ L: 9, overload: true, keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'], size: 20 });
    expect(plan.params).toEqual({ ...szmr.params(9, 3), windowMs: 700 });
    expect(plan.params).toMatchObject({ nColors: 4, nKeys: 4, band: 3 });
    expect(plan.load).toEqual({
      band: 2,
      bandLabel: '3 цвета на 2 клавиши',
      loadBand: 3,
      loadBandLabel: '4 цвета на 4 клавиши',
      nominalWindowMs: 431,
      floorMs: 700,
    });
    expect(JSON.parse(buildBlock(plan, 5, 'keyboard', new Map()).paramsJson)).toEqual({
      ...szmr.params(9, 3),
      band: 2,
      bandLabel: '3 цвета на 2 клавиши',
      loadBand: 3,
      loadBandLabel: '4 цвета на 4 клавиши',
      windowMs: 700,
      nominalWindowMs: 431,
      floorMs: 700,
    });
    // The blocks around it play the segment level on their own band; a finisher plays every block like this one.
    expect(planBlock(mix, 9, 0, { ...ctx, floors: own })).toMatchObject({ L: 9, overload: false, load: { band: 2, loadBand: null } });
    const finisher: Segment = { ...mix, purpose: 'finisher', overload: 'finisher' };
    expect(planBlock(finisher, 9, 0, { ...ctx, floors: own })).toEqual(plan);
    // The instruction: the overload prefix with the load it plays, the module text, the load line.
    expect(blockInstruction(plan, 'keyboard').text).toBe(
      overloadBandPrefix('4 цвета на 4 клавиши') + szmr.instruction('keyboard', szmr.params(9, 3), true) + ' Нагрузка: 4 цвета на 4 клавиши.',
    );
  });

  it('the instruction of a band module ends with the load line; РДО and a diagnostic have none', () => {
    const at = (module: ReactionModuleId, L: number, c: PlanContext = ctx): string => blockInstruction(reactionPlan(freeSegment(module), L, c), 'keyboard').text;
    expect(at('szmr', 0)).toBe(szmr.instruction('keyboard', szmr.params(0)) + ' Нагрузка: 2 цвета на 2 клавиши.');
    expect(at('szmr', 0).endsWith('Нажимай нужную как можно быстрее. Нагрузка: 2 цвета на 2 клавиши.')).toBe(true);
    expect(at('pzmr', 12)).toBe(pzmr.instruction('keyboard', pzmr.params(12)) + ' Нагрузка: интервал 0,3–3 с, помехи.');
    expect(at('rdo', 5)).toBe(rdo.instruction('keyboard', rdo.params(5)));
    const diagnostic = planDiagnostic(1).segments.find((s) => s.module === 'szmr') as Segment;
    expect(blockInstruction(reactionPlan(diagnostic, 0, { ...ctx, diagnostic: true }), 'keyboard').text).toBe(
      reactionModules.szmr.instruction('keyboard', DIAGNOSTIC_PARAMS.szmr),
    );
  });

  it('a diagnostic and a test-format run never get a floor', () => {
    const { floors, asked } = recording(999);
    const diagnostic: PlanContext = { ...ctx, diagnostic: true, floors };
    for (const seg of planDiagnostic(1).segments) {
      if (!isReactionModule(seg.module)) continue;
      const plan = reactionPlan(seg, seg.fixedL ?? 0, diagnostic);
      expect(plan.params, seg.module).toBe(DIAGNOSTIC_PARAMS[seg.module]);
      expect(plan.load, seg.module).toBeNull();
    }
    // A test-format run of a training plan plays the frozen parameters too, whatever the floors say (F4).
    for (const module of TEST_FORMAT_ORDER) {
      const plan = reactionPlan(runSegment(module), 6, { ...ctx, floors });
      expect(plan.params, module).toBe(DIAGNOSTIC_PARAMS[module]);
      expect(plan.load, module).toBeNull();
    }
    expect(asked).toEqual([]);
    // The snapshots of the diagnostic blocks above pin the trials themselves.
  });
});

describe('test-format runs (F4)', () => {
  const ctx: PlanContext = { layout: 'keyboard', scale: 1, diagnostic: false, ...PLAIN };

  it('a run plays DIAGNOSTIC_PARAMS at the diagnostic volume at its level; the instruction opens with the run\'s text', () => {
    const plan = reactionPlan(runSegment('szmr'), 9, ctx);
    expect(plan).toMatchObject({ kind: 'reaction', L: 9, size: 70, practice: 5, overload: false, load: null, testFormat: true, keys: ['KeyF', 'KeyJ'] });
    expect(plan.params).toBe(DIAGNOSTIC_PARAMS.szmr);
    expect(blockInstruction(plan, 'keyboard')).toEqual({
      text: testFormatInstruction(70) + reactionModules.szmr.instruction('keyboard', DIAGNOSTIC_PARAMS.szmr),
      keysHint: 'F, J',
    });
    const { step } = buildBlock(plan, 3, 'keyboard', new Map());
    if (step.kind !== 'reaction_block') throw new Error('expected a reaction block');
    expect([step.specs.length, step.specs.filter((t) => t.practice === true).length]).toEqual([75, 5]);
    // РДО: its 3000 ms period and its block of 50.
    const rdoRun = reactionPlan(runSegment('rdo'), 14, ctx);
    expect(rdoRun).toMatchObject({ params: DIAGNOSTIC_PARAMS.rdo, size: 50, testFormat: true });
    expect(blockInstruction(rdoRun, 'keyboard').text).toBe(testFormatInstruction(50) + rdo.instruction('keyboard', DIAGNOSTIC_PARAMS.rdo));
    // Other blocks are no runs.
    expect(reactionPlan(freeSegment('szmr'), 9, ctx).testFormat).toBe(false);
    expect(reactionPlan(planDiagnostic(1).segments[1] as Segment, 0, { ...ctx, diagnostic: true }).testFormat).toBe(false);
  });

  it('a run never swaps the Go/No-Go colours, not even in a segment the plan seed swaps in training (T-R42)', () => {
    const swapping: PlanContext = { ...ctx, ...SWAPPING };
    expect(isSwappedSegment(swapping.planSeed, swapping.segmentIndex)).toBe(true);
    expect(reactionPlan(freeSegment('gonogo'), 12, swapping).params).toMatchObject({ swapped: true });
    const plan = reactionPlan(runSegment('gonogo'), 12, swapping);
    expect(plan.params).toBe(DIAGNOSTIC_PARAMS.gonogo);
    const { step } = buildBlock(plan, 9, 'keyboard', new Map());
    if (step.kind !== 'reaction_block') throw new Error('expected a reaction block');
    const go = new Set(step.specs.flatMap((t) => (t.expected.kind === 'press' ? [JSON.stringify(t.stimulus)] : [])));
    expect([...go]).toEqual([JSON.stringify({ kind: 'shape', shape: 'circle', color: 'red' })]);
  });
});

describe('the mark after a trial (F15)', () => {
  const ctx: PlanContext = { layout: 'keyboard', scale: 1, diagnostic: false, ...PLAIN, feedback: 'every' };
  const training = (module: ReactionModuleId): Segment => ({ module, budgetMs: 300_000, purpose: 'reaction', practiceTrials: 3 });
  const specsOf = (seg: Segment, c: PlanContext, seed = 9): TrialSpec[] => {
    const { step } = buildBlock(planBlock(seg, 6, 0, c), seed, 'keyboard', new Map());
    if (step.kind !== 'reaction_block') throw new Error('expected a reaction block');
    return step.specs;
  };
  const flags = (specs: readonly TrialSpec[]): (boolean | undefined)[] => specs.map((t) => t.feedback);

  it('the six modules with marks: not РДО', () => {
    expect(FEEDBACK_MODULES).toEqual(['pzmr', 'szmr', 'gonogo', 'stroop', 'taskswitch', 'pomeh']);
  });

  it("'every': every trial of a training or free block is marked, the practice trials too", () => {
    for (const module of FEEDBACK_MODULES) {
      for (const seg of [training(module), freeSegment(module), { ...training(module), purpose: 'finisher' as const, overload: 'finisher' as const }]) {
        const specs = specsOf(seg, ctx);
        expect(specs.length, `${module} ${seg.purpose}`).toBeGreaterThan(0);
        expect(new Set(flags(specs)), `${module} ${seg.purpose}`).toEqual(new Set([true]));
      }
      expect(specsOf(training(module), ctx).filter((t) => t.practice === true)).toHaveLength(3);
    }
  });

  it("'half': trial i by the i-th draw of the block's 'feedback' stream, in order; the same seed gives the same flags", () => {
    const half = { ...ctx, feedback: 'half' as const };
    for (const module of FEEDBACK_MODULES) {
      const specs = specsOf(training(module), half, 77);
      const rng = createRng(deriveSeed(77, 'feedback'));
      expect(flags(specs), module).toEqual(specs.map(() => rng.next() < 0.5));
      expect(specsOf(training(module), half, 77)).toEqual(specs);
    }
    const all = FEEDBACK_MODULES.flatMap((m) => flags(specsOf(training(m), half, 5)));
    expect(all.filter((f) => f === true).length / all.length).toBeGreaterThan(0.3);
    expect(all.filter((f) => f === true).length / all.length).toBeLessThan(0.7);
  });

  it('marks change nothing else: the trials are those of a block without them', () => {
    for (const module of FEEDBACK_MODULES) {
      const plain = specsOf(training(module), { ...ctx, feedback: 'none' });
      expect(plain.some((t) => 'feedback' in t), module).toBe(false);
      for (const rate of ['every', 'half'] as const) {
        const marked = specsOf(training(module), { ...ctx, feedback: rate });
        expect(marked.map((t) => ({ ...t, feedback: undefined })), `${module} ${rate}`).toEqual(plain.map((t) => ({ ...t, feedback: undefined })));
      }
    }
  });

  it('none in РДО, a warm-up, a test-format run or a diagnostic', () => {
    const none = (specs: readonly TrialSpec[]): boolean => specs.every((t) => !('feedback' in t));
    expect(none(specsOf(training('rdo'), ctx))).toBe(true);
    expect(none(specsOf(freeSegment('rdo'), ctx))).toBe(true);
    expect(none(specsOf({ module: 'pzmr', budgetMs: 120_000, purpose: 'warmup' }, ctx))).toBe(true);
    for (const module of TEST_FORMAT_ORDER) expect(none(specsOf(runSegment(module), ctx)), module).toBe(true);
    for (const seg of planDiagnostic(1).segments.filter((x) => isReactionModule(x.module))) {
      expect(none(specsOf(seg, { ...ctx, diagnostic: true })), seg.module).toBe(true);
    }
    expect(reactionPlan(training('szmr'), 6, ctx).feedback).toBe('every');
    expect(reactionPlan(training('rdo'), 6, ctx).feedback).toBe('none');
  });
});

describe('the stored block size (T-R48)', () => {
  const ctx: PlanContext = { layout: 'keyboard', scale: 1, diagnostic: false, ...PLAIN };
  const storedTrials = (plan: BlockPlan): unknown => (JSON.parse(buildBlock(plan, 5, 'keyboard', new Map()).paramsJson) as { trials?: unknown }).trials;
  const diagnostic = (module: ReactionModuleId): Segment => planDiagnostic(1).segments.find((s) => s.module === module) as Segment;

  it('paramsJson.trials is the size the block played, practice left out', () => {
    // The diagnostic ПЗМР plays 50 (+5 practice) on params that say 15.
    expect(DIAGNOSTIC_PARAMS.pzmr.trials).toBe(15);
    expect(storedTrials(reactionPlan(diagnostic('pzmr'), 0, { ...ctx, diagnostic: true }))).toBe(50);
    expect(storedTrials(reactionPlan(runSegment('gonogo'), 3, ctx))).toBe(60);
    // The e2e scale shrinks the block, and the row says so.
    expect(storedTrials(reactionPlan(diagnostic('pzmr'), 0, { ...ctx, diagnostic: true, scale: 0.02 }))).toBe(3);
    expect(storedTrials(reactionPlan(freeSegment('szmr'), 0, { ...ctx, scale: 0.02 }))).toBe(3);
    // РДО has no block size of its own in its params: the row gets one.
    expect(DIAGNOSTIC_PARAMS.rdo).not.toHaveProperty('trials');
    expect(storedTrials(reactionPlan(freeSegment('rdo'), 0, ctx))).toBe(rdo.trials(rdo.params(0)));
    // A training block at full scale keeps its params' size.
    expect(storedTrials(reactionPlan(freeSegment('pzmr'), 28, ctx))).toBe(pzmr.params(28).trials);
    expect(pzmr.params(28).trials).toBe(45);
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

  it('a skipped item is wrong, whatever it says (F11, F12): no answer, no time', () => {
    const outcomes = scoreSeries(step([40_000, 40_000, 40_000], null), [
      { itemId: 'arith:1', given: 4, timeMs: 3000 },
      { itemId: 'arith:2', given: null, timeMs: 0, skipped: true },
      // A damaged answer that is marked skipped stays wrong.
      { itemId: 'arith:3', given: 4, timeMs: 0, skipped: true },
    ]);
    expect(outcomes.map((o) => [o.correct, o.success])).toEqual([
      [true, true],
      [false, false],
      [false, false],
    ]);
  });

  it('total limit (diagnostic): cumulative time', () => {
    expect(scoreSeries(step([null, null, null], 31_000), answers).map((o) => o.success)).toEqual([true, false, false]);
    expect(scoreSeries(step([null, null, null], null), answers).map((o) => o.success)).toEqual([true, false, true]);
  });

  it('scoreSeries refuses a step with item limits and a total limit at once', () => {
    expect(() => scoreSeries(step([11_900, null, null], 31_000), answers)).toThrow(RangeError);
    expect(() => scoreSeries(step([11_900, 40_000, 40_000], null), answers)).not.toThrow();
    expect(() => scoreSeries(step([null, null, null], 31_000), answers)).not.toThrow();
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

  it('ratings updated live equal deriveRatings over the stored rows, for limits under 40 s (R36)', () => {
    const item = fc.record({
      family: fc.constantFrom(...FAMILIES),
      difficulty: fc.integer({ min: 500, max: 1800 }),
      timeLimitMs: fc.integer({ min: 80, max: 399 }).map((x) => x * 100),
      correct: fc.boolean(),
      timeMs: fc.integer({ min: 500, max: 45_000 }),
    });
    fc.assert(
      fc.property(fc.array(fc.array(item, { minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 3 }), (blocks) => {
        let live = new Map<FamilyId, Rating>();
        const rows = blocks.flatMap((block, b) => {
          const s: StepOf<'numseries_block'> = {
            kind: 'numseries_block',
            items: block.map((it, i) => ({ ...seriesItem(i, it.timeLimitMs, it.difficulty), id: `${String(b)}:${String(i)}`, family: it.family })),
            totalLimitMs: null,
          };
          const outcomes = scoreSeries(
            s,
            block.map((it, i) => ({ itemId: `${String(b)}:${String(i)}`, given: it.correct ? 4 : 5, timeMs: it.timeMs })),
          );
          live = updatedRatings(live, outcomes);
          return logicItemRows(`b${String(b)}`, outcomes, new Date(Date.UTC(2026, 9, 14 + b)).toISOString());
        });
        expect(rows.every((r) => r.timeLimitMs !== null && r.timeLimitMs < 40_000)).toBe(true);
        expect(live).toEqual(deriveRatings(rows));
      }),
      { numRuns: 1000 },
    );
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
    const plan = planBlock(segment, 0, 0, { layout: 'keyboard', scale: 1, diagnostic: true, ...PLAIN });
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
    const plan = planBlock({ module: 'numseries', budgetMs: 0, purpose: 'logic' }, 0, 0, { layout: 'keyboard', scale: 1, diagnostic: false, ...PLAIN });
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
      { module: 'pzmr', summary: summary({ medianRt: 301, timingUnreliable: true }), hitRts: [], conditions: {} },
      { module: 'szmr', summary: summary({ medianRt: 402 }), hitRts: [], conditions: {} },
      { module: 'rdo', summary: summary({ meanAbsErrorMs: 20, timingUnreliable: true }), hitRts: [], conditions: {} },
      { module: 'gorbov', run: 0, seconds: 30 },
      { module: 'stroop', summary: summary({ timingUnreliable: true }), hitRts: [], conditions: {} },
    ]);
    expect(r.unreliable).toEqual(['pzmr', 'rdo', 'stroop']);
    expect(r.pzmrMedianRt).toBe(301);
    expect(r.rdoMeanAbsErrorMs).toBe(20);
  });

  it('fills each metric from its block; Gorbov needs all three runs completed', () => {
    const cond = (medianRt: number | null) => ({ n: 20, errors: 0, medianRt });
    const all = diagnosticResults([
      { module: 'pzmr', summary: summary({ medianRt: 301 }), hitRts: [], conditions: {} },
      { module: 'szmr', summary: summary({ medianRt: 402 }), hitRts: [], conditions: {} },
      { module: 'gonogo', summary: summary({ score: 57 / 60, penalizedScore: 52 / 60 }), hitRts: [], conditions: {} },
      { module: 'rdo', summary: summary({ meanAbsErrorMs: 23.5 }), hitRts: [], conditions: {} },
      { module: 'gorbov', run: 0, seconds: 30 },
      { module: 'gorbov', run: 1, seconds: 35 },
      { module: 'gorbov', run: 2, seconds: 70 },
      { module: 'numseries', correct: 14, total: 20 },
      { module: 'pomeh', summary: summary({}), hitRts: [], conditions: { quiet: cond(300), noisy: cond(335) } },
      { module: 'stroop', summary: summary({}), hitRts: [], conditions: { congruent: cond(520), incongruent: cond(610) } },
      { module: 'taskswitch', summary: summary({}), hitRts: [], conditions: { repeat: cond(600), switch: cond(580) } },
      { module: 'memory', span: 7 },
    ]);
    expect(all).toEqual({
      pzmrMedianRt: 301,
      pzmrMeanRt: null,
      // No clean hits: no SD or IQR; every error count 0.
      pzmrSdRt: null,
      pzmrIqrRt: null,
      pzmrFalseStarts: 0,
      szmrMedianRt: 402,
      szmrMeanRt: null,
      szmrSdRt: null,
      szmrIqrRt: null,
      szmrFalseStarts: 0,
      szmrWrong: 0,
      gonogoScore: (57 / 60) * 100,
      gonogoCommissions: 0,
      gonogoOmissions: 0,
      rdoMeanAbsErrorMs: 23.5,
      rdoEarly: 0,
      rdoLate: 0,
      rdoSignedBiasMs: null,
      gorbov: gorbovMetrics(30, 35, 70),
      numseriesCorrect: 14,
      pomehQuietRt: 300,
      pomehNoisyRt: 335,
      pomehDeltaMs: 35,
      stroopCongruentRt: 520,
      stroopIncongruentRt: 610,
      stroopInterferenceMs: 90,
      switchRepeatRt: 600,
      switchSwitchRt: 580,
      switchCostMs: -20,
      memorySpan: 7,
      unreliable: [],
      restarts: {},
    });
    // A condition with fewer than 3 RTs has no median: its difference is missing, the other median is kept.
    const partial = diagnosticResults([{ module: 'stroop', summary: summary({}), hitRts: [], conditions: { congruent: cond(520), incongruent: cond(null) } }]);
    expect(partial).toMatchObject({ stroopCongruentRt: 520, stroopIncongruentRt: null, stroopInterferenceMs: null });
    expect(diagnosticResults([{ module: 'pomeh', summary: summary({}), hitRts: [], conditions: {} }])).toMatchObject({
      pomehQuietRt: null,
      pomehNoisyRt: null,
      pomehDeltaMs: null,
    });
    expect(diagnosticResults([{ module: 'gorbov', run: 0, seconds: 30 }, { module: 'gorbov', run: 1, seconds: null }, { module: 'gorbov', run: 2, seconds: 70 }]).gorbov).toBeNull();
    expect(diagnosticResults([{ module: 'gorbov', run: 0, seconds: 30 }, { module: 'gorbov', run: 2, seconds: 70 }]).gorbov).toBeNull();
    expect(diagnosticResults([])).toEqual({ ...EMPTY_METRICS, unreliable: [], restarts: {} });
    expect(diagnosticResults([])).toEqual(EMPTY_RESULTS);
    expect(Object.values(EMPTY_METRICS).every((v) => v === null)).toBe(true);
  });

  it('diagnosticResults keeps the restarts of each module, as a copy (F11)', () => {
    const restarts = { pzmr: { user: 1, focus: 2 }, gorbov: { user: 0, focus: 1 } };
    const r = diagnosticResults([], restarts);
    expect(r.restarts).toEqual(restarts);
    restarts.pzmr.user = 5;
    expect(r.restarts.pzmr).toEqual({ user: 1, focus: 2 });
  });

  it('diagnosticResults keeps the mean RTs of ПЗМР and СЗМР', () => {
    const r = diagnosticResults([
      { module: 'pzmr', summary: summary({ medianRt: 301, meanRt: 312.5 }), hitRts: [], conditions: {} },
      { module: 'szmr', summary: summary({ medianRt: 402, meanRt: 410 }), hitRts: [], conditions: {} },
    ]);
    expect(r).toMatchObject({ pzmrMedianRt: 301, pzmrMeanRt: 312.5, szmrMedianRt: 402, szmrMeanRt: 410 });
  });

  it('diagnosticResults keeps SD, IQR and error counts', () => {
    const hitRts = [300, 310, 320, 330, 340];
    const r = diagnosticResults([
      { module: 'pzmr', summary: summary({ counts: { ...counts, hit: 5, false_start: 1 } }), hitRts, conditions: {} },
      { module: 'szmr', summary: summary({ counts: { ...counts, hit: 3, wrong: 2 } }), hitRts: [400, 500, 450], conditions: {} },
      { module: 'gonogo', summary: summary({ counts: { ...counts, commission: 3, miss: 1, late: 1 } }), hitRts: [], conditions: {} },
      { module: 'rdo', summary: summary({ counts: { ...counts, early: 12, timing_late: 9 }, meanSignedErrorMs: -6.2 }), hitRts: [], conditions: {} },
    ]);
    expect(r).toMatchObject({ pzmrSdRt: sdTrimmed(hitRts), pzmrIqrRt: 20, pzmrFalseStarts: 1 });
    expect(r).toMatchObject({ szmrSdRt: 50, szmrIqrRt: 50, szmrFalseStarts: 0, szmrWrong: 2 });
    expect(r).toMatchObject({ gonogoCommissions: 3, gonogoOmissions: 2 });
    expect(r).toMatchObject({ rdoEarly: 12, rdoLate: 9, rdoSignedBiasMs: -6.2 });
    // One clean hit has no spread: SD and IQR stay null, the counts are kept.
    const one = diagnosticResults([{ module: 'pzmr', summary: summary({ counts: { ...counts, false_start: 2 } }), hitRts: [300], conditions: {} }]);
    expect(one).toMatchObject({ pzmrSdRt: null, pzmrIqrRt: null, pzmrFalseStarts: 2 });
  });
});
