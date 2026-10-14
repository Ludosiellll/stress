import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../data/memoryRepository';
import { session } from '../data/repository.contract';
import type { DiagnosticRow } from '../data/rows';
import { diagnosticSegmentSeed, type DiagnosticResults } from '../engine/diagnostic';
import { loadHomeModel, parseResults, readinessOf } from './homeModel';

const EMPTY: DiagnosticResults = {
  pzmrMedianRt: null,
  szmrMedianRt: null,
  gonogoScore: null,
  rdoMeanAbsErrorMs: null,
  gorbov: null,
  numseriesCorrect: null,
  unreliable: [],
};

function row(number: number, results: Partial<DiagnosticResults> | string): DiagnosticRow {
  const resultsJson = typeof results === 'string' ? results : JSON.stringify({ ...EMPTY, ...results });
  return { id: `d${String(number)}`, sessionId: `s${String(number)}`, number, at: `2026-10-0${String(number)}T10:00:00.000Z`, resultsJson };
}

describe('parseResults', () => {
  it('reads rows stored before `unreliable` existed as reliable', () => {
    const old = Object.fromEntries(Object.entries({ ...EMPTY, pzmrMedianRt: 300 }).filter(([k]) => k !== 'unreliable'));
    expect(parseResults(row(1, JSON.stringify(old)))).toEqual({ ...EMPTY, pzmrMedianRt: 300, unreliable: [] });
  });

  it('a missing metric reads as null', () => {
    expect(parseResults(row(1, '{}'))).toEqual(EMPTY);
  });

  it('keeps only reaction module ids in `unreliable`', () => {
    expect(parseResults(row(1, JSON.stringify({ ...EMPTY, unreliable: ['rdo', 'gorbov', 7, 'pzmr'] })))?.unreliable).toEqual(['rdo', 'pzmr']);
  });

  it('null for JSON that is not an object', () => {
    expect(parseResults(row(1, 'not json'))).toBeNull();
    expect(parseResults(row(1, '42'))).toBeNull();
  });
});

describe('readinessOf', () => {
  it('null before the first diagnostic', () => {
    expect(readinessOf([])).toBeNull();
  });

  it('carries the unreliable modules of the latest diagnostic (I1)', () => {
    expect(readinessOf([row(1, { pzmrMedianRt: 300, unreliable: ['pzmr'] })])?.unreliable).toEqual(['pzmr']);
    expect(readinessOf([row(1, { unreliable: ['pzmr'] }), row(2, { pzmrMedianRt: 300 })])?.unreliable).toEqual([]);
  });

  it('no abilities when the latest row cannot be read', () => {
    expect(readinessOf([row(1, { pzmrMedianRt: 300 }), row(2, 'broken')])).toEqual({
      abilities: { reaction: null, attention: null, switching: null, memory: null, logic: null },
      overall: null,
      unreliable: [],
    });
  });
});

describe('loadHomeModel', () => {
  const TODAY = '2026-10-14';

  it('an abandoned diagnostic: the next one keeps its number but gets new seeds (I5)', async () => {
    const repo = new MemoryRepository();
    expect((await loadHomeModel(repo, TODAY)).diagnosticPlan).toMatchObject({ diagnosticNumber: 1, diagnosticSeedIndex: 1 });
    await repo.createSession(session('abandoned', '2026-10-13T10:00:00.000Z', { kind: 'diagnostic' }));
    const plan = (await loadHomeModel(repo, TODAY)).diagnosticPlan;
    expect(plan).toMatchObject({ diagnosticNumber: 1, diagnosticSeedIndex: 2 });
    expect(diagnosticSegmentSeed(plan.diagnosticSeedIndex ?? 0, 'gorbov')).not.toBe(diagnosticSegmentSeed(1, 'gorbov'));
    expect(diagnosticSegmentSeed(plan.diagnosticSeedIndex ?? 0, 'numseries')).not.toBe(diagnosticSegmentSeed(1, 'numseries'));
  });
});
