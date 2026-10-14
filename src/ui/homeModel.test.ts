import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../data/memoryRepository';
import { block, session } from '../data/repository.contract';
import type { DiagnosticRow } from '../data/rows';
import { diagnosticSegmentSeed, type DiagnosticResults } from '../engine/diagnostic';
import { readiness } from '../engine/readiness';
import { loadHomeModel, mergedBaseline, parseResults, readinessOf } from './homeModel';

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

describe('mergedBaseline (M2)', () => {
  it('takes every metric from the first diagnostic that has it', () => {
    const merged = mergedBaseline([
      { ...EMPTY, pzmrMedianRt: 320 },
      { ...EMPTY, pzmrMedianRt: 300, rdoMeanAbsErrorMs: 40, gorbov: { V: 40, P: 80, Pi: 20 } },
      { ...EMPTY, pzmrMedianRt: 280, rdoMeanAbsErrorMs: 30, numseriesCorrect: 12 },
    ]);
    expect(merged).toEqual({
      pzmrMedianRt: 320,
      szmrMedianRt: null,
      gonogoScore: null,
      rdoMeanAbsErrorMs: 40,
      gorbov: { V: 40, P: 80, Pi: 20 },
      numseriesCorrect: 12,
    });
  });
});

describe('readinessOf', () => {
  it('null before the first diagnostic', () => {
    expect(readinessOf([])).toBeNull();
  });

  it('a metric missing in the first diagnostic gets its baseline from a later one (M2)', () => {
    const first = row(1, { pzmrMedianRt: 300 });
    const second = row(2, { pzmrMedianRt: 300, rdoMeanAbsErrorMs: 40 });
    const third = row(3, { pzmrMedianRt: 300, rdoMeanAbsErrorMs: 30 });
    const r = readinessOf([first, second, third]);
    const expected = readiness({ ...EMPTY, pzmrMedianRt: 300, rdoMeanAbsErrorMs: 30 }, { ...EMPTY, pzmrMedianRt: 300, rdoMeanAbsErrorMs: 40 });
    expect(r?.abilities).toEqual(expected.abilities);
    // rdo 30 vs its own baseline 40 → better than 60.
    expect(r?.abilities.reaction).toBeGreaterThan(60);
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

  it('counts a training day whose session has stored blocks even without an end (M1)', async () => {
    const repo = new MemoryRepository();
    // Yesterday: finished normally. Today: all blocks stored, but the session end was never written.
    await repo.createSession(session('y', '2026-10-13T10:00:00', { endedAt: '2026-10-13T10:40:00' }));
    await repo.createSession(session('t', '2026-10-14T10:00:00'));
    await repo.addBlock(block('b1', 't', '2026-10-14T10:01:00', { module: 'gorbov' }), [], []);
    // A training session with no block and no end (closed on the first instruction) does not count.
    await repo.createSession(session('empty', '2026-10-12T10:00:00'));
    expect((await loadHomeModel(repo, TODAY)).streak).toBe(2);
  });
});
