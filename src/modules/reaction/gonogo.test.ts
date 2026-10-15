import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../engine/rng';
import { gonogo } from './gonogo';

const levelPair = fc
  .tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a]));

describe('gonogo.params', () => {
  it.each([
    [0, 1000, 0.1, 'green_circle'],
    [8, 516, 0.18, 'green_circle'],
    [16, 308, 0.26, 'green_circle'],
    [24, 218, 0.34, 'red_square'],
    [32, 179, 0.35, 'red_square'],
  ] as const)('L=%i → window %i, no-go ratio %f, no-go %s', (L, windowMs, ratio, noGo) => {
    const p = gonogo.params(L);
    expect(p.windowMs).toBe(windowMs);
    expect(p.noGoRatio).toBeCloseTo(ratio, 12);
    expect(p.noGoStimulus).toBe(noGo);
  });

  it('no-go switches to red square at L = 20', () => {
    expect(gonogo.params(19.99).noGoStimulus).toBe('green_circle');
    expect(gonogo.params(20).noGoStimulus).toBe('red_square');
  });

  it('monotone: window never grows, no-go ratio never drops', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        const pa = gonogo.params(a);
        const pb = gonogo.params(b);
        expect(pb.windowMs).toBeLessThanOrEqual(pa.windowMs);
        expect(pb.noGoRatio).toBeGreaterThanOrEqual(pa.noGoRatio);
        expect(Number.isFinite(pb.windowMs)).toBe(true);
        expect(Number.isFinite(pb.noGoRatio)).toBe(true);
        expect(pb.windowMs).toBeGreaterThanOrEqual(150);
        expect(pb.noGoRatio).toBeLessThanOrEqual(0.35);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('gonogo.cvMax', () => {
  it('0.205 at every level (F2)', () => {
    expect(gonogo.cvMax).toBe(0.205);
  });
});

describe('gonogo.generateBlock', () => {
  it('default length is blockSize 20, size overrides', () => {
    expect(gonogo.blockSize).toBe(20);
    expect(gonogo.generateBlock(gonogo.params(0), createRng(1), 'keyboard')).toHaveLength(20);
    expect(gonogo.generateBlock(gonogo.params(10), createRng(1), 'keyboard', 60)).toHaveLength(60);
  });

  it.each([
    [0, 20, 2],
    [8, 20, 4],
    [16, 20, 5],
    [24, 20, 7],
    [32, 20, 7],
    [10, 60, 12],
  ])('L=%i, size %i → %i no-go trials (R2)', (L, size, noGo) => {
    for (let seed = 1; seed <= 20; seed++) {
      const block = gonogo.generateBlock(gonogo.params(L), createRng(seed), 'keyboard', size);
      expect(block.filter((t) => t.expected.kind === 'withhold')).toHaveLength(noGo);
    }
  });

  it('go = red circle with the key, no-go stimulus per level, ISI in range', () => {
    for (const [L, noGo] of [
      [0, { kind: 'shape', shape: 'circle', color: 'green' }],
      [25, { kind: 'shape', shape: 'square', color: 'red' }],
    ] as const) {
      const p = gonogo.params(L);
      for (const t of gonogo.generateBlock(p, createRng(5), 'pult', 200)) {
        expect(t.windowMs).toBe(p.windowMs);
        expect(Number.isInteger(t.isiMs)).toBe(true);
        expect(t.isiMs).toBeGreaterThanOrEqual(500);
        expect(t.isiMs).toBeLessThanOrEqual(2500);
        if (t.expected.kind === 'withhold') {
          expect(t.stimulus).toEqual(noGo);
        } else {
          expect(t.expected).toEqual({ kind: 'press', key: 'ArrowDown' });
          expect(t.stimulus).toEqual({ kind: 'shape', shape: 'circle', color: 'red' });
        }
      }
    }
  });

  it('no-go positions are shuffled', () => {
    const p = gonogo.params(10);
    const positions = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      const block = gonogo.generateBlock(p, createRng(seed), 'keyboard');
      positions.add(block.map((t) => (t.expected.kind === 'withhold' ? 'N' : 'G')).join(''));
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  it('is deterministic for a seed', () => {
    const p = gonogo.params(10);
    expect(gonogo.generateBlock(p, createRng(4), 'mouse')).toEqual(gonogo.generateBlock(p, createRng(4), 'mouse'));
  });
});

describe('gonogo texts', () => {
  it('instruction names go, no-go and key', () => {
    expect(gonogo.instruction('keyboard', gonogo.params(0))).toBe(
      'На красный круг нажимай Пробел. На зелёный круг не нажимай ничего.',
    );
    expect(gonogo.instruction('mouse', gonogo.params(20))).toBe(
      'На красный круг нажимай ЛКМ. На красный квадрат не нажимай ничего.',
    );
  });

  it('describeParams', () => {
    expect(gonogo.describeParams(gonogo.params(10))).toEqual([
      { label: 'Окно ответа', value: '446 мс' },
      { label: 'Доля no-go', value: '20 %' },
    ]);
    expect(gonogo.describeParams(gonogo.params(24))[1]).toEqual({ label: 'Доля no-go', value: '34 %' });
  });
});
