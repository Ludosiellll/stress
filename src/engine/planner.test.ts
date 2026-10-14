import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  L_NORM,
  daysBetween,
  isDiagnosticDue,
  modulePriority,
  planFree,
  planTraining,
  type ModuleState,
} from './planner';
import type { ModuleId } from './types';

const MODULES: ModuleId[] = ['pzmr', 'szmr', 'gonogo', 'rdo', 'gorbov', 'schulte', 'numseries'];

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
  Object.fromEntries(MODULES.map((m) => [m, state(m, over[m])])) as Record<ModuleId, ModuleState>;

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

describe('modulePriority', () => {
  it('sums recency, weakness and plateau terms', () => {
    const s = state('pzmr', { lSaved: 7, lastTrainedAt: '2026-10-11', plateau: true });
    // 3/7 + (1 - 7/14) + 0.5
    expect(modulePriority(s, '2026-10-14')).toBeCloseTo(3 / 7 + 0.5 + 0.5, 12);
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
  it('with no history yields the fixed W1 segment list', () => {
    const plan = planTraining(allStates(), '2026-10-14', 42);
    expect(plan.kind).toBe('training');
    expect(plan.seed).toBe(42);
    expect(plan.segments.map((s) => [s.module, s.budgetMs])).toEqual([
      ['pzmr', 120000],
      ['szmr', 300000],
      ['gonogo', 300000],
      ['gorbov', 360000],
      ['schulte', 240000],
      ['numseries', 600000],
    ]);
    expect(plan.segments.map((s) => s.purpose)).toEqual([
      'warmup',
      'reaction',
      'reaction',
      'attention',
      'attention',
      'logic',
    ]);
  });

  it('picks gonogo and rdo when szmr is at norm and was trained yesterday', () => {
    const plan = planTraining(
      allStates({ szmr: { lSaved: L_NORM.szmr, lastTrainedAt: '2026-10-13' } }),
      '2026-10-14',
      1,
    );
    expect(plan.segments.slice(1, 3).map((s) => s.module)).toEqual(['gonogo', 'rdo']);
  });

  it('orders the two reaction picks by priority descending', () => {
    const plan = planTraining(
      allStates({
        szmr: { lSaved: 12, lastTrainedAt: '2026-10-14' },
        gonogo: { lSaved: 5, lastTrainedAt: '2026-10-12' },
        rdo: { lSaved: 0, lastTrainedAt: '2026-10-13' },
      }),
      '2026-10-14',
      1,
    );
    // rdo: 1/7 + 1 ; gonogo: 2/7 + 0.5 ; szmr: 0
    expect(plan.segments.slice(1, 3).map((s) => s.module)).toEqual(['rdo', 'gonogo']);
  });

  it('plateau flag can promote a module', () => {
    const base = { lSaved: 8, lastTrainedAt: '2026-10-13' } as const;
    const plan = planTraining(
      allStates({
        szmr: { ...base },
        gonogo: { ...base },
        rdo: { lSaved: 10, lastTrainedAt: '2026-10-14' },
      }),
      '2026-10-14',
      1,
    );
    expect(plan.segments.slice(1, 3).map((s) => s.module)).toEqual(['szmr', 'gonogo']);
    const plateau = planTraining(
      allStates({
        szmr: { ...base },
        gonogo: { ...base },
        rdo: { lSaved: 10, lastTrainedAt: '2026-10-14', plateau: true },
      }),
      '2026-10-14',
      1,
    );
    expect(plateau.segments.slice(1, 3).map((s) => s.module)).toEqual(['rdo', 'szmr']);
  });

  it('keeps stable tie order szmr, gonogo, rdo', () => {
    const tied = planTraining(allStates(), '2026-10-14', 1);
    expect(tied.segments.slice(1, 3).map((s) => s.module)).toEqual(['szmr', 'gonogo']);
    const plan = planTraining(allStates({ szmr: { lSaved: 12, lastTrainedAt: '2026-10-14' } }), '2026-10-14', 1);
    expect(plan.segments.slice(1, 3).map((s) => s.module)).toEqual(['gonogo', 'rdo']);
  });

  it('property: always 6 segments, 2 distinct reaction modules, any inputs', () => {
    const st = fc.record({
      lSaved: fc.double({ min: 0, max: 50, noNaN: true }),
      plateau: fc.boolean(),
      last: fc.option(fc.integer({ min: -30, max: 60 }), { nil: null }),
    });
    fc.assert(
      fc.property(st, st, st, st, fc.integer(), (a, b, c, d, seed) => {
        const mk = (m: ModuleId, x: { lSaved: number; plateau: boolean; last: number | null }): ModuleState =>
          state(m, {
            lSaved: x.lSaved,
            plateau: x.plateau,
            lastTrainedAt:
              x.last === null ? null : new Date(Date.UTC(2026, 9, 14 - x.last)).toISOString().slice(0, 10),
          });
        const states = allStates({ szmr: mk('szmr', a), gonogo: mk('gonogo', b), rdo: mk('rdo', c), pzmr: mk('pzmr', d) });
        const plan = planTraining(states, '2026-10-14', seed);
        const react = plan.segments.slice(1, 3).map((s) => s.module);
        return (
          plan.segments.length === 6 &&
          plan.seed === seed &&
          new Set(react).size === 2 &&
          react.every((m) => m === 'szmr' || m === 'gonogo' || m === 'rdo')
        );
      }),
      { numRuns: 1000 },
    );
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
