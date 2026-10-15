import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../engine/rng';
import { pzmr } from './pzmr';

const levelPair = fc
  .tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a]));

describe('pzmr.params', () => {
  it.each([
    [0, 1000],
    [8, 456],
    [16, 260],
    [24, 190],
    [32, 164],
  ])('L=%i → windowMs %i', (L, windowMs) => {
    expect(pzmr.params(L).windowMs).toBe(windowMs);
  });

  it('ISI range widens at L ≥ 25', () => {
    expect(pzmr.params(0)).toMatchObject({ isiMin: 500, isiMax: 2500 });
    expect(pzmr.params(24)).toMatchObject({ isiMin: 500, isiMax: 2500 });
    expect(pzmr.params(25)).toMatchObject({ isiMin: 300, isiMax: 3500 });
    expect(pzmr.params(32)).toMatchObject({ isiMin: 300, isiMax: 3500 });
  });

  it('windowMs never grows, stays finite and ≥ 150', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        const pa = pzmr.params(a);
        const pb = pzmr.params(b);
        expect(pb.windowMs).toBeLessThanOrEqual(pa.windowMs);
        for (const v of Object.values(pb)) expect(Number.isFinite(v)).toBe(true);
        expect(pb.windowMs).toBeGreaterThanOrEqual(150);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('pzmr.cvMax', () => {
  it('0.19 at every level (F2)', () => {
    expect(pzmr.cvMax).toBe(0.19);
  });
});

describe('pzmr.generateBlock', () => {
  it('default length is blockSize 15, size overrides', () => {
    expect(pzmr.blockSize).toBe(15);
    expect(pzmr.generateBlock(pzmr.params(0), createRng(1), 'keyboard')).toHaveLength(15);
    expect(pzmr.generateBlock(pzmr.params(0), createRng(1), 'keyboard', 50)).toHaveLength(50);
  });

  it('red circle, single key, ISI within range', () => {
    for (const [L, min, max] of [
      [0, 500, 2500],
      [30, 300, 3500],
    ] as const) {
      const p = pzmr.params(L);
      const block = pzmr.generateBlock(p, createRng(7), 'pult', 300);
      for (const t of block) {
        expect(t.stimulus).toEqual({ kind: 'shape', shape: 'circle', color: 'red' });
        expect(t.expected).toEqual({ kind: 'press', key: 'ArrowDown' });
        expect(t.windowMs).toBe(p.windowMs);
        expect(Number.isInteger(t.isiMs)).toBe(true);
        expect(t.isiMs).toBeGreaterThanOrEqual(min);
        expect(t.isiMs).toBeLessThanOrEqual(max);
      }
    }
  });

  it('uses the layout key', () => {
    const keyOf = (layout: 'keyboard' | 'mouse') =>
      pzmr.generateBlock(pzmr.params(0), createRng(1), layout)[0]?.expected;
    expect(keyOf('keyboard')).toEqual({ kind: 'press', key: 'Space' });
    expect(keyOf('mouse')).toEqual({ kind: 'press', key: 'MouseLeft' });
  });

  it('is deterministic for a seed', () => {
    const p = pzmr.params(10);
    expect(pzmr.generateBlock(p, createRng(42), 'keyboard')).toEqual(
      pzmr.generateBlock(p, createRng(42), 'keyboard'),
    );
    expect(pzmr.generateBlock(p, createRng(42), 'keyboard')).not.toEqual(
      pzmr.generateBlock(p, createRng(43), 'keyboard'),
    );
  });

  it.each([0, -1, 2.5, NaN])('rejects size %s', (size) => {
    expect(() => pzmr.generateBlock(pzmr.params(0), createRng(1), 'keyboard', size)).toThrow(RangeError);
  });
});

describe('pzmr texts', () => {
  it('instruction names the key', () => {
    expect(pzmr.instruction('keyboard', pzmr.params(0))).toBe(
      'Когда появится красный круг, как можно быстрее нажми Пробел. Не нажимай заранее: это фальстарт.',
    );
    expect(pzmr.instruction('mouse', pzmr.params(0))).toContain('нажми ЛКМ.');
  });

  it('describeParams', () => {
    expect(pzmr.describeParams(pzmr.params(0))).toEqual([{ label: 'Окно ответа', value: '1000 мс' }]);
  });
});
