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
    [8, 331],
    [16, 188],
    [24, 158],
    [32, 152],
  ])('L=%i → windowMs %i: round(150 + 850·0.824^L) (F3)', (L, windowMs) => {
    expect(pzmr.params(L).windowMs).toBe(windowMs);
  });

  it('the ISI range widens to 0.3–3 s from band 2 (L 8)', () => {
    expect(pzmr.params(0)).toMatchObject({ isiMin: 500, isiMax: 2500 });
    expect(pzmr.params(7.99)).toMatchObject({ isiMin: 500, isiMax: 2500 });
    expect(pzmr.params(8)).toMatchObject({ isiMin: 300, isiMax: 3000 });
    expect(pzmr.params(32)).toMatchObject({ isiMin: 300, isiMax: 3000 });
  });

  it('windowMs never grows, stays finite and ≥ 150', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        const pa = pzmr.params(a);
        const pb = pzmr.params(b);
        expect(pb.windowMs).toBeLessThanOrEqual(pa.windowMs);
        for (const v of [pb.windowMs, pb.isiMin, pb.isiMax, pb.trials, pb.band]) expect(Number.isFinite(v)).toBe(true);
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
  it('default length is the trials of the band (15 in the test format), size overrides', () => {
    expect(pzmr.blockSize).toBe(15);
    expect(pzmr.generateBlock(pzmr.params(0), createRng(1), 'keyboard')).toHaveLength(15);
    expect(pzmr.generateBlock(pzmr.params(28), createRng(1), 'keyboard')).toHaveLength(45);
    expect(pzmr.generateBlock(pzmr.params(0), createRng(1), 'keyboard', 50)).toHaveLength(50);
  });

  it('red circle, single key, ISI within range', () => {
    for (const [L, min, max] of [
      [0, 500, 2500],
      [30, 300, 3000],
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

  it('noise and sound get their notes; an overload block leaves out the sound one (M2)', () => {
    const base = 'Когда появится красный круг, как можно быстрее нажми Пробел. Не нажимай заранее: это фальстарт.';
    const figures = ' Вокруг будут появляться другие фигуры, на них не реагируй.';
    const sound = ' В блоке будут звуковые помехи, надень наушники.';
    expect(pzmr.instruction('keyboard', pzmr.params(12))).toBe(base + figures);
    expect(pzmr.instruction('keyboard', pzmr.params(16))).toBe(base + figures + sound);
    expect(pzmr.instruction('keyboard', pzmr.params(20))).toBe(base + figures + ' Вместе с фигурами будет мерцать фон.' + sound);
    expect(pzmr.instruction('keyboard', pzmr.params(20), true)).toBe(base + figures + ' Вместе с фигурами будет мерцать фон.');
  });

  it('describeParams: the window and the load (Р14)', () => {
    expect(pzmr.describeParams(pzmr.params(0))).toEqual([
      { label: 'Окно ответа', value: '1000 мс' },
      { label: 'Нагрузка', value: 'красный круг' },
    ]);
    expect(pzmr.describeParams(pzmr.params(12))).toEqual([
      { label: 'Окно ответа', value: '233 мс' },
      { label: 'Нагрузка', value: 'интервал 0,3–3 с, помехи' },
    ]);
  });
});
