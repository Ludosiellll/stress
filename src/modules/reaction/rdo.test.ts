import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../engine/rng';
import { rdo } from './rdo';

const levelPair = fc
  .tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a]));

describe('rdo.params', () => {
  it.each([
    [0, 3000, 60],
    [8, 1679, 37],
    [16, 939, 22],
    [24, 600, 14],
    [32, 600, 10],
  ])('L=%i → period %i, tolerance %i', (L, periodMs, toleranceMs) => {
    expect(rdo.params(L)).toEqual({ periodMs, toleranceMs, isiMin: 800, isiMax: 1500 });
  });

  it('monotone: period and tolerance never grow, floors hold', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        const pa = rdo.params(a);
        const pb = rdo.params(b);
        expect(pb.periodMs).toBeLessThanOrEqual(pa.periodMs);
        expect(pb.toleranceMs).toBeLessThanOrEqual(pa.toleranceMs);
        for (const v of Object.values(pb)) expect(Number.isFinite(v)).toBe(true);
        expect(pb.periodMs).toBeGreaterThanOrEqual(600);
        expect(pb.toleranceMs).toBeGreaterThanOrEqual(10);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('rdo.cvMax', () => {
  it('is null (no RT stability check)', () => {
    expect(rdo.cvMax(0)).toBeNull();
    expect(rdo.cvMax(30)).toBeNull();
  });
});

describe('rdo.generateBlock', () => {
  it('default length is blockSize 10, size overrides', () => {
    expect(rdo.blockSize).toBe(10);
    expect(rdo.generateBlock(rdo.params(0), createRng(1), 'keyboard')).toHaveLength(10);
    expect(rdo.generateBlock(rdo.params(0), createRng(1), 'keyboard', 50)).toHaveLength(50);
  });

  it('target, offset and window are consistent with start + sweep', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1000, noNaN: true }), fc.integer(), (L, seed) => {
        const p = rdo.params(L);
        for (const t of rdo.generateBlock(p, createRng(seed), 'keyboard')) {
          if (t.stimulus.kind !== 'rdo' || t.expected.kind !== 'timed') throw new Error('expected rdo trial');
          const { startDeg, targetDeg, periodMs } = t.stimulus;
          const { key, targetOffsetMs, toleranceMs } = t.expected;
          expect(periodMs).toBe(p.periodMs);
          expect(toleranceMs).toBe(p.toleranceMs);
          expect(key).toBe('Space');
          expect(Number.isInteger(startDeg)).toBe(true);
          expect(startDeg).toBeGreaterThanOrEqual(0);
          expect(startDeg).toBeLessThanOrEqual(359);
          const sweepDeg = (targetDeg - startDeg + 360) % 360;
          expect(sweepDeg).toBeGreaterThanOrEqual(90);
          expect(sweepDeg).toBeLessThanOrEqual(330);
          expect(targetDeg).toBe((startDeg + sweepDeg) % 360);
          expect(targetOffsetMs).toBe(Math.round((sweepDeg / 360) * periodMs));
          expect(t.windowMs).toBe(targetOffsetMs + Math.round(0.25 * periodMs));
          expect(t.windowMs).toBeGreaterThanOrEqual(150);
          expect(Number.isInteger(t.isiMs)).toBe(true);
          expect(t.isiMs).toBeGreaterThanOrEqual(800);
          expect(t.isiMs).toBeLessThanOrEqual(1500);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('uses the single layout key', () => {
    const [t] = rdo.generateBlock(rdo.params(0), createRng(1), 'mouse');
    expect(t?.expected).toMatchObject({ kind: 'timed', key: 'MouseLeft' });
  });

  it('is deterministic for a seed', () => {
    const p = rdo.params(5);
    expect(rdo.generateBlock(p, createRng(8), 'pult')).toEqual(rdo.generateBlock(p, createRng(8), 'pult'));
    expect(rdo.generateBlock(p, createRng(8), 'pult')).not.toEqual(rdo.generateBlock(p, createRng(11), 'pult'));
  });
});

describe('rdo texts', () => {
  it('instruction names the key', () => {
    expect(rdo.instruction('pult', rdo.params(0))).toBe(
      'Метка бежит по кругу. Нажми ↓ точно в момент, когда она дойдёт до отметки. Важна точность, а не скорость.',
    );
  });

  it('describeParams', () => {
    expect(rdo.describeParams(rdo.params(8))).toEqual([
      { label: 'Период обхода', value: '1679 мс' },
      { label: 'Допуск', value: '37 мс' },
    ]);
  });
});
