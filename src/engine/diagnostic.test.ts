import { describe, expect, it } from 'vitest';
import { diagnosticSegmentSeed, diagnosticSeriesSchedule, planDiagnostic } from './diagnostic';
import { hashString } from './rng';

/** The six segments of the 0.1.0 diagnostic, as 0.1.0 played them (order, fixedL, volumes). */
const W1_SEGMENTS = [
  { module: 'pzmr', budgetMs: 0, purpose: 'diagnostic', fixedL: 0, trialCount: 50, practiceTrials: 5 },
  { module: 'szmr', budgetMs: 0, purpose: 'diagnostic', fixedL: 0, trialCount: 70, practiceTrials: 5 },
  { module: 'gonogo', budgetMs: 0, purpose: 'diagnostic', fixedL: 10, trialCount: 60, practiceTrials: 5 },
  { module: 'rdo', budgetMs: 0, purpose: 'diagnostic', fixedL: 0, trialCount: 50, practiceTrials: 5 },
  { module: 'gorbov', budgetMs: 0, purpose: 'diagnostic', fixedL: 0, runs: 3 },
  { module: 'numseries', budgetMs: 0, purpose: 'diagnostic', items: 20, totalTimeLimitMs: 600000 },
];

describe('planDiagnostic', () => {
  it('W1 segments are unchanged', () => {
    const plan = planDiagnostic(3);
    expect(plan.kind).toBe('diagnostic');
    expect(plan.diagnosticNumber).toBe(3);
    expect(plan.seed).toBe(hashString('diag:3'));
    expect(plan.segments.slice(0, 6)).toEqual(W1_SEGMENTS);
    // Block seeds hash the number and the module only, so the W1 tables and series of diagnostic n stay the same.
    expect(diagnosticSegmentSeed(3, 'gorbov')).toBe(hashString('diag:3:gorbov'));
  });

  it('the W2 segments follow the number series (П8)', () => {
    expect(planDiagnostic(3).segments.slice(6)).toEqual([
      { module: 'pomeh', budgetMs: 0, purpose: 'diagnostic', fixedL: 8, trialCount: 40, practiceTrials: 5 },
      { module: 'stroop', budgetMs: 0, purpose: 'diagnostic', fixedL: 8, trialCount: 48, practiceTrials: 5 },
      { module: 'taskswitch', budgetMs: 0, purpose: 'diagnostic', fixedL: 5, trialCount: 48, practiceTrials: 5 },
      { module: 'memory', budgetMs: 0, purpose: 'diagnostic' },
    ]);
  });

  it('takes its seeds from seedIndex, which defaults to the number (I5)', () => {
    expect(planDiagnostic(3)).toMatchObject({ diagnosticNumber: 3, diagnosticSeedIndex: 3 });
    const later = planDiagnostic(2, 5);
    expect(later).toMatchObject({ diagnosticNumber: 2, diagnosticSeedIndex: 5, seed: hashString('diag:5') });
    expect(later.segments).toEqual(planDiagnostic(2).segments);
  });

  it('is deterministic and number-dependent', () => {
    expect(planDiagnostic(1)).toEqual(planDiagnostic(1));
    expect(planDiagnostic(1).seed).not.toBe(planDiagnostic(2).seed);
  });
});

describe('diagnosticSegmentSeed', () => {
  it('hashes diag:n:module', () => {
    expect(diagnosticSegmentSeed(3, 'rdo')).toBe(hashString('diag:3:rdo'));
    expect(diagnosticSegmentSeed(3, 'rdo')).not.toBe(diagnosticSegmentSeed(3, 'szmr'));
  });
});

describe('diagnosticSeriesSchedule', () => {
  it('has 20 entries cycling the 8 families with rising target difficulty', () => {
    const s = diagnosticSeriesSchedule();
    expect(s).toHaveLength(20);
    const order = ['arith', 'geom', 'second', 'alt', 'fib', 'linrec', 'powers', 'opcycle'];
    s.forEach((e, i) => {
      expect(e.family).toBe(order[i % 8]);
      expect(e.targetD).toBe(900 + 30 * i);
    });
    expect(s[19]).toEqual({ family: 'alt', targetD: 1470 });
  });
});
