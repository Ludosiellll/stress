import { describe, expect, it } from 'vitest';
import type { DiagnosticRow } from '../data/rows';
import { block, session } from '../data/repository.contract';
import { MemoryRepository } from '../data/memoryRepository';
import { rebuildCaches } from '../data/export';
import { MODULE_IDS, type BlockFlag } from '../engine/types';
import { diagnosticCharts, durationText, formOfDayPoints, loadProgressModel, overload28d, ruDate, sessionLines, SESSION_LINES } from './progressModel';

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
        best: { mean: 250, sd: 30, errors: 2, falseStarts: 0 },
        runs: 2,
      },
      { format: 'rdo', name: 'РДО', mean: [{ x: '08.10', y: 18 }], sd: [{ x: '08.10', y: 25 }], best: { mean: 18, sd: 25, errors: 3, falseStarts: 1 }, runs: 1 },
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
