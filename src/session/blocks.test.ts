import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { deriveRatings } from '../engine/derive';
import { EMPTY_METRICS, diagnosticSegmentSeed, diagnosticSeriesSchedule, planDiagnostic } from '../engine/diagnostic';
import { R0, updateRating, type Rating } from '../engine/elo';
import { effectiveDifficulty } from '../engine/itemLimit';
import { FINISHER_AUDIO } from '../engine/audio/stressors';
import { noiseFrame } from '../engine/noise';
import { OVERLOAD_LEVEL_STEP, type Segment } from '../engine/planner';
import { MIN_COND_RTS, condPairOf, type CondPair } from '../engine/reaction/conditions';
import type { Outcome, ReactionSummary } from '../engine/reaction/types';
import { REACTION_MODULE_IDS, isReactionModule, type FamilyId, type ReactionModuleId } from '../engine/types';
import { createRng, deriveSeed } from '../engine/rng';
import { generateMemoryTrials, spanProtocolTrials } from '../modules/memory/generate';
import { memoryModeForBlock, memoryParams } from '../modules/memory/params';
import { FAMILIES } from '../modules/numseries/families';
import { generateItem, type TimedSeriesItem } from '../modules/numseries/generate';
import { NO_STRESSORS } from '../modules/reaction/common';
import { DIAGNOSTIC_PARAMS } from '../modules/reaction/diagnosticParams';
import { pomeh } from '../modules/reaction/pomeh';
import { pzmr } from '../modules/reaction/pzmr';
import { reactionModules } from '../modules/registry';
import { gorbovMetrics } from '../modules/tables/gorbov';
import { perfectPlayer, playTimeline } from '../testing/sessionPlayers';
import {
  blockInstruction,
  buildBlock,
  diagnosticBlockSeed,
  diagnosticResults,
  E2E_COND_MARGIN,
  e2eCondFloor,
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
} from './blocks';
import { logicItemRows } from './rowsBuild';
import { MEMORY_SPAN_INSTRUCTION, OVERLOAD_PREFIX, OVERLOAD_SOUND_PREFIX, type StepOf } from './steps';

const counts = {} as Record<Outcome, number>;
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

/** The reaction modules with trial conditions (COND_PAIRS). */
const CONDITION_MODULES: readonly ReactionModuleId[] = ['stroop', 'pomeh', 'taskswitch'];

const freeSegment = (module: ReactionModuleId): Segment => ({ module, budgetMs: 300_000, purpose: 'free' });

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
    const ctx = { layout: 'keyboard', scale: 0.02, diagnostic: true } as const;
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
    const ctx = { layout: 'keyboard', scale: 0.02, diagnostic: true } as const;
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

  it('the e2e floor holds at every level 0–40, and scale 1 keeps the planned sizes', () => {
    const need = MIN_COND_RTS + E2E_COND_MARGIN;
    for (const module of CONDITION_MODULES) {
      const mod = reactionModules[module];
      const diagSeg = planDiagnostic(1).segments.find((s) => s.module === module) as Segment;
      for (let L = 0; L <= 40; L++) {
        for (const seg of [diagSeg, freeSegment(module)]) {
          const diagnostic = seg.purpose === 'diagnostic';
          const e2e = reactionPlan(seg, L, { layout: 'keyboard', scale: 0.02, diagnostic });
          expect(mod.minCondTrials?.(e2e.params, e2e.size), `${module} L ${String(L)}`).toBeGreaterThanOrEqual(need);
          expect(planBlock(seg, L, 0, { layout: 'keyboard', scale: 1, diagnostic })).toMatchObject({ size: seg.trialCount ?? mod.blockSize });
        }
      }
    }
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
    const ctx = { layout: 'keyboard' as const, scale: 1, diagnostic: true };
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
  const ctx = { layout: 'keyboard', scale: 1, diagnostic: true } as const;
  /** Block 0, attempt 0 of every reaction segment of diagnostic n. */
  const diagnosticSteps = (n: number) =>
    planDiagnostic(n).segments.flatMap((seg) => {
      if (!isReactionModule(seg.module)) return [];
      const { step } = buildBlock(planBlock(seg, seg.fixedL ?? 0, 0, ctx), diagnosticBlockSeed(n, seg.module, 0, 0), 'keyboard', new Map());
      if (step.kind !== 'reaction_block') throw new Error('expected a reaction block');
      return [step];
    });

  it('diagnostic reaction blocks are those of 0.2.0', () => {
    for (const n of [1, 2, 3]) {
      for (const { module, specs, layers } of diagnosticSteps(n)) {
        // The layer fields are listed one by one: a new field (noiseGate, …) must not change the snapshot.
        expect({ specs, noise: layers.noise, audio: layers.audio, gate: layers.gate }).toMatchSnapshot(`${String(n)} ${module}`);
      }
    }
  });

  it('a diagnostic block takes DIAGNOSTIC_PARAMS, never params(fixedL)', () => {
    const spy = vi.spyOn(reactionModules.gonogo, 'params');
    try {
      const seg = planDiagnostic(1).segments.find((s) => s.module === 'gonogo') as Segment;
      expect(planBlock(seg, seg.fixedL ?? 0, 0, ctx)).toMatchObject({ kind: 'reaction', L: 10, params: DIAGNOSTIC_PARAMS.gonogo });
      expect(spy).not.toHaveBeenCalled();
      planBlock(freeSegment('gonogo'), 7, 0, { ...ctx, diagnostic: false });
      expect(spy).toHaveBeenCalledWith(7);
    } finally {
      spy.mockRestore();
    }
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

describe('overload blocks', () => {
  const ctx = { layout: 'keyboard', scale: 1, diagnostic: false } as const;
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

  it('a mix plays its overload blocks at the segment level + 3; a finisher plays at the level it is given', () => {
    expect(OVERLOAD_LEVEL_STEP).toBe(3);
    expect(planBlock(seg('szmr', 'mix'), 10, 0, ctx)).toMatchObject({ kind: 'reaction', L: 10, overload: false });
    expect(planBlock(seg('szmr', 'mix'), 10, 1, ctx)).toEqual({ ...planBlock(seg('szmr'), 13, 1, ctx), overload: true });
    expect(planBlock(seg('szmr', 'finisher'), 13, 0, ctx)).toMatchObject({ L: 13, overload: true });
    expect(planBlock(seg('szmr'), 10, 1, ctx)).toMatchObject({ L: 10, overload: false });
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
    const pomehStep = build('pomeh', 18, 'finisher');
    expect(pomehStep).toMatchObject({
      layers: { noise: pomeh.params(18).noise, audio: { layers: ['hum', 'beeps', 'babble'], gain: 0.8 }, gate: 'all' },
    });
    if (pomehStep.kind !== 'reaction_block') throw new Error('expected a reaction block');
    // Quiet trials stay visually quiet: the trial conditions do not change.
    const normal = build('pomeh', 18);
    if (normal.kind !== 'reaction_block') throw new Error('expected a reaction block');
    expect(pomehStep.specs).toEqual(normal.specs);
    expect(pomeh.params(36).audio?.layers).toEqual(['hum', 'beeps', 'metronome', 'babble']);
    expect(build('pomeh', 36, 'finisher')).toMatchObject({
      layers: { audio: { layers: ['hum', 'beeps', 'metronome', 'babble'], gain: 0.95 }, gate: 'all' },
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

  it('the instruction of an overload reaction block announces the sound it plays (M1)', () => {
    expect(OVERLOAD_SOUND_PREFIX).toBe('Блок с перегрузкой: уровень на 3 выше обычного, со звуковыми помехами. Надень наушники. ');
    for (const module of REACTION_MODULE_IDS) {
      for (const overload of ['finisher', 'mix'] as const) {
        const plan = planBlock(seg(module, overload), 5, 1, ctx);
        if (plan.kind !== 'reaction') throw new Error('a reaction plan');
        const normal = blockInstruction({ ...plan, overload: false }, 'keyboard');
        expect(blockInstruction(plan, 'keyboard')).toEqual({ text: OVERLOAD_SOUND_PREFIX + normal.text, keysHint: normal.keysHint });
        const built = buildBlock(plan, 3, 'keyboard', new Map());
        expect(built.step.kind === 'reaction_block' && built.step.layers.audio).toBeTruthy();
      }
    }
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
      { module: 'pzmr', summary: summary({ medianRt: 301, timingUnreliable: true }), conditions: {} },
      { module: 'szmr', summary: summary({ medianRt: 402 }), conditions: {} },
      { module: 'rdo', summary: summary({ meanAbsErrorMs: 20, timingUnreliable: true }), conditions: {} },
      { module: 'gorbov', run: 0, seconds: 30 },
      { module: 'stroop', summary: summary({ timingUnreliable: true }), conditions: {} },
    ]);
    expect(r.unreliable).toEqual(['pzmr', 'rdo', 'stroop']);
    expect(r.pzmrMedianRt).toBe(301);
    expect(r.rdoMeanAbsErrorMs).toBe(20);
  });

  it('fills each metric from its block; Gorbov needs all three runs completed', () => {
    const cond = (medianRt: number | null) => ({ n: 20, errors: 0, medianRt });
    const all = diagnosticResults([
      { module: 'pzmr', summary: summary({ medianRt: 301 }), conditions: {} },
      { module: 'szmr', summary: summary({ medianRt: 402 }), conditions: {} },
      { module: 'gonogo', summary: summary({ score: 57 / 60, penalizedScore: 52 / 60 }), conditions: {} },
      { module: 'rdo', summary: summary({ meanAbsErrorMs: 23.5 }), conditions: {} },
      { module: 'gorbov', run: 0, seconds: 30 },
      { module: 'gorbov', run: 1, seconds: 35 },
      { module: 'gorbov', run: 2, seconds: 70 },
      { module: 'numseries', correct: 14, total: 20 },
      { module: 'pomeh', summary: summary({}), conditions: { quiet: cond(300), noisy: cond(335) } },
      { module: 'stroop', summary: summary({}), conditions: { congruent: cond(520), incongruent: cond(610) } },
      { module: 'taskswitch', summary: summary({}), conditions: { repeat: cond(600), switch: cond(580) } },
      { module: 'memory', span: 7 },
    ]);
    expect(all).toEqual({
      pzmrMedianRt: 301,
      pzmrMeanRt: null,
      szmrMedianRt: 402,
      szmrMeanRt: null,
      gonogoScore: (57 / 60) * 100,
      rdoMeanAbsErrorMs: 23.5,
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
    });
    // A condition with fewer than 3 RTs has no median: its difference is missing, the other median is kept.
    const partial = diagnosticResults([{ module: 'stroop', summary: summary({}), conditions: { congruent: cond(520), incongruent: cond(null) } }]);
    expect(partial).toMatchObject({ stroopCongruentRt: 520, stroopIncongruentRt: null, stroopInterferenceMs: null });
    expect(diagnosticResults([{ module: 'pomeh', summary: summary({}), conditions: {} }])).toMatchObject({
      pomehQuietRt: null,
      pomehNoisyRt: null,
      pomehDeltaMs: null,
    });
    expect(diagnosticResults([{ module: 'gorbov', run: 0, seconds: 30 }, { module: 'gorbov', run: 1, seconds: null }, { module: 'gorbov', run: 2, seconds: 70 }]).gorbov).toBeNull();
    expect(diagnosticResults([{ module: 'gorbov', run: 0, seconds: 30 }, { module: 'gorbov', run: 2, seconds: 70 }]).gorbov).toBeNull();
    expect(diagnosticResults([])).toEqual({ ...EMPTY_METRICS, unreliable: [] });
    expect(Object.values(EMPTY_METRICS).every((v) => v === null)).toBe(true);
  });

  it('diagnosticResults keeps the mean RTs of ПЗМР and СЗМР', () => {
    const r = diagnosticResults([
      { module: 'pzmr', summary: summary({ medianRt: 301, meanRt: 312.5 }), conditions: {} },
      { module: 'szmr', summary: summary({ medianRt: 402, meanRt: 410 }), conditions: {} },
    ]);
    expect(r).toMatchObject({ pzmrMedianRt: 301, pzmrMeanRt: 312.5, szmrMedianRt: 402, szmrMeanRt: 410 });
  });
});
