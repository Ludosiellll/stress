import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BAND_LABELS,
  KEYBOARD_OFFSET_MS,
  NORMS,
  NORM_HINTS,
  cutText,
  gradeByBands,
  type NormId,
  type NormTable,
} from './norms';

const bands = (id: NormId, vs: number[]) => vs.map((v) => gradeByBands(v, NORMS[id]).band);
const NORM_IDS = Object.keys(NORMS) as NormId[];

describe('gradeByBands', () => {
  it('percentile tables: the middle band is closed, the outer ones strict', () => {
    expect(bands('pzmrMean', [224.9, 225, 233.9, 234, 267, 267.1, 277, 277.1])).toEqual([5, 4, 4, 3, 3, 2, 2, 1]);
    expect(bands('pzmrSd', [36.9, 37, 45, 68, 68.5, 87, 87.5])).toEqual([5, 4, 3, 3, 2, 2, 1]);
    expect(bands('szmrMean', [325.9, 326, 342, 382, 382.1, 412, 412.1])).toEqual([5, 4, 3, 3, 2, 2, 1]);
  });

  it('the paper Gorbov scale and the span: whole bounds inclusive', () => {
    expect(bands('gorbovSimple', [29, 29.1, 37, 37.1, 50, 50.1, 60, 60.1, 61])).toEqual([5, 4, 4, 3, 3, 2, 2, 1, 1]);
    expect(bands('gorbovAlternate', [130, 130.5, 170, 171, 260, 261, 320, 321])).toEqual([5, 4, 4, 3, 3, 2, 2, 1]);
    expect(bands('memorySpan', [12, 9, 8, 7, 6, 5, 0])).toEqual([5, 5, 4, 3, 2, 1, 1]);
  });

  it('label, next band and its bound', () => {
    expect(BAND_LABELS).toEqual(['низкий', 'ниже среднего', 'средний', 'выше среднего', 'высокий']);
    expect(gradeByBands(44, NORMS.gorbovSimple)).toEqual({
      band: 3,
      label: 'средний',
      nextLabel: 'выше среднего',
      toNext: { at: 37, inclusive: true },
    });
    expect(gradeByBands(300, NORMS.pzmrMean)).toMatchObject({
      band: 1,
      nextLabel: 'ниже среднего',
      toNext: { at: 277, inclusive: true },
    });
    expect(gradeByBands(220, NORMS.pzmrMean)).toEqual({ band: 5, label: 'высокий', nextLabel: null, toNext: null });
    expect(cutText(NORMS.gorbovSimple.cuts[1], NORMS.gorbovSimple)).toBe('до 37 с');
    expect(cutText(NORMS.pzmrMean.cuts[1], NORMS.pzmrMean)).toBe('меньше 234 мс');
    expect(cutText(NORMS.memorySpan.cuts[1], NORMS.memorySpan)).toBe('от 8');
    const [, c1, c2, c3] = NORMS.memorySpan.cuts;
    const strict: NormTable = { ...NORMS.memorySpan, cuts: [{ at: 8, inclusive: false }, c1, c2, c3] };
    expect(cutText(strict.cuts[0], strict)).toBe('больше 8');
    expect(gradeByBands(8, strict).band).toBe(4);
  });

  it('RT tables are the published percentiles + 30 ms on a keyboard; SD has no offset', () => {
    expect(KEYBOARD_OFFSET_MS).toBe(30);
    expect(NORMS.pzmrMean.cuts.map((c) => c.at - KEYBOARD_OFFSET_MS)).toEqual([195, 204, 237, 247]);
    expect(NORMS.szmrMean.cuts.map((c) => c.at - KEYBOARD_OFFSET_MS)).toEqual([296, 312, 352, 382]);
    expect(NORMS.pzmrSd.cuts.map((c) => c.at)).toEqual([37, 45, 68, 87]);
  });

  it('every table names its source and condition', () => {
    const described = Object.fromEntries(
      NORM_IDS.map((id) => {
        const { better, unit, metric, rating, note } = NORMS[id];
        return [id, { better, unit, metric, rating, note }];
      }),
    );
    expect(described).toEqual({
      pzmrMean: {
        better: 'lower',
        unit: 'мс',
        metric: 'среднее',
        rating: 'A',
        note: 'Мальцев 2026, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру',
      },
      pzmrSd: {
        better: 'lower',
        unit: 'мс',
        metric: 'разброс (SD)',
        rating: 'A',
        note: 'Мальцев 2026, юноши 18–21, аппаратная кнопка',
      },
      szmrMean: {
        better: 'lower',
        unit: 'мс',
        metric: 'среднее',
        rating: 'A',
        note: 'Мальцев 2026, выбор из 2, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру',
      },
      gorbovSimple: {
        better: 'lower',
        unit: 'с',
        metric: null,
        rating: 'C/B',
        note: 'Бумажная методика, источник не указан',
      },
      gorbovAlternate: {
        better: 'lower',
        unit: 'с',
        metric: null,
        rating: 'C/B',
        note: 'Бумажная методика, источник не указан',
      },
      memorySpan: {
        better: 'higher',
        unit: '',
        metric: 'объём',
        rating: 'A',
        note: 'Woods 2011, молодые взрослые, слуховое предъявление',
      },
    });
    expect(NORMS.gorbovSimple.cuts).toEqual([
      { at: 29, inclusive: true },
      { at: 37, inclusive: true },
      { at: 50, inclusive: true },
      { at: 60, inclusive: true },
    ]);
    expect(NORMS.gorbovAlternate.cuts.map((c) => c.at)).toEqual([130, 170, 260, 320]);
    expect(NORMS.memorySpan.cuts).toEqual([
      { at: 9, inclusive: true },
      { at: 8, inclusive: true },
      { at: 7, inclusive: true },
      { at: 6, inclusive: true },
    ]);
    expect(NORMS.pzmrMean.cuts.map((c) => c.inclusive)).toEqual([false, false, true, true]);
  });

  it('the tables are frozen', () => {
    expect(Object.isFrozen(NORMS)).toBe(true);
    for (const id of NORM_IDS) {
      expect(Object.isFrozen(NORMS[id])).toBe(true);
      expect(Object.isFrozen(NORMS[id].cuts)).toBe(true);
      for (const cut of NORMS[id].cuts) expect(Object.isFrozen(cut)).toBe(true);
    }
    expect(Object.isFrozen(BAND_LABELS)).toBe(true);
    expect(Object.isFrozen(NORM_HINTS)).toBe(true);
  });

  it('NORM_HINTS are the exact texts', () => {
    expect(NORM_HINTS).toEqual({
      gonogo: 'Ориентир: ошибки на no-go у студентов 7–21 % при 30 % no-go, в зависимости от темпа (Hasegawa 2020).',
      stroop:
        'Ориентир: интерференция у молодых взрослых обычно 60–90 мс; меньше 40 — выше среднего, больше 150 — ниже среднего (Rouder 2023, клавиатура).',
      taskswitch: 'Ориентир: цена переключения при короткой подсказке обычно около 60 ± 70 мс (Stasenko 2017).',
      schulte5: 'Ориентир: для Шульте 5×5 традиционная норма взрослых на бумаге 40–50 с, хороший результат 25–30 с.',
    });
  });

  it('every table runs its cuts from the best band to the worst, without a repeat', () => {
    for (const id of NORM_IDS) {
      const { better, cuts } = NORMS[id];
      const at = cuts.map((c) => c.at);
      const ordered = [...at].sort((a, b) => (better === 'lower' ? a - b : b - a));
      expect(at, id).toEqual(ordered);
      expect(new Set(at).size, id).toBe(at.length);
    }
  });

  it('a band below the top always has the next band and its bound (the type says so)', () => {
    const g = gradeByBands(44, NORMS.gorbovSimple);
    if (g.band === 5) throw new Error('44 s is not the top band');
    // Typed as string and NormCut below band 5: no null to guard.
    const next: string = g.nextLabel;
    const at: number = g.toNext.at;
    expect([next, at]).toEqual(['выше среднего', 37]);
  });

  it('cutText writes a fractional bound with a decimal comma', () => {
    expect(cutText({ at: 29.5, inclusive: true }, NORMS.gorbovSimple)).toBe('до 29,5 с');
    expect(cutText({ at: 7.5, inclusive: false }, NORMS.memorySpan)).toBe('больше 7,5');
  });

  it('rejects a value that is not a finite number', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => gradeByBands(v, NORMS.pzmrMean)).toThrow(RangeError);
    }
  });

  it('a better value never gets a worse band', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NORM_IDS),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        (id, x, y) => {
          const [a, b] = x <= y ? [x, y] : [y, x];
          const table = NORMS[id];
          const ba = gradeByBands(a, table).band;
          const bb = gradeByBands(b, table).band;
          if (table.better === 'lower') expect(ba).toBeGreaterThanOrEqual(bb);
          else expect(ba).toBeLessThanOrEqual(bb);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('every band but the top names the next band and its bound', () => {
    fc.assert(
      fc.property(fc.constantFrom(...NORM_IDS), fc.double({ min: 0, max: 1000, noNaN: true }), (id, v) => {
        const g = gradeByBands(v, NORMS[id]);
        expect(g.label).toBe(BAND_LABELS[g.band - 1]);
        if (g.band === 5) {
          expect(g.nextLabel).toBeNull();
          expect(g.toNext).toBeNull();
        } else {
          expect(g.nextLabel).toBe(BAND_LABELS[g.band]);
          expect(g.toNext).toBe(NORMS[id].cuts[4 - g.band]);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
