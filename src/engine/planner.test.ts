import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PhaseId, PhaseInfo } from './phases';
import {
  ATTENTION_POOL,
  FINISHER_POOL,
  L_NORM,
  MEMORY_SLOT_POOL,
  OLD_L_NORM,
  REACTION_POOL,
  TEST_FORMAT_FROM_DAY,
  TEST_FORMAT_MINUTES,
  TEST_FORMAT_ORDER,
  daysBetween,
  feedbackRate,
  isDiagnosticDue,
  isRehearsalDue,
  modulePriority,
  nextTestFormat,
  planFree,
  planTraining,
  taperBudget,
  testFormatDue,
  warmupLevel,
  type ModuleState,
  type SessionPlan,
  type TrainingExtras,
} from './planner';
import { localDayIso } from './dates';
import { MODULE_IDS, type ModuleId } from './types';

const TODAY = '2026-10-14';

const state = (module: ModuleId, over: Partial<ModuleState> = {}): ModuleState => ({
  module,
  lSaved: 0,
  sessionEndLevels: [],
  savedHistory: [],
  plateau: false,
  lastTrainedAt: null,
  lifetimeBlocks: 0,
  ...over,
});

const allStates = (over: Partial<Record<ModuleId, Partial<ModuleState>>> = {}): Record<ModuleId, ModuleState> =>
  Object.fromEntries(MODULE_IDS.map((m) => [m, state(m, over[m])])) as Record<ModuleId, ModuleState>;

/** Every module trained yesterday at its norm with 10 blocks: all priorities tie at 1/7. */
const trained = (over: Partial<Record<ModuleId, Partial<ModuleState>>> = {}): Record<ModuleId, ModuleState> =>
  allStates(
    Object.fromEntries(
      MODULE_IDS.map((m) => [m, { lSaved: L_NORM[m], lastTrainedAt: '2026-10-13', lifetimeBlocks: 10, ...over[m] }]),
    ),
  );

const REASON: Record<PhaseId, PhaseInfo['reason']> = { base: 'first_days', development: 'weak_spots', overload: 'test_soon', taper: 'taper' };

const phaseInfo = (phase: PhaseId, over: Partial<PhaseInfo> = {}): PhaseInfo => ({
  phase,
  reason: REASON[phase],
  dayNumber: 30,
  daysToTest: null,
  uncalibrated: [],
  ...over,
});

const DEV = phaseInfo('development');

/** The extras of a keyboard user with the rotation on and these stored runs. */
const runsOf = (testFormatRuns: readonly string[]): TrainingExtras => ({ testFormatRuns, layout: 'keyboard', layoutRotation: true, trainingDay: 1 });

describe('daysBetween', () => {
  it('counts calendar days between date-only strings', () => {
    expect(daysBetween('2026-10-10', '2026-10-14')).toBe(4);
    expect(daysBetween('2026-10-14', '2026-10-14')).toBe(0);
  });

  it('negative day gaps clamp to 0', () => {
    expect(daysBetween('2026-10-14', '2026-10-10')).toBe(0);
  });

  it('date-only and datetime inputs are equivalent for the same local day', () => {
    const dt = (y: number, m: number, d: number, h: number, mi: number): string =>
      new Date(y, m - 1, d, h, mi).toISOString();
    expect(daysBetween('2026-10-10', dt(2026, 10, 14, 23, 59))).toBe(4);
    expect(daysBetween(dt(2026, 10, 10, 0, 1), '2026-10-14')).toBe(4);
    expect(daysBetween(dt(2026, 10, 10, 23, 59), dt(2026, 10, 14, 0, 1))).toBe(4);
  });

  it('counts datetimes by local calendar day, not by elapsed 24h periods', () => {
    expect(daysBetween('2026-10-13T23:59:00', '2026-10-14T00:01:00')).toBe(1);
    expect(daysBetween('2026-10-13T00:01:00', '2026-10-13T23:59:00')).toBe(0);
  });

  it('rejects invalid strings with RangeError', () => {
    expect(() => daysBetween('nope', '2026-10-14')).toThrow(RangeError);
    expect(() => daysBetween('2026-10-14', '')).toThrow(RangeError);
    expect(() => daysBetween('2026-13-01', '2026-10-14')).toThrow(RangeError);
    expect(() => daysBetween('2026-02-30', '2026-10-14')).toThrow(RangeError);
  });

  it('is month-, year- and leap-year-correct', () => {
    expect(daysBetween('2026-02-27', '2026-03-02')).toBe(3);
    expect(daysBetween('2028-02-27', '2028-03-02')).toBe(4);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  describe('across DST changes (Europe/Berlin)', () => {
    const original = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = 'Europe/Berlin';
    });
    afterAll(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });

    it('spring forward (last Sunday of March) does not lose a day', () => {
      expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
      expect(daysBetween('2026-03-29', '2026-03-30')).toBe(1);
      expect(daysBetween('2026-03-28T00:30:00', '2026-03-30T00:30:00')).toBe(2);
      expect(daysBetween('2026-03-29T00:30:00', '2026-03-30T00:30:00')).toBe(1);
      expect(daysBetween('2026-03-28T12:00:00', '2026-03-29T23:30:00')).toBe(1);
    });

    it('fall back (last Sunday of October) does not gain a day', () => {
      expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
      expect(daysBetween('2026-10-25T00:30:00', '2026-10-26T00:30:00')).toBe(1);
    });
  });

  it('property: antisymmetric clamp and additivity on date-only strings', () => {
    const day = fc
      .integer({ min: 0, max: 3650 })
      .map((n) => new Date(Date.UTC(2024, 0, 1 + n)).toISOString().slice(0, 10));
    fc.assert(
      fc.property(day, day, (a, b) => {
        const f = daysBetween(a, b);
        const g = daysBetween(b, a);
        return f >= 0 && g >= 0 && (f === 0 || g === 0) && Number.isInteger(f);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('localDayIso', () => {
  it('is the local calendar day as YYYY-MM-DD', () => {
    expect(localDayIso('2026-10-15')).toBe('2026-10-15');
    expect(localDayIso('2026-10-15T23:59:00')).toBe('2026-10-15');
    expect(localDayIso('2026-10-16T00:00:00')).toBe('2026-10-16');
    const late = new Date(2026, 0, 1, 23, 30);
    expect(localDayIso(late.toISOString())).toBe('2026-01-01');
    expect(localDayIso('2024-02-29T12:00:00')).toBe('2024-02-29');
    expect(() => localDayIso('yesterday')).toThrow(RangeError);
  });
});

describe('L_NORM', () => {
  it('the first level of the first band harder than the test format (F3, spec §3.1.5); memory 21, the first card harder than the test (F13)', () => {
    expect(L_NORM).toEqual({ pzmr: 8, szmr: 8, gonogo: 8, rdo: 10, gorbov: 12, schulte: 6, stroop: 12, taskswitch: 8, pomeh: 8, memory: 21, numseries: 0 });
  });

  it('memory at 9, the norm of 0.2.0, now weighs as a weak module in the plan (F13)', () => {
    const state: ModuleState = { module: 'memory', lSaved: 9, sessionEndLevels: [9], savedHistory: [9], plateau: false, lastTrainedAt: TODAY, lifetimeBlocks: 9 };
    expect(modulePriority(state, TODAY)).toBeCloseTo(1 - 9 / 21, 12);
  });

  it('OLD_L_NORM keeps the values of 0.2.0 for the step of the norm line in «Прогресс» (F3, spec §3.1.6)', () => {
    expect(OLD_L_NORM).toEqual({ pzmr: 14, szmr: 12, gonogo: 10, rdo: 10, gorbov: 12, schulte: 6, stroop: 10, taskswitch: 10, pomeh: 14, memory: 9, numseries: 0 });
  });
});

describe('modulePriority', () => {
  it('sums recency, weakness and plateau terms', () => {
    const s = state('gorbov', { lSaved: 6, lastTrainedAt: '2026-10-11', plateau: true });
    // 3/7 + (1 - 6/12) + 0.5
    expect(modulePriority(s, '2026-10-14')).toBeCloseTo(3 / 7 + 0.5 + 0.5, 12);
    // ПЗМР is at norm from L 8 (F3): 7 of 8 leaves 1/8 of the weakness term.
    expect(modulePriority(state('pzmr', { lSaved: 7, lastTrainedAt: '2026-10-11' }), '2026-10-14')).toBeCloseTo(3 / 7 + 1 / 8, 12);
  });

  it('treats a never-trained module as 7 days since', () => {
    expect(modulePriority(state('szmr'), '2026-10-14')).toBeCloseTo(1 + 1, 12);
  });

  it('caps recency at 7 days and weakness at [0, 1]', () => {
    const old = state('gonogo', { lSaved: 100, lastTrainedAt: '2025-01-01' });
    expect(modulePriority(old, '2026-10-14')).toBe(1);
    const neg = state('gonogo', { lSaved: -5, lastTrainedAt: '2026-10-14' });
    expect(modulePriority(neg, '2026-10-14')).toBe(1);
  });

  it('weakness term is 0 when L_NORM is 0', () => {
    expect(L_NORM.numseries).toBe(0);
    expect(modulePriority(state('numseries', { lSaved: 0 }), '2026-10-14')).toBe(1);
  });

  it('is finite and >= 0 when lastTrainedAt is in the future', () => {
    const p = modulePriority(state('rdo', { lSaved: 3, lastTrainedAt: '2026-12-01' }), '2026-10-14');
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeCloseTo(1 - 3 / 10, 12);
  });
});

describe('planTraining', () => {
  const modules = (plan: SessionPlan): ModuleId[] => plan.segments.map((s) => s.module);
  const reaction = (plan: SessionPlan): ModuleId[] => plan.segments.slice(1, 3).map((s) => s.module);
  const FRESH = { lifetimeBlocks: 0, lSaved: 0, lastTrainedAt: null } as const;

  it('base: no finisher', () => {
    const plan = planTraining(allStates(), TODAY, 42, phaseInfo('base'));
    expect(plan).toMatchObject({ kind: 'training', seed: 42, phase: 'base' });
    expect(plan.segments).toEqual([
      { module: 'pzmr', budgetMs: 120000, purpose: 'warmup' },
      { module: 'szmr', budgetMs: 300000, purpose: 'reaction' },
      { module: 'gonogo', budgetMs: 300000, purpose: 'reaction' },
      { module: 'gorbov', budgetMs: 300000, purpose: 'attention' },
      { module: 'memory', budgetMs: 300000, purpose: 'attention' },
      { module: 'numseries', budgetMs: 600000, purpose: 'logic' },
    ]);
    // Not even when the modules are calibrated (W2-R12: the finisher starts in «Развитие»).
    expect(planTraining(trained(), TODAY, 1, phaseInfo('base', { reason: 'calibration' })).segments).toHaveLength(6);
  });

  it('development: finisher is the calibrated top-priority module not in the plan', () => {
    const plan = planTraining(trained(), TODAY, 1, phaseInfo('development'));
    expect(plan.phase).toBe('development');
    expect(modules(plan)).toEqual(['pzmr', 'szmr', 'gonogo', 'gorbov', 'memory', 'numseries', 'rdo']);
    expect(plan.segments.at(-1)).toEqual({ module: 'rdo', budgetMs: 180000, purpose: 'finisher', overload: 'finisher' });
  });

  it('the finisher skips modules already in the plan and modules under 3 blocks', () => {
    const states = trained({
      szmr: { lSaved: 0 }, // 1/7 + 1: a reaction pick
      gonogo: { lSaved: 0 }, // 1/7 + 1: a reaction pick
      rdo: { lSaved: 5, lifetimeBlocks: 2 }, // 1/7 + 0.5, not calibrated
      pomeh: { lSaved: 10 }, // 1/7 + 2/7
      stroop: { lastTrainedAt: '2026-10-08' }, // 6/7: the attention pick
    });
    const plan = planTraining(states, TODAY, 1, phaseInfo('overload'));
    expect(modules(plan)).toEqual(['pzmr', 'szmr', 'gonogo', 'stroop', 'memory', 'numseries', 'pomeh']);
    expect(plan.segments.at(-1)).toEqual({ module: 'pomeh', budgetMs: 300000, purpose: 'finisher', overload: 'finisher' });
  });

  it('no finisher when no pool module outside the plan has 3 blocks', () => {
    expect(planTraining(allStates(), TODAY, 1, phaseInfo('development')).segments).toHaveLength(6);
    const two = Object.fromEntries(FINISHER_POOL.map((m) => [m, { lifetimeBlocks: 2 }]));
    expect(planTraining(trained(two), TODAY, 1, phaseInfo('overload')).segments).toHaveLength(6);
  });

  it('overload phase: 6-minute reaction segments and a 5-minute finisher', () => {
    const plan = planTraining(trained(), TODAY, 1, phaseInfo('overload'));
    expect(plan.phase).toBe('overload');
    expect(plan.segments.map((s) => [s.module, s.budgetMs, s.purpose])).toEqual([
      ['pzmr', 120000, 'warmup'],
      ['szmr', 360000, 'reaction'],
      ['gonogo', 360000, 'reaction'],
      ['gorbov', 300000, 'attention'],
      ['memory', 300000, 'attention'],
      ['numseries', 600000, 'logic'],
      ['rdo', 300000, 'finisher'],
    ]);
  });

  it('taper: budgets × 0.6 to 30 s, no finisher, no never-trained modules', () => {
    const states = trained({ stroop: FRESH });
    // Stroop has the highest priority of all and wins the attention slot outside the taper.
    for (const m of MODULE_IDS) {
      if (m !== 'stroop') expect(modulePriority(states.stroop, TODAY)).toBeGreaterThan(modulePriority(states[m], TODAY));
    }
    expect(modules(planTraining(states, TODAY, 1, phaseInfo('development')))[3]).toBe('stroop');
    const plan = planTraining(states, TODAY, 1, phaseInfo('taper'));
    expect(plan.phase).toBe('taper');
    expect(modules(plan)).toEqual(['pzmr', 'szmr', 'gonogo', 'gorbov', 'memory', 'numseries']);
    expect(plan.segments.map((s) => s.budgetMs)).toEqual([60000, 180000, 180000, 180000, 180000, 360000]);
  });

  it('taperBudget: × 0.6 rounded to 30 s, at least 30 s', () => {
    expect([120000, 300000, 360000, 600000, 30000, 1000].map(taperBudget)).toEqual([60000, 180000, 210000, 360000, 30000, 30000]);
  });

  it('taper keeps a slot filled when every pool module is new', () => {
    const allNew = trained(Object.fromEntries([...REACTION_POOL, ...MEMORY_SLOT_POOL].map((m) => [m, FRESH])));
    expect(modules(planTraining(allNew, TODAY, 1, phaseInfo('taper')))).toEqual(['pzmr', 'szmr', 'gonogo', 'gorbov', 'memory', 'numseries']);
    // One trained reaction module takes a slot; the slot left over takes the first module of the pool.
    const oneTrained = trained({ szmr: FRESH, gonogo: FRESH, pomeh: FRESH, pzmr: FRESH });
    expect(reaction(planTraining(oneTrained, TODAY, 1, phaseInfo('taper')))).toEqual(['rdo', 'szmr']);
    const onlySzmr = trained({ gonogo: FRESH, rdo: FRESH, pomeh: FRESH, pzmr: FRESH });
    expect(reaction(planTraining(onlySzmr, TODAY, 1, phaseInfo('taper')))).toEqual(['szmr', 'gonogo']);
    // The memory slot: its pool without the attention pick, in order.
    const onlySchulte = trained({ memory: FRESH, gorbov: FRESH, stroop: FRESH, taskswitch: FRESH });
    expect(modules(planTraining(onlySchulte, TODAY, 1, phaseInfo('taper'))).slice(3, 5)).toEqual(['schulte', 'memory']);
  });

  it('plateau module gets a mixed segment; warm-up never does', () => {
    const plateau = { plateau: true };
    const plan = planTraining(
      trained({ pzmr: plateau, szmr: plateau, gonogo: plateau, rdo: plateau, gorbov: plateau, memory: plateau }),
      TODAY,
      1,
      phaseInfo('development'),
    );
    // rdo ties with szmr and gonogo, loses on pool order and becomes the finisher: a finisher is never a mix.
    expect(plan.segments.map((s) => [s.module, s.overload ?? null])).toEqual([
      ['pzmr', null],
      ['szmr', 'mix'],
      ['gonogo', 'mix'],
      ['gorbov', 'mix'],
      ['memory', 'mix'],
      ['numseries', null],
      ['rdo', 'finisher'],
    ]);
  });

  it('taper: a plateau module gets no overload blocks (the taper cuts the load)', () => {
    const plateau = { plateau: true };
    const plan = planTraining(
      trained({ pzmr: plateau, szmr: plateau, gonogo: plateau, gorbov: plateau, memory: plateau }),
      TODAY,
      1,
      phaseInfo('taper', { daysToTest: 5 }),
    );
    expect(modules(plan)).toEqual(['pzmr', 'szmr', 'gonogo', 'gorbov', 'memory', 'numseries']);
    expect(plan.segments.every((s) => s.overload === undefined)).toBe(true);
  });

  it('REACTION_POOL ends with ПЗМР (F5): at equal priority it is picked last', () => {
    expect(REACTION_POOL).toEqual(['szmr', 'gonogo', 'rdo', 'pomeh', 'pzmr']);
    const atNorm = (m: ModuleId): Partial<ModuleState> => ({ lSaved: L_NORM[m], lastTrainedAt: '2026-10-13' });
    const three = allStates({ szmr: atNorm('szmr'), gonogo: atNorm('gonogo'), rdo: atNorm('rdo') });
    expect(reaction(planTraining(three, TODAY, 1, DEV))).toEqual(['pomeh', 'pzmr']);
    // Trained less recently, ПЗМР wins its slot.
    const all = allStates({ szmr: atNorm('szmr'), gonogo: atNorm('gonogo'), rdo: atNorm('rdo'), pomeh: atNorm('pomeh'), pzmr: atNorm('pzmr') });
    const stale = { ...all, pzmr: { ...all.pzmr, lastTrainedAt: '2026-10-10' } };
    expect(reaction(planTraining(stale, TODAY, 1, DEV))[0]).toBe('pzmr');
  });

  it('warmupLevel = max(0, L_saved − 1)', () => {
    expect(warmupLevel(6)).toBe(5);
    expect(warmupLevel(0.5)).toBe(0);
    expect(warmupLevel(0)).toBe(0);
    expect(warmupLevel(13.5)).toBe(12.5);
  });

  it('reaction slots: the two highest priorities of the reaction pool; ties keep pool order', () => {
    expect(reaction(planTraining(allStates(), TODAY, 1, DEV))).toEqual(['szmr', 'gonogo']);
    const atNorm = (m: ModuleId): Partial<ModuleState> => ({ lSaved: L_NORM[m], lastTrainedAt: '2026-10-13' });
    expect(reaction(planTraining(allStates({ szmr: atNorm('szmr') }), TODAY, 1, DEV))).toEqual(['gonogo', 'rdo']);
    expect(reaction(planTraining(allStates({ szmr: atNorm('szmr'), gonogo: atNorm('gonogo') }), TODAY, 1, DEV))).toEqual(['rdo', 'pomeh']);
  });

  it('orders the two reaction picks by priority descending', () => {
    const plan = planTraining(
      allStates({
        szmr: { lSaved: 12, lastTrainedAt: TODAY },
        gonogo: { lSaved: 5, lastTrainedAt: '2026-10-12' },
        rdo: { lSaved: 0, lastTrainedAt: '2026-10-13' },
        pomeh: { lSaved: 14, lastTrainedAt: TODAY },
        pzmr: { lSaved: 14, lastTrainedAt: TODAY },
      }),
      TODAY,
      1,
      DEV,
    );
    // rdo: 1/7 + 1 ; gonogo: 2/7 + 0.5 ; szmr, pomeh, pzmr: 0
    expect(reaction(plan)).toEqual(['rdo', 'gonogo']);
  });

  it('plateau flag can promote a module', () => {
    const base = { lSaved: 8, lastTrainedAt: '2026-10-13' } as const;
    const norm = { lSaved: 14, lastTrainedAt: TODAY } as const;
    const plan = planTraining(
      allStates({ szmr: { ...base }, gonogo: { ...base }, rdo: { lSaved: 10, lastTrainedAt: TODAY }, pomeh: norm, pzmr: norm }),
      TODAY,
      1,
      DEV,
    );
    expect(reaction(plan)).toEqual(['szmr', 'gonogo']);
    const plateau = planTraining(
      allStates({ szmr: { ...base }, gonogo: { ...base }, rdo: { lSaved: 10, lastTrainedAt: TODAY, plateau: true }, pomeh: norm, pzmr: norm }),
      TODAY,
      1,
      DEV,
    );
    expect(reaction(plateau)).toEqual(['rdo', 'szmr']);
  });

  it('the memory slot takes memory or an attention module, never the attention pick again', () => {
    const plan = planTraining(
      allStates({
        gorbov: { lSaved: 12, lastTrainedAt: TODAY },
        schulte: { lSaved: 6, lastTrainedAt: TODAY },
        taskswitch: { lSaved: 5, lastTrainedAt: TODAY },
        memory: { lSaved: 21, lastTrainedAt: TODAY },
      }),
      TODAY,
      1,
      DEV,
    );
    // stroop (never trained): 2 — attention; then taskswitch 0.375 beats memory (at its L_norm 21, F13), gorbov and
    // schulte (0).
    expect(plan.segments.slice(3, 5)).toEqual([
      { module: 'stroop', budgetMs: 300000, purpose: 'attention' },
      { module: 'taskswitch', budgetMs: 300000, purpose: 'attention' },
    ]);
  });

  it('property: the slots follow the pools and the phase rules, any inputs', () => {
    const st = fc.record({
      lSaved: fc.double({ min: 0, max: 50, noNaN: true }),
      plateau: fc.boolean(),
      last: fc.option(fc.integer({ min: -30, max: 60 }), { nil: null }),
      blocks: fc.integer({ min: 0, max: 5 }),
    });
    const phaseArb = fc.constantFrom<PhaseId>('base', 'development', 'overload', 'taper');
    fc.assert(
      fc.property(fc.array(st, { minLength: MODULE_IDS.length, maxLength: MODULE_IDS.length }), phaseArb, fc.integer(), (xs, ph, seed) => {
        const states = Object.fromEntries(
          MODULE_IDS.map((m, i) => {
            const x = xs[i] as (typeof xs)[number];
            const last = x.last === null ? null : new Date(Date.UTC(2026, 9, 14 - x.last)).toISOString().slice(0, 10);
            return [m, state(m, { lSaved: x.lSaved, plateau: x.plateau, lastTrainedAt: last, lifetimeBlocks: x.blocks })];
          }),
        ) as Record<ModuleId, ModuleState>;
        const plan = planTraining(states, TODAY, seed, phaseInfo(ph));
        const s = plan.segments;
        const [warmup, r1, r2, attention, memorySlot, logic, finisher, ...rest] = s;
        if (!warmup || !r1 || !r2 || !attention || !memorySlot || !logic || rest.length > 0) return false;
        const taper = ph === 'taper';
        const expectBudget = (min: number): number => (taper ? taperBudget(min * 60000) : min * 60000);
        const trainedIn = (pool: readonly ModuleId[]): number => pool.filter((m) => states[m].lifetimeBlocks > 0).length;
        const slotsOk =
          warmup.module === 'pzmr' &&
          warmup.overload === undefined &&
          warmup.budgetMs === expectBudget(2) &&
          logic.module === 'numseries' &&
          logic.overload === undefined &&
          logic.budgetMs === expectBudget(10) &&
          r1.module !== r2.module &&
          [r1, r2].every((r) => REACTION_POOL.includes(r.module) && r.budgetMs === expectBudget(ph === 'overload' ? 6 : 5)) &&
          ATTENTION_POOL.includes(attention.module) &&
          MEMORY_SLOT_POOL.includes(memorySlot.module) &&
          memorySlot.module !== attention.module &&
          [attention, memorySlot].every((a) => a.budgetMs === expectBudget(5)) &&
          [r1, r2, attention, memorySlot].every((x) => (x.overload === 'mix') === (!taper && states[x.module].plateau));
        // Taper: a never-trained module takes a slot only when its pool has too few trained ones (the memory slot's
        // pool without the attention module).
        const taperOk =
          !taper ||
          ((trainedIn(REACTION_POOL) < 2 || [r1, r2].every((r) => states[r.module].lifetimeBlocks > 0)) &&
            (trainedIn(ATTENTION_POOL) < 1 || states[attention.module].lifetimeBlocks > 0) &&
            (trainedIn(MEMORY_SLOT_POOL.filter((m) => m !== attention.module)) < 1 || states[memorySlot.module].lifetimeBlocks > 0));
        const inPlan = new Set(s.slice(0, 6).map((x) => x.module));
        const candidates = FINISHER_POOL.filter((m) => !inPlan.has(m) && states[m].lifetimeBlocks >= 3);
        const finisherOk =
          ph === 'base' || ph === 'taper' || candidates.length === 0
            ? finisher === undefined
            : finisher !== undefined &&
              candidates.includes(finisher.module) &&
              finisher.purpose === 'finisher' &&
              finisher.overload === 'finisher' &&
              finisher.budgetMs === (ph === 'overload' ? 300000 : 180000) &&
              candidates.every((m) => modulePriority(states[m], TODAY) <= modulePriority(states[finisher.module], TODAY));
        return plan.seed === seed && plan.phase === ph && slotsOk && taperOk && finisherOk;
      }),
      { numRuns: 1000 },
    );
  });
});

describe('test-format runs (F4)', () => {
  /** Local noon `d` days before TODAY: a stored block's startedAt. */
  const ago = (d: number): string => new Date(2026, 9, 14 - d, 12, 0).toISOString();
  const runs = (...days: number[]): string[] => days.map(ago);
  const day = (dayNumber: number, phase: PhaseId = 'development'): PhaseInfo => phaseInfo(phase, { dayNumber });
  const purposes = (plan: SessionPlan): string[] => plan.segments.map((s) => s.purpose);

  it('the formats, their order, the first day and the minutes of the plan line', () => {
    expect(TEST_FORMAT_ORDER).toEqual(['pzmr', 'szmr', 'gonogo', 'rdo']);
    expect(TEST_FORMAT_FROM_DAY).toBe(15);
    expect(TEST_FORMAT_MINUTES).toEqual({ pzmr: 2, szmr: 3, gonogo: 3, rdo: 3 });
  });

  it('no run before day 15', () => {
    expect(testFormatDue([], 14, TODAY)).toBe(false);
    expect(planTraining(trained(), TODAY, 1, day(14, 'base'), runsOf([])).segments.some((s) => s.purpose === 'test_format')).toBe(false);
    expect(testFormatDue([], 15, TODAY)).toBe(true);
  });

  it('day 15 without runs: a ПЗМР run comes first, no warm-up, one reaction slot without ПЗМР', () => {
    // ПЗМР trained long ago: it would win a reaction slot without the run.
    const states = trained({ pzmr: { lastTrainedAt: '2026-09-01' } });
    expect(planTraining(states, TODAY, 1, day(14)).segments[1]).toMatchObject({ module: 'pzmr', purpose: 'reaction' });
    const plan = planTraining(states, TODAY, 1, day(15), runsOf([]));
    expect(plan.segments[0]).toEqual({ module: 'pzmr', budgetMs: 0, purpose: 'test_format', trialCount: 50, practiceTrials: 5 });
    expect(purposes(plan)).not.toContain('warmup');
    const reaction = plan.segments.filter((s) => s.purpose === 'reaction');
    expect(reaction).toHaveLength(1);
    expect(reaction[0]?.module).not.toBe('pzmr');
    expect(purposes(plan)).toEqual(['test_format', 'reaction', 'attention', 'attention', 'logic', 'finisher']);
  });

  it('rotation by the number of stored runs', () => {
    const at = (n: number): SessionPlan =>
      planTraining(trained(), TODAY, 1, day(40), runsOf(Array.from({ length: n }, (_, i) => ago(30 + i))));
    const run = (n: number) => at(n).segments[0];
    expect(run(1)).toEqual({ module: 'szmr', budgetMs: 0, purpose: 'test_format', trialCount: 70, practiceTrials: 5 });
    expect(run(2)).toEqual({ module: 'gonogo', budgetMs: 0, purpose: 'test_format', trialCount: 60, practiceTrials: 5 });
    expect(run(3)).toEqual({ module: 'rdo', budgetMs: 0, purpose: 'test_format', trialCount: 50, practiceTrials: 5 });
    expect(run(4)).toEqual({ module: 'pzmr', budgetMs: 0, purpose: 'test_format', trialCount: 50, practiceTrials: 5 });
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => nextTestFormat(runs(...Array.from({ length: n }, (_, i) => 30 + i))))).toEqual([
      'pzmr',
      'szmr',
      'gonogo',
      'rdo',
      'pzmr',
      'szmr',
      'szmr',
    ]);
    // A СЗМР run: the ПЗМР warm-up follows it, and the reaction slot left is not СЗМР.
    const szmrDay = at(1);
    expect(szmrDay.segments[1]).toEqual({ module: 'pzmr', budgetMs: 120000, purpose: 'warmup' });
    expect(szmrDay.segments.filter((s) => s.purpose === 'reaction').map((s) => s.module)).toEqual(['gonogo']);
  });

  it('at most 2 runs in 7 days, at least 3 days apart', () => {
    expect(testFormatDue(runs(6, 3), 30, TODAY)).toBe(false);
    expect(testFormatDue(runs(7, 3), 30, TODAY)).toBe(true);
    expect(testFormatDue(runs(2), 30, TODAY)).toBe(false);
    expect(testFormatDue(runs(3), 30, TODAY)).toBe(true);
    // A run today, or one stored on a later date (a clock moved back), is never 3 days ago.
    expect(testFormatDue(runs(0), 30, TODAY)).toBe(false);
    expect(testFormatDue(runs(-2), 30, TODAY)).toBe(false);
    // The order of the list does not matter.
    expect(testFormatDue(runs(3, 20, 10), 30, TODAY)).toBe(true);
    expect(testFormatDue(runs(2, 20, 10), 30, TODAY)).toBe(false);
    const plan = (r: string[]): string[] => purposes(planTraining(trained(), TODAY, 1, day(30), runsOf(r)));
    expect(plan(runs(6, 3))[0]).toBe('warmup');
    expect(plan(runs(7, 3))[0]).toBe('test_format');
    // Without extras the plan has no run (the simulations and tests that plan without the history).
    expect(purposes(planTraining(trained(), TODAY, 1, day(30)))[0]).toBe('warmup');
  });

  it('the taper keeps the runs', () => {
    const taper = phaseInfo('taper', { dayNumber: 40, daysToTest: 5 });
    const plan = planTraining(trained(), TODAY, 1, taper, runsOf(runs(10)));
    // The run keeps its volume; the other budgets are cut.
    expect(plan.segments.map((s) => [s.module, s.purpose, s.budgetMs])).toEqual([
      ['szmr', 'test_format', 0],
      ['pzmr', 'warmup', 60000],
      ['gonogo', 'reaction', 180000],
      ['gorbov', 'attention', 180000],
      ['memory', 'attention', 180000],
      ['numseries', 'logic', 360000],
    ]);
    expect(plan.segments[0]).toMatchObject({ trialCount: 70, practiceTrials: 5 });
  });

  it('the finisher never takes the run\'s module', () => {
    // РДО is the finisher of this plan without a run (see «development: finisher…»).
    expect(planTraining(trained(), TODAY, 1, day(30)).segments.at(-1)).toMatchObject({ module: 'rdo', purpose: 'finisher' });
    const plan = planTraining(trained(), TODAY, 1, day(30), runsOf(runs(30, 29, 28)));
    expect(plan.segments[0]).toMatchObject({ module: 'rdo', purpose: 'test_format' });
    const finisher = plan.segments.at(-1);
    expect(finisher?.purpose).toBe('finisher');
    expect(finisher?.module).not.toBe('rdo');
    expect(plan.segments.filter((s) => s.module === 'rdo')).toHaveLength(1);
  });

  it('property: a run is the first segment exactly when it is due; its module is in no other slot', () => {
    const phaseArb = fc.constantFrom<PhaseId>('base', 'development', 'overload', 'taper');
    const agoArb = fc.array(fc.integer({ min: -3, max: 40 }), { maxLength: 12 });
    fc.assert(
      fc.property(phaseArb, fc.integer({ min: 1, max: 120 }), agoArb, fc.boolean(), (ph, dayNumber, days, plateau) => {
        const states = trained({ szmr: { plateau }, rdo: { plateau } });
        const r = runs(...days);
        const plan = planTraining(states, TODAY, 1, phaseInfo(ph, { dayNumber }), runsOf(r));
        const due = testFormatDue(r, dayNumber, TODAY);
        const [first, ...rest] = plan.segments;
        if (first === undefined) return false;
        if (!due) return first.purpose === 'warmup' && rest.every((s) => s.purpose !== 'test_format');
        const module = nextTestFormat(r);
        const warmups = rest.filter((s) => s.purpose === 'warmup');
        return (
          first.module === module &&
          first.purpose === 'test_format' &&
          first.overload === undefined &&
          rest.every((s) => s.module !== module) &&
          warmups.length === (module === 'pzmr' ? 0 : 1) &&
          rest.filter((s) => s.purpose === 'reaction').length === 1
        );
      }),
      { numRuns: 1000 },
    );
  });
});

describe('isRehearsalDue', () => {
  const TEST = '2026-10-19';
  const TAPER = phaseInfo('taper', { daysToTest: 5 });

  it('in the taper: due without diagnostics and 2+ days after the last one, until two fall in the last 9 days', () => {
    expect(isRehearsalDue(TAPER, [], TEST, TODAY)).toBe(true);
    expect(isRehearsalDue(TAPER, ['2026-10-13T20:00:00'], TEST, TODAY)).toBe(false);
    expect(isRehearsalDue(TAPER, ['2026-10-12T23:59:00'], TEST, TODAY)).toBe(true);
    expect(isRehearsalDue(TAPER, ['2026-10-11T09:00:00'], TEST, TODAY)).toBe(true);
    expect(isRehearsalDue(TAPER, ['2026-10-10T09:00:00', '2026-10-11T09:00:00'], TEST, TODAY)).toBe(false);
  });

  it('diagnostics before the 9-day window are not rehearsals', () => {
    // The window opens on 2026-10-10 (test date − 9 days).
    expect(isRehearsalDue(TAPER, ['2026-10-01T09:00:00', '2026-10-09T09:00:00', '2026-10-11T09:00:00'], TEST, TODAY)).toBe(true);
    expect(isRehearsalDue(TAPER, ['2026-10-09T09:00:00'], TEST, TODAY)).toBe(true);
  });

  it('the latest diagnostic counts whatever the order of the list', () => {
    expect(isRehearsalDue(TAPER, ['2026-10-13T09:00:00', '2026-09-01T09:00:00'], TEST, TODAY)).toBe(false);
  });

  it('never due outside the taper or without a test date', () => {
    for (const ph of ['base', 'development', 'overload'] as const) {
      expect(isRehearsalDue(phaseInfo(ph), [], TEST, TODAY)).toBe(false);
    }
    expect(isRehearsalDue(TAPER, [], null, TODAY)).toBe(false);
  });
});

describe('the layout of the day (F9)', () => {
  it('planTraining plays dayLayout of its training day, not of its calendar day (T-R64); without extras it names none', () => {
    const plan = (trainingDay: number, extras: Partial<TrainingExtras> = {}, dayNumber = 30) =>
      planTraining(trained(), TODAY, 1, phaseInfo('development', { dayNumber }), { ...runsOf([]), trainingDay, ...extras }).layout;
    expect([1, 2, 3, 4].map((n) => plan(n))).toEqual(['keyboard', 'pult', 'keyboard', 'mouse']);
    // The calendar day does not matter: course day 31 as training day 1 plays the primary.
    expect([29, 30, 31, 32].map((d) => plan(1, {}, d))).toEqual(['keyboard', 'keyboard', 'keyboard', 'keyboard']);
    expect([2, 4].map((n) => plan(n, { layout: 'mouse' }))).toEqual(['keyboard', 'pult']);
    expect(plan(2, { layoutRotation: false })).toBe('keyboard');
    expect(planTraining(trained(), TODAY, 1, phaseInfo('taper', { dayNumber: 30, daysToTest: 3 }), { ...runsOf([]), trainingDay: 2 }).layout).toBe('keyboard');
    expect(planTraining(trained(), TODAY, 1, DEV)).not.toHaveProperty('layout');
  });

  it('planFree with the layout plays dayLayout of the training day; without a phase, the primary', () => {
    const at = (trainingDay: number, rotation = true) => ({ primary: 'keyboard' as const, rotation, trainingDay });
    expect(planFree('szmr', 7, phaseInfo('development', { dayNumber: 3 }), at(2)).layout).toBe('pult');
    expect(planFree('szmr', 7, phaseInfo('development', { dayNumber: 2 }), at(3)).layout).toBe('keyboard');
    expect(planFree('szmr', 7, phaseInfo('development', { dayNumber: 2 }), at(2, false)).layout).toBe('keyboard');
    expect(planFree('szmr', 7, phaseInfo('taper', { dayNumber: 30, daysToTest: 2 }), at(4)).layout).toBe('keyboard');
    expect(planFree('szmr', 7, undefined, { primary: 'mouse', rotation: true, trainingDay: 2 }).layout).toBe('mouse');
    expect(planFree('szmr', 7, DEV)).not.toHaveProperty('layout');
  });
});

describe('planFree', () => {
  it('is a single 5-minute free segment', () => {
    expect(planFree('rdo', 7)).toEqual({
      kind: 'free',
      seed: 7,
      segments: [{ module: 'rdo', budgetMs: 300000, purpose: 'free' }],
    });
  });

  it('carries the mark rate of the phase of the day; without a phase, none (F15)', () => {
    expect(planFree('szmr', 7, phaseInfo('base')).feedback).toBe('every');
    expect(planFree('szmr', 7, DEV).feedback).toBe('half');
    expect(planFree('szmr', 7, phaseInfo('taper'))).toEqual({ ...planFree('szmr', 7), feedback: 'none' });
    expect(planFree('szmr', 7)).not.toHaveProperty('feedback');
  });
});

describe('the mark after a trial by phase (F15)', () => {
  it('every trial in «База», half in «Развитие», none in «Перегрузка» and «Подводка»', () => {
    expect(feedbackRate('base')).toBe('every');
    expect(feedbackRate('development')).toBe('half');
    expect(feedbackRate('overload')).toBe('none');
    expect(feedbackRate('taper')).toBe('none');
  });

  it('a training plan carries the rate of its phase', () => {
    for (const phase of ['base', 'development', 'overload', 'taper'] as const) {
      expect(planTraining(allStates(), TODAY, 42, phaseInfo(phase)).feedback, phase).toBe(feedbackRate(phase));
    }
  });
});

describe('isDiagnosticDue', () => {
  it('is due when never done', () => {
    expect(isDiagnosticDue(null, '2026-10-14')).toBe(true);
  });
  it('is not due after 13 days, due after 14', () => {
    expect(isDiagnosticDue('2026-10-01', '2026-10-14')).toBe(false);
    expect(isDiagnosticDue('2026-09-30', '2026-10-14')).toBe(true);
    expect(isDiagnosticDue('2026-10-14', '2026-10-14')).toBe(false);
  });
  it('accepts datetime strings', () => {
    expect(isDiagnosticDue(new Date(2026, 8, 30, 20, 0).toISOString(), '2026-10-14')).toBe(true);
    expect(isDiagnosticDue(new Date(2026, 9, 1, 8, 0).toISOString(), '2026-10-14')).toBe(false);
  });
});
