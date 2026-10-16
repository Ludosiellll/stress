import { describe, expect, it } from 'vitest';
import type { BlockRow, DiagnosticRow } from '../data/rows';
import { block, session } from '../data/repository.contract';
import { MemoryRepository } from '../data/memoryRepository';
import { rebuildCaches } from '../data/export';
import { MODULE_IDS, type BlockFlag } from '../engine/types';
import { parseResults, type DiagnosticResults } from '../engine/diagnostic';
import { readinessOfLatest } from '../engine/readiness';
import { trend, type Trend } from '../engine/trend';
import { pastBlocks } from '../session/pastBlocks';
import {
  diagnosticCharts,
  discardWeeks,
  durationText,
  formOfDayPoints,
  indexChart,
  loadProgressModel,
  overload28d,
  rdoBias,
  readaptCosts,
  ruDate,
  sessionLines,
  SESSION_LINES,
  NO_TREND,
  trendText,
  trendView,
} from './progressModel';

function row(number: number, results: unknown): DiagnosticRow {
  return { id: `d${String(number)}`, sessionId: 's', number, at: '2026-10-01T10:00:00.000Z', resultsJson: typeof results === 'string' ? results : JSON.stringify(results) };
}

const full = { pzmrMedianRt: 300, szmrMedianRt: 420, gonogoScore: 85, rdoMeanAbsErrorMs: 55, gorbov: { V: 40, P: 80, Pi: 12 }, numseriesCorrect: 12 };
const fullW2 = { ...full, pomehDeltaMs: 35, stroopInterferenceMs: 90, switchCostMs: -10, memorySpan: 7 };

describe('diagnosticCharts', () => {
  it('makes ten charts with the metrics of every diagnostic', () => {
    const charts = diagnosticCharts([row(1, full), row(2, { ...full, pzmrMedianRt: 290, gonogoScore: 90 })]);
    expect(charts.map((c) => c.id)).toEqual(['pzmr', 'szmr', 'gonogo', 'rdo', 'gorbov', 'numseries', 'pomeh', 'stroop', 'taskswitch', 'memory']);
    expect(charts[0]?.series[0]?.points).toEqual([{ x: '№1', y: 300 }, { x: '№2', y: 290 }]);
    expect(charts[2]?.series[0]?.points.map((p) => p.y)).toEqual([85, 90]);
    expect(charts.map((c) => c.lowerIsBetter)).toEqual([true, true, false, true, true, false, true, true, true, false]);
    expect(charts[4]?.series.map((s) => s.name)).toEqual(['V', 'P', 'Π']);
    expect(charts[4]?.series.map((s) => s.points[0]?.y)).toEqual([40, 80, 12]);
  });

  it('numbers shared after a restore merge get the date, so no x label shows twice (B8)', () => {
    const at = (n: number, iso: string): DiagnosticRow => ({ ...row(n, full), id: `d${iso}`, at: iso });
    const xs = (rows: DiagnosticRow[]): string[] => diagnosticCharts(rows)[0]?.series[0]?.points.map((p) => p.x) ?? [];
    expect(xs([at(1, '2026-09-01T10:00:00'), at(1, '2026-10-05T10:00:00'), at(2, '2026-10-19T10:00:00')])).toEqual([
      '№1 (01.09)',
      '№1 (05.10)',
      '№2',
    ]);
    // The same number on the same day: the time tells them apart.
    expect(xs([at(1, '2026-10-01T09:30:00'), at(1, '2026-10-01T18:05:00')])).toEqual(['№1 (01.10 09:30)', '№1 (01.10 18:05)']);
    // The unreliable list names the point the same way.
    const shaky = { ...row(1, { ...full, unreliable: ['pzmr'] }), id: 'x', at: '2026-10-05T10:00:00' };
    expect(diagnosticCharts([at(1, '2026-09-01T10:00:00'), shaky])[0]?.unreliable).toEqual(['№1 (05.10)']);
  });

  it('bounds every axis by what the metric can take; Π of Gorbov and the differences can be negative', () => {
    const domains = Object.fromEntries(diagnosticCharts([]).map((c) => [c.id, c.domain]));
    expect(domains).toEqual({
      pzmr: { min: 0 },
      szmr: { min: 0 },
      gonogo: { min: 0, max: 100 },
      rdo: { min: 0 },
      gorbov: {},
      numseries: { min: 0 },
      pomeh: {},
      stroop: {},
      taskswitch: {},
      memory: { min: 0 },
    });
  });

  it('charts in whole units (ms, %, counts) round as the results table; Gorbov seconds keep a decimal (B6)', () => {
    const whole = Object.fromEntries(diagnosticCharts([]).map((c) => [c.id, c.whole]));
    expect(whole).toEqual({
      pzmr: true,
      szmr: true,
      gonogo: true,
      rdo: true,
      gorbov: false,
      numseries: true,
      pomeh: true,
      stroop: true,
      taskswitch: true,
      memory: true,
    });
  });

  it('a difference reads as on Done and in the block summary: from the rounded medians (B9)', () => {
    const r = { ...fullW2, stroopCongruentRt: 520.5, stroopIncongruentRt: 610, stroopInterferenceMs: 89.5 };
    const stroop = diagnosticCharts([row(1, r)]).find((c) => c.id === 'stroop');
    expect(stroop?.series[0]?.points[0]?.y).toBe(89);
    // Without the medians (stored before they were), the stored cost.
    expect(diagnosticCharts([row(1, fullW2)]).find((c) => c.id === 'stroop')?.series[0]?.points[0]?.y).toBe(90);
  });

  it('the four W2 charts: differences and the span; gaps for 0.1.0 rows', () => {
    const charts = diagnosticCharts([row(1, full), row(2, fullW2), row(3, { ...fullW2, unreliable: ['taskswitch'] })]);
    const byId = Object.fromEntries(charts.map((c) => [c.id, c]));
    expect(charts.slice(6).map((c) => [c.title, c.yLabel])).toEqual([
      ['Помехоустойчивость: разница, мс', 'мс'],
      ['Струп: интерференция, мс', 'мс'],
      ['Переключение правил: цена переключения, мс', 'мс'],
      ['Память: объём', 'цифр'],
    ]);
    expect(byId.pomeh?.series[0]?.points.map((p) => p.y)).toEqual([null, 35, 35]);
    expect(byId.stroop?.series[0]?.points.map((p) => p.y)).toEqual([null, 90, 90]);
    expect(byId.taskswitch?.series[0]?.points).toEqual([
      { x: '№1', y: null },
      { x: '№2', y: -10 },
      { x: '№3', y: -10, note: 'замер ненадёжен' },
    ]);
    expect(byId.taskswitch?.unreliable).toEqual(['№3']);
    expect(byId.memory?.series[0]?.points.map((p) => p.y)).toEqual([null, 7, 7]);
  });

  it('turns missing and non-finite values and unreadable rows into gaps, never zeros', () => {
    const charts = diagnosticCharts([
      row(1, { ...full, pzmrMedianRt: null, gorbov: null }),
      row(2, '{not json'),
      row(3, { ...full, szmrMedianRt: 'x', gorbov: { V: 40, P: null, Pi: 12 } }),
    ]);
    expect(charts[0]?.series[0]?.points.map((p) => p.y)).toEqual([null, null, 300]);
    expect(charts[1]?.series[0]?.points.map((p) => p.y)).toEqual([420, null, null]);
    // A Горбов result needs V, P and Π (parseResults, FW9): a damaged one is a gap in all three lines.
    for (const series of charts[4]?.series ?? []) expect(series.points.map((p) => p.y)).toEqual([null, null, null]);
  });

  it('marks the points of modules measured with dropped frames (I1)', () => {
    const charts = diagnosticCharts([row(1, full), row(2, { ...full, unreliable: ['pzmr', 'gonogo'] })]);
    expect(charts[0]?.series[0]?.points).toEqual([{ x: '№1', y: 300 }, { x: '№2', y: 300, note: 'замер ненадёжен' }]);
    expect(charts[0]?.unreliable).toEqual(['№2']);
    expect(charts[2]?.unreliable).toEqual(['№2']);
    expect(charts[1]?.unreliable).toEqual([]);
    expect(charts[1]?.series[0]?.points[1]).toEqual({ x: '№2', y: 420 });
    expect(charts[4]?.unreliable).toEqual([]);
  });

  it('has no points without diagnostics', () => {
    expect(diagnosticCharts([]).every((c) => c.series.every((s) => s.points.length === 0))).toBe(true);
  });
});

describe('loadProgressModel', () => {
  it('level charts for every module except the number series', async () => {
    const model = await loadProgressModel(new MemoryRepository());
    expect(model.levels.map((l) => l.module)).toEqual(MODULE_IDS.filter((m) => m !== 'numseries'));
    expect(model.levels.find((l) => l.module === 'memory')).toMatchObject({ title: 'Память', norm: 9 });
    expect(model.diagnostics).toHaveLength(10);
  });

  it('loadProgressModel builds the assessment from blocks, sessions, states and ratings', async () => {
    const repo = new MemoryRepository();
    const now = new Date('2026-10-15T12:00:00.000Z');
    await repo.createSession(session('f', '2026-10-14T10:00:00.000Z', { kind: 'free', endedAt: '2026-10-14T10:10:00.000Z' }));
    await repo.addBlock(
      block('b1', 'f', '2026-10-14T10:01:00.000Z', { module: 'pzmr', lBefore: 3, lAfter: 3.5, summaryJson: '{"meanRt":262.4,"sdRt":50,"counts":{"miss":0,"late":0}}' }),
      [],
      [],
    );
    await rebuildCaches(repo);
    const model = await loadProgressModel(repo, now);
    expect(model.assessment.map((a) => a.module)).toEqual([...MODULE_IDS]);
    expect(model.assessment[0]).toEqual({
      module: 'pzmr',
      title: 'ПЗМР',
      step: '1 — начальная (ур. 3,5; формат теста — 8)',
      lastBest: '262 мс / 262 мс',
      norm: 'средний',
      goal: 'ур. 4 (+0,5)',
    });
    // Number series: no block yet, so no rating line either.
    expect(model.assessment.at(-1)).toEqual({ module: 'numseries', title: 'Числовые ряды', step: '—', lastBest: 'ещё не тренировался', norm: '—', goal: '—' });
    // The session table counts the same blocks.
    expect(model.sessions.map((s) => s.blocks)).toEqual([1]);
  });
});

describe('the level charts after the load bands (F3, Р9, spec §3.1.6)', () => {
  const at = (day: number): string => new Date(2026, 9, day, 10).toISOString();

  it('the level chart keeps the recorded points and marks the first load-band session', async () => {
    const repo = new MemoryRepository();
    const levels: [number, number, string][] = [
      [1, 14, '{"windowMs":300}'],
      [2, 15, '{"windowMs":290}'],
      [3, 9, '{"band":2}'],
      [4, 10, '{"band":2}'],
    ];
    for (const [day, lAfter, paramsJson] of levels) {
      await repo.createSession(session(`s${String(day)}`, at(day), { endedAt: at(day) }));
      await repo.addBlock(block(`p${String(day)}`, `s${String(day)}`, at(day), { module: 'pzmr', lAfter, paramsJson }), [], []);
      // Струп: every session of the load bands, so no marker.
      await repo.addBlock(block(`t${String(day)}`, `s${String(day)}`, at(day), { module: 'stroop', lAfter: 3, paramsJson: '{"band":0}' }), [], []);
      // РДО has no bands: its old levels are no break.
      await repo.addBlock(block(`r${String(day)}`, `s${String(day)}`, at(day), { module: 'rdo', lAfter: 12, paramsJson: '{"periodMs":3000}' }), [], []);
    }
    // The cache holds the capped levels; the chart draws the recorded ones.
    await rebuildCaches(repo);
    const model = await loadProgressModel(repo, new Date(2026, 9, 5, 12));
    const chart = (m: string) => model.levels.find((l) => l.module === m);
    expect(chart('pzmr')?.series[0]?.points).toEqual([
      { x: '1', y: 14 },
      { x: '2', y: 15 },
      { x: '3', y: 9 },
      { x: '4', y: 10 },
    ]);
    expect(chart('pzmr')).toMatchObject({ norm: 8, marker: { x: '3', normBefore: 14 } });
    expect(chart('stroop')?.marker).toBeNull();
    expect(chart('rdo')?.marker).toBeNull();
    // No sessions: no marker either.
    expect(chart('szmr')?.marker).toBeNull();
    // 14 and 15 are capped at 8 in the cache: L_saved of ПЗМР is median(8, 9, 10).
    expect((await repo.getModuleStates()).pzmr.lSaved).toBe(9);
  });

  it('a module whose first session already has a band gets no marker', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('s1', at(1), { endedAt: at(1) }));
    await repo.addBlock(block('p1', 's1', at(1), { module: 'pzmr', lAfter: 9, paramsJson: '{"band":2}' }), [], []);
    const model = await loadProgressModel(repo, new Date(2026, 9, 5, 12));
    expect(model.levels[0]).toMatchObject({ module: 'pzmr', marker: null, series: [{ points: [{ x: '1', y: 9 }] }] });
  });

  it('overload28d: the mean score of the band modules\' overload blocks of the last 28 days, recomputed from their counts (T-R31)', () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    const counts = (hit: number, wrong = 0, falseStart = 0, miss = 0) =>
      JSON.stringify({ n: hit + wrong + falseStart + miss, score: hit / (hit + wrong + falseStart + miss), counts: { hit, wrong, miss, late: 0, false_start: falseStart, commission: 0, correct_reject: 0, early: 0, timing_late: 0 } });
    const over = (id: string, startedAt: string, summaryJson: string, module: 'szmr' | 'pzmr' | 'rdo' = 'szmr', score = 0.5) =>
      block(id, 's', startedAt, { module, flags: ['overload'], summaryJson, score });
    const rows = [
      // A pre-F1 block: its stored score is the hit share 0.85; with the penalty it is (17 − 2 − 2·1) / 20 = 0.65.
      over('a', '2026-10-20T10:00:00.000Z', counts(17, 2, 1), 'szmr', 0.85),
      // An F1 block: its stored score is already penalised, (18 − 1) / 20 = 0.85.
      over('b', '2026-10-29T10:00:00.000Z', counts(18, 1, 0, 1), 'pzmr', 0.85),
      // Exactly 28 days back: in.
      over('c', '2026-10-02T12:00:00.000Z', counts(14, 0, 0, 6)),
      // Older than 28 days, in the future, РДО (no bands), not an overload block: out.
      over('d', '2026-10-02T11:59:59.000Z', counts(20)),
      over('e', '2026-10-30T12:00:01.000Z', counts(20)),
      over('f', '2026-10-25T10:00:00.000Z', counts(20), 'rdo'),
      block('g', 's', '2026-10-25T10:00:00.000Z', { module: 'szmr', summaryJson: counts(20) }),
      // Unreadable counts: left out, not counted as 0.
      over('h', '2026-10-25T10:00:00.000Z', 'not json'),
      over('i', '2026-10-25T10:00:00.000Z', JSON.stringify({ counts: { hit: 'many' } })),
      over('j', '2026-10-25T10:00:00.000Z', JSON.stringify({ score: 0.9 })),
      over('k', '2026-10-25T10:00:00.000Z', JSON.stringify({ counts: { hit: 0, wrong: 0, miss: 0, late: 0, false_start: 0, commission: 0, correct_reject: 0, early: 0, timing_late: 0 } })),
      over('l', 'not a date', counts(20)),
      // Counted as 0 after Esc (F11): stores no counts, and the flag keeps it out anyway (T-R10).
      block('m', 's', '2026-10-25T10:00:00.000Z', { module: 'szmr', flags: ['overload', 'discarded'], summaryJson: counts(5, 0, 0, 15), score: 0 }),
    ];
    const result = overload28d(rows, now);
    expect(result?.blocks).toBe(3);
    expect(result?.mean).toBeCloseTo((0.65 + 0.85 + 0.7) / 3, 10);
    expect(overload28d([], now)).toBeNull();
    expect(overload28d(rows.slice(3), now)).toBeNull();
  });

  it('loadProgressModel reads overload28d from the block history', async () => {
    const repo = new MemoryRepository();
    const now = new Date(2026, 9, 15, 12);
    await repo.createSession(session('s', at(14), { endedAt: at(14) }));
    const summaryJson = JSON.stringify({ counts: { hit: 15, wrong: 0, miss: 5, late: 0, false_start: 0, commission: 0, correct_reject: 0, early: 0, timing_late: 0 } });
    await repo.addBlock(block('o', 's', at(14), { module: 'gonogo', flags: ['overload'], summaryJson }), [], []);
    expect((await loadProgressModel(repo, now)).overload28d).toEqual({ mean: 0.75, blocks: 1 });
    expect((await loadProgressModel(new MemoryRepository(), now)).overload28d).toBeNull();
  });
});

describe('the РДО bias by speed (F14)', () => {
  const now = new Date('2026-10-30T12:00:00.000Z');
  const rdo = (id: string, startedAt: string, periodMs: number | null, meanSignedErrorMs: unknown, flags: BlockFlag[] = []) =>
    block(id, 's', startedAt, {
      module: 'rdo',
      flags,
      paramsJson: periodMs === null ? '{}' : JSON.stringify({ periodMs, toleranceMs: 32 }),
      summaryJson: JSON.stringify({ meanSignedErrorMs }),
    });

  it('the mean signed error of the РДО blocks of the last 28 days at each speed, in RDO_PERIODS order', () => {
    const rows = [
      rdo('a', '2026-10-29T10:00:00.000Z', 1500, -20),
      rdo('b', '2026-10-20T10:00:00.000Z', 1500, -9),
      rdo('c', '2026-10-02T12:00:00.000Z', 3000, 3.5),
      // An overload block, a test-format run, a diagnostic: blocks at their speed all the same.
      rdo('d', '2026-10-25T10:00:00.000Z', 4000, 11, ['overload']),
      rdo('e', '2026-10-25T10:00:00.000Z', 3000, 1, ['test_format']),
      // Out: older than 28 days, in the future, counted as 0 after Esc (T-R10), another module, a 0.2.0 period, no
      // period, no bias, a damaged bias.
      rdo('f', '2026-10-02T11:59:59.000Z', 1500, 50),
      rdo('g', '2026-10-30T12:00:01.000Z', 1500, 50),
      rdo('h', '2026-10-25T10:00:00.000Z', 2000, 50, ['discarded']),
      { ...rdo('i', '2026-10-25T10:00:00.000Z', 2000, 50), module: 'pzmr' as const },
      rdo('j', '2026-10-25T10:00:00.000Z', 1679, 50),
      rdo('k', '2026-10-25T10:00:00.000Z', null, 50),
      rdo('l', '2026-10-25T10:00:00.000Z', 2000, null),
      rdo('m', '2026-10-25T10:00:00.000Z', 2000, '12'),
      { ...rdo('n', '2026-10-25T10:00:00.000Z', 2000, 5), paramsJson: 'not json' },
      { ...rdo('o', '2026-10-25T10:00:00.000Z', 2000, 5), summaryJson: 'not json' },
      rdo('p', 'not a date', 2000, 5),
    ];
    expect(rdoBias(rows, now)).toEqual([
      { periodMs: 1500, meanMs: -14.5, blocks: 2 },
      { periodMs: 2000, meanMs: null, blocks: 0 },
      { periodMs: 3000, meanMs: 2.25, blocks: 2 },
      { periodMs: 4000, meanMs: 11, blocks: 1 },
    ]);
    expect(rdoBias([], now).map((s) => s.blocks)).toEqual([0, 0, 0, 0]);
  });

  it('a timing_unreliable block is left out: dropped frames distort errorMs (T-R60)', () => {
    const rows = [
      rdo('a', '2026-10-25T10:00:00.000Z', 3000, -10),
      rdo('b', '2026-10-25T10:00:00.000Z', 3000, 90, ['timing_unreliable']),
      rdo('c', '2026-10-25T10:00:00.000Z', 3000, 90, ['test_format', 'timing_unreliable']),
      // A test-format run and a diagnostic block (no flag) play 3000 ms: the same measure, they stay in.
      rdo('d', '2026-10-25T10:00:00.000Z', 3000, 4, ['test_format']),
      rdo('e', '2026-10-25T10:00:00.000Z', 3000, 0),
    ];
    expect(rdoBias(rows, now)[2]).toEqual({ periodMs: 3000, meanMs: -2, blocks: 3 });
  });

  it('loadProgressModel reads it from the block history', async () => {
    const repo = new MemoryRepository();
    const at = new Date(2026, 9, 14, 10).toISOString();
    await repo.createSession(session('s', at, { endedAt: at }));
    await repo.addBlock(rdo('r', at, 2000, -6), [], []);
    expect((await loadProgressModel(repo, new Date(2026, 9, 15, 12))).rdoBias[1]).toEqual({ periodMs: 2000, meanMs: -6, blocks: 1 });
  });
});

describe('the cost of re-adaptation (F9)', () => {
  const now = new Date('2026-10-30T12:00:00.000Z');
  const sessions = [
    ...['a', 'b', 'c', 'e', 'g', 'h'].map((id) => session(id, '2026-10-20T09:00:00.000Z')),
    session('f', '2026-10-21T09:00:00.000Z', { kind: 'free' }),
    session('d', '2026-10-22T09:00:00.000Z', { kind: 'diagnostic' }),
  ];
  interface Played {
    score: number;
    rts: number[];
    flags?: BlockFlag[];
    module?: 'szmr' | 'stroop' | 'pzmr';
  }
  /** A segment of `module` in session `sessionId` on `day`: its first block marked readapt, then the others, a minute apart. */
  const segment = (sessionId: string, day: string, first: Played, rest: Played[], module: 'szmr' | 'stroop' = 'szmr'): BlockRow[] =>
    [first, ...rest].map((b, i) =>
      block(`${sessionId}${day}${String(i)}`, sessionId, `${day}T10:${String(10 + i)}:00.000Z`, {
        module: b.module ?? module,
        score: b.score,
        flags: b.flags ?? [],
        summaryJson: JSON.stringify({ cleanHitRts: b.rts, ...(i === 0 ? { readapt: true } : {}) }),
      }),
    );
  const first: Played = { score: 0.8, rts: [390, 400, 410] };
  const rest: Played[] = [
    { score: 0.86, rts: [355, 365, 375] },
    { score: 0.86, rts: [360, 365, 370] },
  ];

  it('three СЗМР segments in 28 days: the first block s 0.8 against 0.86, median RT 400 against 365', () => {
    const blocks = [...segment('a', '2026-10-05', first, rest), ...segment('b', '2026-10-15', first, rest), ...segment('f', '2026-10-29', first, rest)];
    const costs = readaptCosts(pastBlocks(blocks, sessions), now);
    expect(costs.map((c) => [c.module, c.segments, c.rtDelta])).toEqual([['szmr', 3, 35]]);
    expect(costs[0]?.scoreDelta).toBeCloseTo(-0.06, 9);
    // Two segments are not enough.
    expect(readaptCosts(pastBlocks(blocks.slice(3), sessions), now)).toEqual([]);
  });

  it('the cost of a segment: s of the first minus the mean s of the rest, the median RT of the first minus that of the rest pooled', () => {
    const blocks = [
      ...segment('a', '2026-10-05', { score: 0.7, rts: [500, 520] }, [
        { score: 0.8, rts: [400] },
        { score: 0.9, rts: [300, 310, 320] },
      ]),
      ...segment('b', '2026-10-06', { score: 0.9, rts: [300] }, rest),
      ...segment('c', '2026-10-07', { score: 0.9, rts: [300] }, rest),
    ];
    const [cost] = readaptCosts(pastBlocks(blocks, sessions), now);
    // (−0.15 + 0.04 + 0.04) / 3 and (510 − 315 − 65 − 65) / 3.
    expect(cost?.scoreDelta).toBeCloseTo((-0.15 + 0.04 + 0.04) / 3, 9);
    expect(cost?.rtDelta).toBeCloseTo((195 - 65 - 65) / 3, 9);
  });

  it('what a segment needs: two more blocks that measured something, in the same session and module, in 28 days', () => {
    const good = [...segment('a', '2026-10-05', first, rest), ...segment('b', '2026-10-15', first, rest)];
    const third = (blocks: BlockRow[]): number => readaptCosts(pastBlocks([...good, ...blocks], sessions), now)[0]?.segments ?? 0;
    expect(third(segment('c', '2026-10-20', first, rest))).toBe(3);
    // The rest leaves out overload blocks, blocks counted as 0 after Esc and dropped frames: one block is too few.
    for (const flags of [['overload'], ['discarded'], ['timing_unreliable'], ['warmup']] as BlockFlag[][]) {
      expect(third(segment('c', '2026-10-20', first, [rest[0] as Played, { ...(rest[1] as Played), flags }])), flags.join()).toBe(0);
    }
    // With one of them between two good blocks it counts.
    expect(third(segment('c', '2026-10-20', first, [rest[0] as Played, { score: 0, rts: [], flags: ['overload'] }, rest[1] as Played]))).toBe(3);
    // A first block counted as 0 or with dropped frames measured nothing.
    expect(third(segment('c', '2026-10-20', { ...first, flags: ['discarded'] }, rest))).toBe(0);
    expect(third(segment('c', '2026-10-20', { ...first, flags: ['timing_unreliable'] }, rest))).toBe(0);
    // The segment ends at a block of another module.
    expect(third(segment('c', '2026-10-20', first, [rest[0] as Played, { ...(rest[1] as Played), module: 'pzmr' }]))).toBe(0);
    // Without RTs there is no time cost.
    expect(third(segment('c', '2026-10-20', { ...first, rts: [] }, rest))).toBe(0);
    expect(third(segment('c', '2026-10-20', first, rest.map((r) => ({ ...r, rts: [] }))))).toBe(0);
    // Older than 28 days, in the future, a diagnostic, a session not on record.
    expect(third(segment('c', '2026-10-01', first, rest))).toBe(0);
    expect(third(segment('c', '2026-10-31', first, rest))).toBe(0);
    expect(third(segment('d', '2026-10-20', first, rest))).toBe(0);
    expect(third(segment('x', '2026-10-20', first, rest))).toBe(0);
  });

  it('the segment stops at the next session; damaged summaries are left out', () => {
    const blocks = [
      ...segment('a', '2026-10-05', first, [rest[0] as Played]),
      // The next block of the module is another session's.
      ...segment('b', '2026-10-05', { ...first, score: 0.86 }, [rest[1] as Played]).map((b, i) => (i === 0 ? { ...b, summaryJson: '{"cleanHitRts":[365]}' } : b)),
      ...segment('c', '2026-10-06', first, rest),
      ...segment('e', '2026-10-07', first, rest),
      { ...block('g1', 'g', '2026-10-08T10:00:00.000Z', { module: 'szmr' }), summaryJson: 'not json' },
      { ...block('h1', 'h', '2026-10-08T11:00:00.000Z', { module: 'szmr' }), summaryJson: '{"readapt":"yes","cleanHitRts":[1]}' },
    ];
    expect(readaptCosts(pastBlocks(blocks, sessions), now)).toEqual([]);
  });

  it('modules in their order, each with its own segments', () => {
    const blocks = [
      ...['a', 'b', 'c'].flatMap((id, k) => segment(id, `2026-10-1${String(k)}`, first, rest, 'stroop')),
      ...['e', 'f', 'g'].flatMap((id, k) => segment(id, `2026-10-2${String(k)}`, first, rest)),
    ];
    expect(readaptCosts(pastBlocks(blocks, sessions), now).map((c) => [c.module, c.segments])).toEqual([
      ['szmr', 3],
      ['stroop', 3],
    ]);
  });

  it('loadProgressModel reads it from the block history', async () => {
    const repo = new MemoryRepository();
    for (const [k, id] of ['a', 'b', 'c'].entries()) {
      const day = `2026-10-1${String(k + 2)}`;
      await repo.createSession(session(id, `${day}T09:00:00.000Z`, { endedAt: `${day}T11:00:00.000Z` }));
      for (const b of segment(id, day, first, rest)) await repo.addBlock(b, [], []);
    }
    const { readapt } = await loadProgressModel(repo, now);
    expect(readapt.map((c) => [c.module, c.segments, c.rtDelta])).toEqual([['szmr', 3, 35]]);
    expect(readapt[0]?.scoreDelta).toBeCloseTo(-0.06, 9);
    expect((await loadProgressModel(new MemoryRepository(), now)).readapt).toEqual([]);
  });
});

describe('the main variant of a band module (Р29, T-R7)', () => {
  it('«Оценка по модулям» reads the band with the latest block; rows from before the bands are another variant', async () => {
    const repo = new MemoryRepository();
    const now = new Date('2026-10-15T12:00:00.000Z');
    const pz = (id: string, sessionId: string, at: string, paramsJson: string, meanRt: number) =>
      block(id, sessionId, at, { module: 'pzmr', lBefore: 9, lAfter: 9.5, paramsJson, summaryJson: JSON.stringify({ meanRt, counts: { miss: 0, late: 0 } }) });
    await repo.createSession(session('a', '2026-10-12T10:00:00.000Z', { endedAt: '2026-10-12T10:10:00.000Z' }));
    await repo.createSession(session('b', '2026-10-14T10:00:00.000Z', { endedAt: '2026-10-14T10:10:00.000Z' }));
    await repo.addBlock(pz('old', 'a', '2026-10-12T10:01:00.000Z', '{"windowMs":300}', 250), [], []);
    await repo.addBlock(pz('b1', 'a', '2026-10-12T10:02:00.000Z', '{"band":1}', 260), [], []);
    await repo.addBlock(pz('b2', 'b', '2026-10-14T10:01:00.000Z', '{"band":2}', 290), [], []);
    await repo.addBlock(pz('w', 'b', '2026-10-14T10:05:00.000Z', '{"band":2}', 240), [], []);
    await repo.addBlock(block('warm', 'b', '2026-10-14T10:09:00.000Z', { module: 'pzmr', flags: ['warmup'], paramsJson: '{"band":2}', summaryJson: '{"meanRt":200}' }), [], []);
    await rebuildCaches(repo);
    const model = await loadProgressModel(repo, now);
    // Band 2 has the latest block (the later warm-up is a variant of its own): its last and best, not 250 or 200.
    expect(model.assessment[0]).toMatchObject({ module: 'pzmr', title: 'ПЗМР', lastBest: '240 мс / 240 мс' });
  });
});

describe('the form of the day', () => {
  it('the form-of-day chart: the daily warm-up median for 30 days', () => {
    const d = (day: string, rts: number[], band = 1) => ({ day, band, rts });
    expect(
      formOfDayPoints(
        [
          d('2026-10-15', [300, 310]),
          d('2026-09-15', [400]),
          d('2026-09-16', [290]),
          d('2026-10-01', [250]),
          d('2026-10-01', [270, 260], 2),
          d('2026-10-02', []),
          d('2026-10-16', [200]),
        ],
        '2026-10-15',
      ),
    ).toEqual([
      // 15.09 is 30 days back: out. Bands do not matter here; a day of several warm-ups is one point.
      { x: '16.09', y: 290 },
      { x: '01.10', y: 260 },
      { x: '15.10', y: 305 },
    ]);
    expect(formOfDayPoints([], '2026-10-15')).toEqual([]);
  });

  it('loadProgressModel reads the warm-ups of training and free sessions from the block history', async () => {
    const repo = new MemoryRepository();
    const now = new Date(2026, 9, 15, 12);
    const at = (day: number): string => new Date(2026, 9, day, 10).toISOString();
    const summaryJson = (rts: number[]): string => JSON.stringify({ meanRt: 300, cleanHitRts: rts });
    await repo.createSession(session('t', at(14), { endedAt: at(14) }));
    await repo.createSession(session('d', at(13), { kind: 'diagnostic', endedAt: at(13) }));
    await repo.addBlock(block('w', 't', at(14), { flags: ['warmup'], summaryJson: summaryJson([281, 283]) }), [], []);
    await repo.addBlock(block('r', 't', at(14), { summaryJson: summaryJson([200]) }), [], []);
    await repo.addBlock(block('x', 'd', at(13), { flags: ['warmup'], summaryJson: summaryJson([200]) }), [], []);
    expect((await loadProgressModel(repo, now)).formOfDay).toEqual([{ x: '14.10', y: 282 }]);
  });
});

/** The trend of a series of fewer than 3 points (F7). */
const SHORT = { text: 'Полоса шума и тренд появятся после 3 точек.', band: [] };

describe('the test-format runs (F4)', () => {
  const at = (day: number): string => new Date(2026, 9, day, 10).toISOString();
  const run = (mean: number | null, sd: number | null, errors: number, falseStarts = 0): string =>
    JSON.stringify({ testFormat: { mean, sd, errors, falseStarts, thirds: [mean, mean, mean] } });

  it('per format with runs, in format order: the mean and the SD of each run by its date, the best and the number of runs', async () => {
    const repo = new MemoryRepository();
    for (const [id, day, kind] of [['t1', 1, 'training'], ['t2', 8, 'training'], ['t3', 15, 'training'], ['d', 9, 'diagnostic']] as const) {
      await repo.createSession(session(id, at(day), { kind, endedAt: at(day) }));
    }
    const flags: BlockFlag[] = ['test_format'];
    await repo.addBlock(block('r1', 't1', at(1), { module: 'pzmr', flags, summaryJson: run(260.4, 30, 2) }), [], []);
    await repo.addBlock(block('r2', 't2', at(8), { module: 'rdo', flags, summaryJson: run(18, 25, 3, 1) }), [], []);
    await repo.addBlock(block('r3', 't3', at(15), { module: 'pzmr', flags, summaryJson: run(250, null, 3) }), [], []);
    // Left out: a damaged run, a diagnostic block with the flag, a block without it.
    await repo.addBlock(block('x1', 't3', at(15), { module: 'szmr', flags, summaryJson: '{"testFormat":{}}' }), [], []);
    await repo.addBlock(block('x2', 'd', at(9), { module: 'pzmr', flags, summaryJson: run(100, 1, 0) }), [], []);
    await repo.addBlock(block('x3', 't1', at(1), { module: 'pzmr', summaryJson: run(100, 1, 0) }), [], []);
    expect((await loadProgressModel(repo, new Date(2026, 9, 16))).testFormats).toEqual([
      {
        format: 'pzmr',
        name: 'ПЗМР',
        mean: [{ x: '01.10', y: 260.4 }, { x: '15.10', y: 250 }],
        sd: [{ x: '01.10', y: 30 }, { x: '15.10', y: null }],
        trends: { mean: SHORT, sd: SHORT },
        best: { mean: 250, sd: 30, errors: 2, falseStarts: 0 },
        runs: 2,
      },
      {
        format: 'rdo',
        name: 'РДО',
        mean: [{ x: '08.10', y: 18 }],
        sd: [{ x: '08.10', y: 25 }],
        trends: { mean: SHORT, sd: SHORT },
        best: { mean: 18, sd: 25, errors: 3, falseStarts: 1 },
        runs: 1,
      },
    ]);
  });

  it('no runs: no format', async () => {
    expect((await loadProgressModel(new MemoryRepository())).testFormats).toEqual([]);
  });
});

describe('session lines', () => {
  it('formats dates in local time as dd.mm.yyyy', () => {
    expect(ruDate(new Date(2026, 0, 5, 23, 30).toISOString())).toBe('05.01.2026');
  });

  it('writes whole minutes, «не завершена» without an end', () => {
    expect(durationText('2026-10-14T10:00:00.000Z', '2026-10-14T10:24:40.000Z')).toBe('25 мин');
    expect(durationText('2026-10-14T10:00:00.000Z', '2026-10-14T10:00:10.000Z')).toBe('меньше минуты');
    expect(durationText('2026-10-14T10:00:00.000Z', null)).toBe('не завершена');
    expect(durationText('2026-10-14T10:00:00.000Z', '2026-10-14T09:00:00.000Z')).toBe('—');
  });

  it('lists newest first with block counts, at most SESSION_LINES', () => {
    const sessions = Array.from({ length: SESSION_LINES + 5 }, (_, i) =>
      session(`s${String(i)}`, new Date(2026, 0, 1 + i, 10).toISOString(), { kind: i % 3 === 0 ? 'free' : i % 3 === 1 ? 'diagnostic' : 'training' }),
    );
    const lines = sessionLines(sessions, new Map([[`s${String(SESSION_LINES + 4)}`, 7]]));
    expect(lines).toHaveLength(SESSION_LINES);
    expect(lines[0]).toMatchObject({ id: `s${String(SESSION_LINES + 4)}`, blocks: 7, type: 'Свободная' });
    expect(lines.slice(0, 3).map((l) => l.type)).toEqual(['Свободная', 'Тренировка', 'Диагностика']);
    expect(lines[1]?.blocks).toBe(0);
  });
});

describe('noise band and trend (F7, Р19)', () => {
  const weekly = (ys: number[]) => trend(ys.map((y, i) => ({ t: 7 * i, y })), true);
  const made = (o: Partial<Trend>): Trend => ({ slope: 0, intercept: 0, sigma: 0.5, change: -3.71, days: 21, verdict: 'better', ...o });

  it('trendText: the change, the period, the verdict and the noise', () => {
    expect(trendText(weekly([300, 298, 295, 292, 290, 288]), 'мс')).toBe('Тренд: −12 мс за 5 недель — лучше (шум ±3 мс)');
    expect(trendText(weekly([300, 310, 300, 310, 300, 310]), 'мс')).toBe('Тренд: +4 мс за 5 недель — в пределах шума (шум ±14 мс)');
    // Seconds keep one decimal.
    expect(trendText(made({}), 'с')).toBe('Тренд: −3,7 с за 3 недели — лучше (шум ±1,0 с)');
    // Below 14 days the period is in days.
    expect(trendText(made({ days: 9 }), 'с')).toBe('Тренд: −3,7 с за 9 дн. — лучше (шум ±1,0 с)');
    expect(trendText(made({ days: 13.4, change: 5.4, sigma: 1, verdict: 'worse' }), '%')).toBe('Тренд: +5 % за 13 дн. — хуже (шум ±2 %)');
    expect(trendText(made({ days: 13.6, change: 5.4, sigma: 1, verdict: 'worse' }), '%')).toBe('Тренд: +5 % за 2 недели — хуже (шум ±2 %)');
    expect(trendText(made({ days: 147, change: 6, sigma: 1 }), '')).toBe('Тренд: +6 за 21 неделю — лучше (шум ±2)');
    // A change that rounds to 0 has no sign.
    expect(trendText(made({ change: -0.4, verdict: 'noise' }), 'мс')).toBe('Тренд: 0 мс за 3 недели — в пределах шума (шум ±1 мс)');
    expect(trendText(made({ change: 0.04, verdict: 'noise' }), 'с')).toBe('Тренд: 0 с за 3 недели — в пределах шума (шум ±1,0 с)');
    // A chart of several series: one line each, named, «тренд» in lower case.
    expect(trendText(made({}), 'с', 'V')).toBe('V: тренд −3,7 с за 3 недели — лучше (шум ±1,0 с)');
    expect(trendText(null, 'мс')).toBe('Полоса шума и тренд появятся после 3 точек.');
    expect(trendText(null, 'с', 'V')).toBe('Полоса шума и тренд появятся после 3 точек.');
  });

  it('trendView: the band is the line ± 2σ̂ at the x of the last points; gaps and undated points are left out', () => {
    const ys = [999, 300, null, 298, 295, 292, 290, 288];
    const points = ys.map((y, i) => ({ x: `№${String(i + 1)}`, t: i === 2 ? null : 7 * i, y }));
    const view = trendView(points, true, 'мс');
    const t = trend(points.flatMap((p) => (p.y === null ? [] : [{ t: p.t as number, y: p.y }])).slice(-6), true) as Trend;
    expect(view.text).toBe(trendText(t, 'мс'));
    expect(view.band.map((b) => b.x)).toEqual(['№2', '№4', '№5', '№6', '№7', '№8']);
    for (const b of view.band) {
      const tb = 7 * (Number(b.x.slice(1)) - 1);
      expect(b.lo).toBeCloseTo(t.intercept + t.slope * tb - 2 * t.sigma, 9);
      expect(b.hi).toBeCloseTo(t.intercept + t.slope * tb + 2 * t.sigma, 9);
    }
    // Two points: no band, the «after 3 points» line.
    expect(trendView(points.slice(0, 2), true, 'мс')).toEqual({ text: 'Полоса шума и тренд появятся после 3 точек.', band: [] });
  });

  it('trendView: each band point carries the slot of its point, so a window that cuts two same-day runs apart lands right (T-R56)', () => {
    // 7 runs; runs 1 and 2 on one day share the label «01.10». The window is runs 2–7.
    const labels = ['01.10', '01.10', '02.10', '03.10', '04.10', '05.10', '06.10'];
    const points = labels.map((x, i) => ({ x, t: i === 0 ? 0 : i - 1, y: 300 - i }));
    const view = trendView(points, true, 'мс');
    expect(view.band.map((b) => [b.x, b.slot])).toEqual([
      ['01.10', 1],
      ['02.10', 2],
      ['03.10', 3],
      ['04.10', 4],
      ['05.10', 5],
      ['06.10', 6],
    ]);
  });

  const weeklyRows = (results: unknown[]): DiagnosticRow[] =>
    results.map((r, i) => ({ ...row(i + 1, r), at: new Date(2026, 6, 1 + 7 * i, 10).toISOString() }));

  it('every diagnostic chart has a trend per series; Горбов names its series', () => {
    const rows = weeklyRows([300, 298, 295, 292, 290, 288].map((pzmrMedianRt) => ({ ...fullW2, pzmrMedianRt })));
    const charts = diagnosticCharts(rows);
    for (const c of charts) expect(c.trends).toHaveLength(c.series.length);
    const pzmr = charts.find((c) => c.id === 'pzmr');
    expect(pzmr?.trends[0]?.text).toBe('Тренд: −12 мс за 5 недель — лучше (шум ±3 мс)');
    expect(pzmr?.trends[0]?.band.map((b) => b.x)).toEqual(['№1', '№2', '№3', '№4', '№5', '№6']);
    const gorbov = charts.find((c) => c.id === 'gorbov');
    expect(gorbov?.trends.map((t) => t.text)).toEqual([
      'V: тренд 0 с за 5 недель — в пределах шума (шум ±0,0 с)',
      'P: тренд 0 с за 5 недель — в пределах шума (шум ±0,0 с)',
      'Π: тренд 0 с за 5 недель — в пределах шума (шум ±0,0 с)',
    ]);
    // Go/No-Go in %, the series and the span as counts.
    expect(charts.find((c) => c.id === 'gonogo')?.trends[0]?.text).toBe('Тренд: 0 % за 5 недель — в пределах шума (шум ±0 %)');
    expect(charts.find((c) => c.id === 'memory')?.trends[0]?.text).toBe('Тренд: 0 за 5 недель — в пределах шума (шум ±0)');
    // Fewer than 3 points: the line that says when they come, no band.
    expect(diagnosticCharts(rows.slice(0, 2))[0]?.trends).toEqual([{ text: 'Полоса шума и тренд появятся после 3 точек.', band: [] }]);
  });

  it('Горбов of old diagnostics: points with a note, the trend from the one-table ones only (F10)', () => {
    const one = { ...full, gorbovOneTable: true };
    // Three diagnostics on three tables, slower, then three on one table: the format change is no trend.
    const rows = weeklyRows([
      { ...full, gorbov: { V: 50, P: 100, Pi: 0 } },
      { ...full, gorbov: { V: 50, P: 100, Pi: 0 } },
      { ...full, gorbov: { V: 50, P: 100, Pi: 0 } },
      { ...one, gorbov: { V: 40, P: 80, Pi: 0 } },
      { ...one, gorbov: { V: 40, P: 80, Pi: 0 } },
    ]);
    const gorbov = diagnosticCharts(rows).find((c) => c.id === 'gorbov');
    expect(gorbov?.series[0]?.points).toEqual([
      { x: '№1', y: 50, note: '3 разные таблицы, до 0.3.0' },
      { x: '№2', y: 50, note: '3 разные таблицы, до 0.3.0' },
      { x: '№3', y: 50, note: '3 разные таблицы, до 0.3.0' },
      { x: '№4', y: 40 },
      { x: '№5', y: 40 },
    ]);
    expect(gorbov?.unreliable).toEqual([]);
    // Two one-table points: no trend yet, though five points are drawn.
    expect(gorbov?.trends.map((t) => t.text)).toEqual([NO_TREND, NO_TREND, NO_TREND]);
    expect(gorbov?.footnote).toBe('На трёх разных таблицах (до 0.3.0): №1, №2, №3. Тренд и полоса шума — только по диагностикам на одной таблице.');
    // A third one-table point: the trend and the band from №4–№6.
    const more = [...rows, ...weeklyRows([{ ...one, gorbov: { V: 40, P: 80, Pi: 0 } }]).map((r) => ({ ...r, id: 'd6', number: 6, at: new Date(2026, 6, 36, 10).toISOString() }))];
    const later = diagnosticCharts(more).find((c) => c.id === 'gorbov');
    expect(later?.trends[0]?.text).toBe('V: тренд 0 с за 2 недели — в пределах шума (шум ±0,0 с)');
    expect(later?.trends[0]?.band.map((b) => [b.x, b.slot])).toEqual([
      ['№4', 3],
      ['№5', 4],
      ['№6', 5],
    ]);
    // Old diagnostics alone: no note, the trend from all of them, no footnote.
    const old = diagnosticCharts(rows.slice(0, 3)).find((c) => c.id === 'gorbov');
    expect(old?.series[0]?.points.map((p) => p.note)).toEqual([undefined, undefined, undefined]);
    expect(old?.trends[0]?.band).toHaveLength(3);
    expect(old?.footnote).toBeUndefined();
    // The other charts mix the formats as before.
    expect(diagnosticCharts(rows).find((c) => c.id === 'pzmr')?.trends[0]?.band).toHaveLength(5);
    expect(diagnosticCharts(rows).find((c) => c.id === 'pzmr')?.footnote).toBeUndefined();
  });

  it('the index chart: readinessOfLatest(earlier, d).overall by diagnostic; an unreadable row is a gap', () => {
    const results = [full, { ...full, pzmrMedianRt: 280, gonogoScore: 90 }, '{not json', { ...fullW2, pzmrMedianRt: 270 }];
    const rows = weeklyRows(results);
    const chart = indexChart(rows);
    const parsed = rows.map(parseResults);
    const earlier = (i: number) => parsed.slice(0, i).flatMap((r) => r ?? []);
    expect(chart).toMatchObject({ id: 'index', title: 'Общий индекс готовности', lowerIsBetter: false, domain: { min: 0, max: 100 }, whole: true });
    expect(chart.series[0]?.points).toEqual([
      { x: '№1', y: readinessOfLatest([], parsed[0] as DiagnosticResults).overall },
      { x: '№2', y: readinessOfLatest(earlier(1), parsed[1] as DiagnosticResults).overall },
      { x: '№3', y: null },
      { x: '№4', y: readinessOfLatest(earlier(3), parsed[3] as DiagnosticResults).overall },
    ]);
    expect(chart.trends).toHaveLength(1);
    expect(chart.trends[0]?.band.map((b) => b.x)).toEqual(['№1', '№2', '№4']);
    expect(indexChart([]).series[0]?.points).toEqual([]);
  });

  it('the runs and the form of the day have their trends, by the date of the block', async () => {
    const repo = new MemoryRepository();
    const at = (day: number): string => new Date(2026, 9, day, 10).toISOString();
    const run = (mean: number): string => JSON.stringify({ testFormat: { mean, sd: 30, errors: 0, falseStarts: 0, thirds: [mean, mean, mean] } });
    for (const [day, mean] of [[1, 300], [8, 298], [15, 295], [22, 292], [29, 290]] as const) {
      await repo.createSession(session(`s${String(day)}`, at(day), { endedAt: at(day) }));
      await repo.addBlock(block(`r${String(day)}`, `s${String(day)}`, at(day), { module: 'pzmr', flags: ['test_format'], summaryJson: run(mean) }), [], []);
      await repo.addBlock(
        block(`w${String(day)}`, `s${String(day)}`, at(day), { flags: ['warmup'], summaryJson: JSON.stringify({ cleanHitRts: [mean - 50] }) }),
        [],
        [],
      );
    }
    const model = await loadProgressModel(repo, new Date(2026, 9, 30, 12));
    const pzmr = model.testFormats[0];
    expect(pzmr?.trends.mean.text).toBe('Тренд: −10 мс за 4 недели — лучше (шум ±4 мс)');
    expect(pzmr?.trends.mean.band.map((b) => b.x)).toEqual(['01.10', '08.10', '15.10', '22.10', '29.10']);
    expect(pzmr?.trends.sd.text).toBe('Тренд: 0 мс за 4 недели — в пределах шума (шум ±0 мс)');
    expect(model.formOfDayTrend.text).toBe('Тренд: −10 мс за 4 недели — лучше (шум ±4 мс)');
    expect(model.formOfDayTrend.band).toHaveLength(5);
    expect(model.indexChart.series[0]?.points).toEqual([]);
    expect(model.indexChart.trends[0]?.text).toBe('Полоса шума и тренд появятся после 3 точек.');
  });
});

describe('interrupted blocks by week (F11)', () => {
  /** Local time: 2026-10-16 is a Friday, its week 12.10–18.10. */
  const at = (month: number, day: number, hour = 10, minute = 0): string => new Date(2026, month - 1, day, hour, minute).toISOString();
  const restarts = (...reasons: string[]): string => JSON.stringify({ restarts: reasons.map((reason) => ({ reason, progress: 0.2 })) });
  const counted = (startedAt: string, summary: object = {}): ReturnType<typeof block> =>
    block(`c${startedAt}`, 's', startedAt, { flags: ['discarded'], score: 0, summaryJson: JSON.stringify({ discarded: { reason: 'user', progress: 0.45 }, ...summary }) });

  it('discard weeks: 8 weeks Monday to Sunday, newest first; Esc restarts, blocks counted as 0, focus losses', () => {
    const now = new Date(2026, 9, 16, 12);
    const rows = [
      // 05.10–11.10, from Monday 00:30 to Sunday 23:30: a counted Esc after an Esc restart and a focus loss, then an Esc
      // restart, a drawing error (not shown) and a focus loss.
      counted(at(10, 5, 0, 30), { restarts: [{ reason: 'user', progress: 0.1 }, { reason: 'focus_lost', progress: 0.5 }] }),
      block('b', 's', at(10, 11, 23, 30), { summaryJson: restarts('user', 'error', 'focus_lost') }),
      // 12.10–18.10: a focus loss; an Esc restart in a diagnostic block.
      block('d', 's', at(10, 14), { summaryJson: restarts('focus_lost') }),
      block('e', 'diag', at(10, 15), { summaryJson: restarts('user') }),
      // The eighth week back starts on Monday 24.08.
      counted(at(8, 24, 8)),
      // Left out: the Sunday before the eight weeks, next week, a date that does not read.
      counted(at(8, 23, 20)),
      counted(at(10, 19, 8)),
      counted('not a date'),
      // Damaged restarts read as none; an entry with an unknown reason does not count.
      block('f', 's', at(9, 30), { summaryJson: '{"restarts":"user"}' }),
      block('g', 's', at(9, 30), { summaryJson: '{"restarts":[{"reason":"user"},{"reason":"bad"},null,3,"user"]}' }),
      block('h', 's', at(9, 30), { summaryJson: 'not json' }),
    ];
    expect(discardWeeks(rows, now)).toEqual([
      { week: '12.10–18.10', manual: 1, counted: 0, focus: 1 },
      { week: '05.10–11.10', manual: 3, counted: 1, focus: 2 },
      { week: '28.09–04.10', manual: 1, counted: 0, focus: 0 },
      { week: '21.09–27.09', manual: 0, counted: 0, focus: 0 },
      { week: '14.09–20.09', manual: 0, counted: 0, focus: 0 },
      { week: '07.09–13.09', manual: 0, counted: 0, focus: 0 },
      { week: '31.08–06.09', manual: 0, counted: 0, focus: 0 },
      { week: '24.08–30.08', manual: 1, counted: 1, focus: 0 },
    ]);
  });

  it('a Monday is the first day of its own week; a Sunday the last', () => {
    const monday = new Date(2026, 9, 12, 0, 5);
    expect(discardWeeks([counted(at(10, 12, 0, 1))], monday)[0]).toEqual({ week: '12.10–18.10', manual: 1, counted: 1, focus: 0 });
    const sunday = new Date(2026, 9, 18, 23, 55);
    const weeks = discardWeeks([counted(at(10, 11, 23, 59)), counted(at(10, 18, 23, 50))], sunday);
    expect(weeks.slice(0, 2)).toEqual([
      { week: '12.10–18.10', manual: 1, counted: 1, focus: 0 },
      { week: '05.10–11.10', manual: 1, counted: 1, focus: 0 },
    ]);
  });

  it('loadProgressModel reads the weeks from the block history', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('s', at(10, 14), { endedAt: at(10, 14, 11) }));
    await repo.addBlock(counted(at(10, 14), { restarts: [{ reason: 'focus_lost', progress: 0.3 }] }), [], []);
    const model = await loadProgressModel(repo, new Date(2026, 9, 16, 12));
    expect(model.discards).toHaveLength(8);
    expect(model.discards[0]).toEqual({ week: '12.10–18.10', manual: 1, counted: 1, focus: 1 });
    expect((await loadProgressModel(new MemoryRepository(), new Date(2026, 9, 16, 12))).discards.every((w) => w.manual + w.counted + w.focus === 0)).toBe(true);
  });
});
