import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diagnosticSeriesSchedule } from './diagnostic';
import { expectedScore, targetDifficulty } from './elo';
import { R_FORMAT, levelStep, ratingStep, stepName } from './levelSteps';
import { L_NORM } from './planner';

describe('levelStep', () => {
  it('half the format level, the format level, then every 5 levels with no ceiling', () => {
    expect(levelStep(0, 12)).toEqual({ step: 1, name: 'начальная', nextStepL: 6 });
    expect(levelStep(5.5, 12).step).toBe(1);
    expect(levelStep(6, 12)).toEqual({ step: 2, name: 'на подходе к формату теста', nextStepL: 12 });
    expect(levelStep(11.5, 12).step).toBe(2);
    expect(levelStep(12, 12)).toEqual({ step: 3, name: 'формат теста', nextStepL: 17 });
    expect(levelStep(13.5, 12)).toEqual({ step: 3, name: 'формат теста', nextStepL: 17 });
    expect(levelStep(17, 12)).toEqual({ step: 4, name: 'сверх нормы', nextStepL: 22 });
    expect(levelStep(22, 12)).toEqual({ step: 5, name: 'далеко сверх нормы', nextStepL: 27 });
    expect(levelStep(100, 12)).toEqual({ step: 20, name: 'далеко сверх нормы', nextStepL: 102 });
    expect(levelStep(4, 9).nextStepL).toBe(4.5);
    expect(levelStep(4.5, 9)).toEqual({ step: 2, name: 'на подходе к формату теста', nextStepL: 9 });
  });

  it('number series have no level: L_norm 0 is refused, so are a negative or non-finite L', () => {
    expect(L_NORM.numseries).toBe(0);
    expect(() => levelStep(0, L_NORM.numseries)).toThrow(RangeError);
    expect(() => levelStep(-0.5, 12)).toThrow(RangeError);
    expect(() => levelStep(Number.NaN, 12)).toThrow(RangeError);
    expect(() => levelStep(Number.POSITIVE_INFINITY, 12)).toThrow(RangeError);
    expect(() => levelStep(3, Number.NaN)).toThrow(RangeError);
    expect(() => levelStep(3, -12)).toThrow(RangeError);
  });

  it('the next step starts at nextStepL, and the step never falls as L grows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        fc.constantFrom(6, 9, 10, 12, 14),
        (i, j, Lnorm) => {
          const [a, b] = i <= j ? [i / 2, j / 2] : [j / 2, i / 2];
          const s = levelStep(a, Lnorm);
          expect(a).toBeLessThan(s.nextStepL);
          expect(levelStep(s.nextStepL, Lnorm).step).toBe(s.step + 1);
          expect(levelStep(b, Lnorm).step).toBeGreaterThanOrEqual(s.step);
          expect(s.name).toBe(stepName(s.step));
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('stepName', () => {
  it('names steps 1–4 and «далеко сверх нормы» from step 5 on', () => {
    expect([1, 2, 3, 4, 5, 6].map(stepName)).toEqual([
      'начальная',
      'на подходе к формату теста',
      'формат теста',
      'сверх нормы',
      'далеко сверх нормы',
      'далеко сверх нормы',
    ]);
  });

  it('refuses a step that is not a whole number from 1', () => {
    expect(() => stepName(0)).toThrow(RangeError);
    expect(() => stepName(1.5)).toThrow(RangeError);
    expect(() => stepName(Number.NaN)).toThrow(RangeError);
  });
});

describe('ratingStep', () => {
  it('rating steps around R_format', () => {
    expect(ratingStep(1000)).toEqual({ step: 1, name: 'начальная', nextStepR: 1100 });
    expect(ratingStep(1099.9).step).toBe(1);
    expect(ratingStep(1100)).toEqual({ step: 2, name: 'на подходе к формату теста', nextStepR: 1376 });
    expect(ratingStep(1375.9).step).toBe(2);
    expect(ratingStep(1376)).toEqual({ step: 3, name: 'формат теста', nextStepR: 1576 });
    expect(ratingStep(1576)).toEqual({ step: 4, name: 'сверх нормы', nextStepR: 1776 });
    expect(ratingStep(2176)).toEqual({ step: 7, name: 'далеко сверх нормы', nextStepR: 2376 });
    expect(() => ratingStep(Number.NaN)).toThrow(RangeError);
    expect(() => ratingStep(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });

  it('the next step starts at nextStepR', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40_000 }), (i) => {
        const R = i / 10;
        const s = ratingStep(R);
        expect(R).toBeLessThan(s.nextStepR);
        expect(ratingStep(s.nextStepR).step).toBe(s.step + 1);
      }),
      { numRuns: 1000 },
    );
  });

  it('R_format: diagnostic-format items (mean D 1185) are solved with p ≈ 0.75', () => {
    const ds = diagnosticSeriesSchedule().map((e) => e.targetD);
    expect(ds.reduce((a, b) => a + b, 0) / ds.length).toBe(1185);
    expect(expectedScore(R_FORMAT, 1185)).toBeCloseTo(0.75, 3);
    expect(Math.round(targetDifficulty(R_FORMAT))).toBe(1185);
  });
});
