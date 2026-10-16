import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../engine/rng';
import {
  generateGorbovTable,
  gorbovMetrics,
  gorbovParams,
  gorbovTaskForRun,
  SAME_TABLE_NOTE,
  taskSequence,
  tableInstruction,
  type TableCell,
} from './gorbov';

const black = (value: number): TableCell => ({ value, color: 'black' });
const red = (value: number): TableCell => ({ value, color: 'red' });

const levelPair = fc
  .tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a]));

describe('gorbovParams', () => {
  it('pins the time limits at L=0', () => {
    expect(gorbovParams(0, 'black_up')).toEqual({ timeLimitMs: 120000, reshuffleEvery: null, size: 7 });
    expect(gorbovParams(0, 'red_down').timeLimitMs).toBe(120000);
    expect(gorbovParams(0, 'alternate').timeLimitMs).toBe(192000);
  });

  it('applies the 15 s floor before the alternate multiplier', () => {
    expect(gorbovParams(100, 'black_up').timeLimitMs).toBe(15000);
    expect(gorbovParams(100, 'alternate').timeLimitMs).toBe(24000);
  });

  it('decays by 0.92 per level', () => {
    expect(gorbovParams(10, 'black_up').timeLimitMs).toBe(Math.round(120000 * 0.92 ** 10));
  });

  it.each([
    [0, null],
    [14, null],
    [14.9, null],
    [15, 10],
    [16, 10],
    [17, 9],
    [100, 1],
  ])('reshuffleEvery at L=%s is %s', (L, expected) => {
    expect(gorbovParams(L, 'black_up').reshuffleEvery).toBe(expected);
  });

  it('rejects the schulte task', () => {
    expect(() => gorbovParams(0, 'schulte')).toThrow(RangeError);
  });

  it('monotone: time limit never grows with level', () => {
    fc.assert(
      fc.property(levelPair, fc.constantFrom('black_up', 'red_down', 'alternate' as const), ([a, b], task) => {
        const pa = gorbovParams(a, task);
        const pb = gorbovParams(b, task);
        expect(pb.timeLimitMs).toBeLessThanOrEqual(pa.timeLimitMs);
        expect(pb.timeLimitMs).toBeGreaterThanOrEqual(15000);
        expect(pb.size).toBe(7);
      }),
      { numRuns: 1000 },
    );
  });

  it('monotone: reshuffleEvery is null below 15, then non-increasing and >= 1', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        const ra = gorbovParams(a, 'black_up').reshuffleEvery;
        const rb = gorbovParams(b, 'black_up').reshuffleEvery;
        if (a < 15) expect(ra).toBeNull();
        if (b < 15) {
          expect(rb).toBeNull();
        } else {
          expect(rb).not.toBeNull();
          expect(rb as number).toBeGreaterThanOrEqual(1);
          if (ra !== null) expect(rb as number).toBeLessThanOrEqual(ra);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('generateGorbovTable', () => {
  it('has exactly red 1..25 and black 1..24, each once', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const cells = generateGorbovTable(createRng(seed));
        expect(cells).toHaveLength(49);
        const reds = cells.filter((c) => c.color === 'red').map((c) => c.value);
        const blacks = cells.filter((c) => c.color === 'black').map((c) => c.value);
        expect([...reds].sort((x, y) => x - y)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
        expect([...blacks].sort((x, y) => x - y)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
      }),
      { numRuns: 1000 },
    );
  });

  it('is deterministic per seed and actually shuffled', () => {
    expect(generateGorbovTable(createRng(7))).toEqual(generateGorbovTable(createRng(7)));
    expect(generateGorbovTable(createRng(7))).not.toEqual(generateGorbovTable(createRng(8)));
  });
});

describe('taskSequence', () => {
  it('black_up is black 1..24', () => {
    expect(taskSequence('black_up')).toEqual(Array.from({ length: 24 }, (_, i) => black(i + 1)));
  });

  it('red_down is red 25..1', () => {
    expect(taskSequence('red_down')).toEqual(Array.from({ length: 25 }, (_, i) => red(25 - i)));
  });

  it('alternate is 49 steps from [b1, r25, b2, r24] to [b24, r2, r1]', () => {
    const seq = taskSequence('alternate');
    expect(seq).toHaveLength(49);
    expect(seq.slice(0, 4)).toEqual([black(1), red(25), black(2), red(24)]);
    expect(seq.slice(-3)).toEqual([black(24), red(2), red(1)]);
  });

  it('alternate visits every Gorbov cell exactly once', () => {
    const keys = taskSequence('alternate').map((c) => `${c.color}${String(c.value)}`);
    expect(new Set(keys).size).toBe(49);
  });

  it('schulte is black 1..size²', () => {
    expect(taskSequence('schulte', 3)).toEqual(Array.from({ length: 9 }, (_, i) => black(i + 1)));
  });

  it('schulte requires a positive integer size', () => {
    expect(() => taskSequence('schulte')).toThrow(RangeError);
    expect(() => taskSequence('schulte', 0)).toThrow(RangeError);
    expect(() => taskSequence('schulte', 2.5)).toThrow(RangeError);
  });
});

describe('gorbovTaskForRun', () => {
  it('cycles black_up, red_down, alternate', () => {
    expect([0, 1, 2, 3, 4, 5, 300].map(gorbovTaskForRun)).toEqual([
      'black_up',
      'red_down',
      'alternate',
      'black_up',
      'red_down',
      'alternate',
      'black_up',
    ]);
  });

  it('rejects negative and non-integer indices', () => {
    expect(() => gorbovTaskForRun(-1)).toThrow(RangeError);
    expect(() => gorbovTaskForRun(1.5)).toThrow(RangeError);
  });
});

describe('gorbovMetrics', () => {
  it('computes V, P and Pi from seconds', () => {
    expect(gorbovMetrics(40, 40, 100)).toEqual({ V: 40, P: 100, Pi: 20 });
    expect(gorbovMetrics(30, 50, 70)).toEqual({ V: 40, P: 70, Pi: -10 });
  });
});

describe('tableInstruction', () => {
  it('returns the Russian task texts', () => {
    expect(tableInstruction('black_up')).toBe('Находи и нажимай чёрные числа по порядку от 1 до 24.');
    expect(tableInstruction('red_down')).toBe('Находи и нажимай красные числа от 25 до 1.');
    expect(tableInstruction('alternate')).toBe(
      'Чередуй: чёрное по возрастанию, красное по убыванию — 1 чёрное, 25 красное, 2 чёрное, 24 красное…',
    );
    expect(tableInstruction('schulte', 6)).toBe('Нажимай числа по порядку от 1 до 36.');
  });

  it('schulte requires a size', () => {
    expect(() => tableInstruction('schulte')).toThrow(RangeError);
  });

  it('tasks 2–3 of a series add that the table is the same (F10)', () => {
    expect(tableInstruction('red_down') + SAME_TABLE_NOTE).toBe('Находи и нажимай красные числа от 25 до 1. Таблица та же, что в прошлом задании.');
  });
});
