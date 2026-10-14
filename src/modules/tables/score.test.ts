import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../engine/rng';
import { generateGorbovTable, taskSequence, type TableCell } from './gorbov';
import { describeTableParams, reshuffle, scoreTableRun, type TableClick, type TableRun } from './score';

const black = (value: number): TableCell => ({ value, color: 'black' });
const red = (value: number): TableCell => ({ value, color: 'red' });

/** Correct clicks for the first `n` steps of a sequence, 1 s apart starting at startTs + 1000. */
function correctClicks(cells: readonly TableCell[], n: number, startTs: number): TableClick[] {
  return cells.slice(0, n).map((cell, i) => ({ cell, ts: startTs + 1000 * (i + 1) }));
}

function blackUpRun(clicks: TableClick[], overrides: Partial<TableRun> = {}): TableRun {
  return { task: 'black_up', startTs: 500, timeLimitMs: 120000, total: 24, clicks, ...overrides };
}

describe('scoreTableRun', () => {
  it('24 correct clicks before the deadline → score 1, completed, timeMs from the last correct click', () => {
    const r = scoreTableRun(blackUpRun(correctClicks(taskSequence('black_up'), 24, 500)));
    expect(r).toEqual({ score: 1, timeMs: 24000, errors: 0, correct: 24, completed: true });
  });

  it('2 errors → (24 − 2) / 24, errors do not advance the sequence', () => {
    const seq = taskSequence('black_up');
    const clicks: TableClick[] = [
      { cell: seq[0] as TableCell, ts: 1000 },
      { cell: black(5), ts: 1500 }, // wrong value
      { cell: red(2), ts: 1800 }, // right value, wrong color
      ...seq.slice(1).map((cell, i) => ({ cell, ts: 2000 + 100 * i })),
    ];
    const r = scoreTableRun(blackUpRun(clicks));
    expect(r.correct).toBe(24);
    expect(r.errors).toBe(2);
    expect(r.completed).toBe(true);
    expect(r.score).toBeCloseTo(22 / 24, 12);
    expect(r.timeMs).toBe(2000 + 100 * 22 - 500);
  });

  it('clicks after the deadline are ignored; a click exactly at the deadline counts', () => {
    const seq = taskSequence('black_up');
    const deadline = 500 + 120000;
    const clicks: TableClick[] = [
      ...correctClicks(seq, 10, 500),
      { cell: seq[10] as TableCell, ts: deadline },
      { cell: seq[11] as TableCell, ts: deadline + 1 },
      { cell: black(99), ts: deadline + 2 },
    ];
    const r = scoreTableRun(blackUpRun(clicks));
    expect(r).toEqual({ score: 11 / 24, timeMs: null, errors: 0, correct: 11, completed: false });
  });

  it('sorts clicks by ts before walking them', () => {
    const seq = taskSequence('black_up');
    const clicks = correctClicks(seq, 24, 500).reverse();
    expect(scoreTableRun(blackUpRun(clicks)).completed).toBe(true);
  });

  it('score is floored at 0 when errors exceed correct clicks', () => {
    const clicks: TableClick[] = [
      { cell: black(7), ts: 600 },
      { cell: black(8), ts: 700 },
      { cell: black(1), ts: 800 },
    ];
    const r = scoreTableRun(blackUpRun(clicks));
    expect(r).toEqual({ score: 0, timeMs: null, errors: 2, correct: 1, completed: false });
  });

  it('no clicks → zeros', () => {
    expect(scoreTableRun(blackUpRun([]))).toEqual({ score: 0, timeMs: null, errors: 0, correct: 0, completed: false });
  });

  it('a click after the sequence is exhausted counts as an error', () => {
    const clicks = [...correctClicks(taskSequence('black_up'), 24, 500), { cell: black(24), ts: 30000 }];
    const r = scoreTableRun(blackUpRun(clicks));
    expect(r.errors).toBe(1);
    expect(r.completed).toBe(true);
    expect(r.score).toBeCloseTo(23 / 24, 12);
  });

  it('red_down and alternate follow their own sequences', () => {
    const redRun = scoreTableRun({
      task: 'red_down',
      startTs: 0,
      timeLimitMs: 120000,
      total: 25,
      clicks: correctClicks(taskSequence('red_down'), 25, 0),
    });
    expect(redRun).toMatchObject({ score: 1, completed: true, timeMs: 25000 });

    const altRun = scoreTableRun({
      task: 'alternate',
      startTs: 0,
      timeLimitMs: 192000,
      total: 49,
      clicks: correctClicks(taskSequence('alternate'), 49, 0),
    });
    expect(altRun).toMatchObject({ score: 1, completed: true, timeMs: 49000 });
  });

  it('schulte derives the size from √total', () => {
    const run: TableRun = {
      task: 'schulte',
      startTs: 100,
      timeLimitMs: 60000,
      total: 25,
      clicks: correctClicks(taskSequence('schulte', 5), 25, 100),
    };
    expect(scoreTableRun(run)).toMatchObject({ score: 1, completed: true, timeMs: 25000 });
  });

  it('rejects inconsistent runs', () => {
    expect(() => scoreTableRun({ task: 'schulte', startTs: 0, timeLimitMs: 1, total: 24, clicks: [] })).toThrow(
      RangeError,
    );
    expect(() => scoreTableRun(blackUpRun([], { total: 23 }))).toThrow(RangeError);
    expect(() => scoreTableRun(blackUpRun([], { total: 0 }))).toThrow(RangeError);
  });

  it('property: score in [0,1], correct + errors = counted clicks, completed ⇔ correct = total', () => {
    const clickArb = fc.record({
      cell: fc.record({ value: fc.integer({ min: 1, max: 25 }), color: fc.constantFrom('red', 'black' as const) }),
      ts: fc.integer({ min: 0, max: 200000 }),
    });
    fc.assert(
      fc.property(fc.array(clickArb, { maxLength: 80 }), (clicks) => {
        const r = scoreTableRun(blackUpRun(clicks));
        const counted = clicks.filter((c) => c.ts <= 500 + 120000).length;
        expect(r.correct + r.errors).toBe(counted);
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
        expect(r.completed).toBe(r.correct === 24);
        expect(r.timeMs === null).toBe(!r.completed);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('reshuffle', () => {
  it('returns a permutation and leaves the input untouched', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const cells = generateGorbovTable(createRng(seed));
        const snapshot = cells.map((c) => ({ ...c }));
        const out = reshuffle(cells, createRng(seed + 1));
        expect(cells).toEqual(snapshot);
        expect(out).not.toBe(cells);
        const key = (c: TableCell): string => `${c.color}${String(c.value)}`;
        expect(out.map(key).sort()).toEqual(cells.map(key).sort());
      }),
      { numRuns: 1000 },
    );
  });

  it('changes the order for a typical seed', () => {
    const cells = generateGorbovTable(createRng(3));
    expect(reshuffle(cells, createRng(4))).not.toEqual(cells);
  });
});

describe('describeTableParams', () => {
  it('describes a Gorbov level without reshuffling', () => {
    expect(describeTableParams({ timeLimitMs: 120000, reshuffleEvery: null, size: 7 })).toEqual([
      { label: 'Лимит времени', value: '120 с' },
      { label: 'Перемешивание', value: 'нет' },
      { label: 'Размер', value: '7×7' },
    ]);
  });

  it('describes reshuffling and rounds seconds', () => {
    expect(describeTableParams({ timeLimitMs: 15400, reshuffleEvery: 9, size: 7 })).toEqual([
      { label: 'Лимит времени', value: '15 с' },
      { label: 'Перемешивание', value: 'каждые 9 верных' },
      { label: 'Размер', value: '7×7' },
    ]);
  });
});
