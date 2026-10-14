import { describe, expect, it } from 'vitest';
import type { DiagnosticRow } from '../data/rows';
import { session } from '../data/repository.contract';
import { diagnosticCharts, durationText, ruDate, sessionLines, SESSION_LINES } from './progressModel';

function row(number: number, results: unknown): DiagnosticRow {
  return { id: `d${String(number)}`, sessionId: 's', number, at: '2026-10-01T10:00:00.000Z', resultsJson: typeof results === 'string' ? results : JSON.stringify(results) };
}

const full = { pzmrMedianRt: 300, szmrMedianRt: 420, gonogoScore: 85, rdoMeanAbsErrorMs: 55, gorbov: { V: 40, P: 80, Pi: 12 }, numseriesCorrect: 12 };

describe('diagnosticCharts', () => {
  it('makes six charts with the metrics of every diagnostic', () => {
    const charts = diagnosticCharts([row(1, full), row(2, { ...full, pzmrMedianRt: 290, gonogoScore: 90 })]);
    expect(charts.map((c) => c.id)).toEqual(['pzmr', 'szmr', 'gonogo', 'rdo', 'gorbov', 'numseries']);
    expect(charts[0]?.series[0]?.points).toEqual([{ x: '№1', y: 300 }, { x: '№2', y: 290 }]);
    expect(charts[2]?.series[0]?.points.map((p) => p.y)).toEqual([85, 90]);
    expect(charts.map((c) => c.lowerIsBetter)).toEqual([true, true, false, true, true, false]);
    expect(charts[4]?.series.map((s) => s.name)).toEqual(['V', 'P', 'Π']);
    expect(charts[4]?.series.map((s) => s.points[0]?.y)).toEqual([40, 80, 12]);
  });

  it('bounds every axis by what the metric can take; Π of Gorbov can be negative', () => {
    const domains = Object.fromEntries(diagnosticCharts([]).map((c) => [c.id, c.domain]));
    expect(domains).toEqual({
      pzmr: { min: 0 },
      szmr: { min: 0 },
      gonogo: { min: 0, max: 100 },
      rdo: { min: 0 },
      gorbov: {},
      numseries: { min: 0 },
    });
  });

  it('turns missing and non-finite values and unreadable rows into gaps, never zeros', () => {
    const charts = diagnosticCharts([
      row(1, { ...full, pzmrMedianRt: null, gorbov: null }),
      row(2, '{not json'),
      row(3, { ...full, szmrMedianRt: 'x', gorbov: { V: 40, P: null, Pi: 12 } }),
    ]);
    expect(charts[0]?.series[0]?.points.map((p) => p.y)).toEqual([null, null, 300]);
    expect(charts[1]?.series[0]?.points.map((p) => p.y)).toEqual([420, null, null]);
    expect(charts[4]?.series[0]?.points.map((p) => p.y)).toEqual([null, null, 40]);
    expect(charts[4]?.series[1]?.points.map((p) => p.y)).toEqual([null, null, null]);
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
