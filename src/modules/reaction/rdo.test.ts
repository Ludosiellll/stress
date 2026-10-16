import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed } from '../../engine/rng';
import { RDO_PERIODS, rdo, rdoPeriod } from './rdo';

const levelPair = fc
  .tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a]));

describe('rdo.params', () => {
  it('the tolerance is the level (F14): 60 / 44 / 32 / 24 / 17 ms at L 0 / 5 / 10 / 15 / 20', () => {
    expect([0, 5, 10, 15, 20].map((L) => rdo.params(L).toleranceMs)).toEqual([60, 44, 32, 24, 17]);
  });

  it.each([0, 8, 16, 24, 32])('L=%i: the period is the test speed 3000 ms, 20 trials', (L) => {
    expect(rdo.params(L)).toEqual({ periodMs: 3000, toleranceMs: Math.round(Math.max(10, 60 * 0.94 ** L)), isiMin: 800, isiMax: 1500, trials: 20 });
    expect(rdo.trials(rdo.params(L))).toBe(20);
  });

  it('monotone: the tolerance never grows and holds its floor; the period stays 3000', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        const pa = rdo.params(a);
        const pb = rdo.params(b);
        expect(pb.periodMs).toBe(3000);
        expect(pb.toleranceMs).toBeLessThanOrEqual(pa.toleranceMs);
        for (const v of Object.values(pb)) expect(Number.isFinite(v)).toBe(true);
        expect(pb.toleranceMs).toBeGreaterThanOrEqual(10);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('rdoPeriod (F14)', () => {
  it('RDO_PERIODS: the four speeds, the test one included', () => {
    expect(RDO_PERIODS).toEqual([1500, 2000, 3000, 4000]);
  });

  it('block i plays element i mod 4 of the segment\'s shuffle', () => {
    const order = createRng(deriveSeed(7, 'rdo:2')).shuffle(RDO_PERIODS);
    expect([0, 1, 2, 3, 4, 9].map((i) => rdoPeriod(7, 2, i))).toEqual([0, 1, 2, 3, 0, 1].map((k) => order[k]));
  });

  it('any four blocks in a row hold each speed once', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), fc.nat(20), fc.nat(1000), (seed, segment, from) => {
        const speeds = [0, 1, 2, 3].map((k) => rdoPeriod(seed, segment, from + k));
        expect([...speeds].sort((x, y) => x - y)).toEqual([...RDO_PERIODS]);
      }),
      { numRuns: 1000 },
    );
  });

  it('blocks i and i + 4 share the speed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), fc.nat(20), fc.nat(1000), (seed, segment, i) => {
        expect(rdoPeriod(seed, segment, i + 4)).toBe(rdoPeriod(seed, segment, i));
      }),
      { numRuns: 1000 },
    );
  });

  it('segments draw their own order', () => {
    const orders = new Set([0, 1, 2, 3, 4, 5].map((seg) => [0, 1, 2, 3].map((i) => rdoPeriod(11, seg, i)).join(',')));
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('rdo.cvMax', () => {
  it('is null (no RT stability check)', () => {
    expect(rdo.cvMax).toBeNull();
  });
});

describe('rdo.generateBlock', () => {
  it('default length is blockSize 20, size overrides', () => {
    expect(rdo.blockSize).toBe(20);
    expect(rdo.generateBlock(rdo.params(0), createRng(1), 'keyboard')).toHaveLength(20);
    expect(rdo.generateBlock(rdo.params(0), createRng(1), 'keyboard', 50)).toHaveLength(50);
  });

  it('target, offset and window are consistent with start + sweep, at every speed', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1000, noNaN: true }), fc.constantFrom(...RDO_PERIODS), fc.integer(), (L, periodMs, seed) => {
        const p = { ...rdo.params(L), periodMs };
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

  it('describeParams: the tolerance, the one level lever (the period turns with the block, F14)', () => {
    expect(rdo.describeParams(rdo.params(8))).toEqual([{ label: 'Допуск', value: '37 мс' }]);
  });
});
