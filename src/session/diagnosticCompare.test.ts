import { describe, expect, it } from 'vitest';
import { EMPTY_METRICS, EMPTY_RESULTS } from '../engine/diagnostic';
import { DIAGNOSTIC_PARAMS } from '../modules/reaction/diagnosticParams';
import { isTwoChoice } from './blockHistory';
import {
  DIAGNOSTIC_ROW_IDS,
  diagnosticChange,
  diagnosticComparable,
  diagnosticDetailLines,
  diagnosticNorm,
  diagnosticValue,
  diagnosticValueText,
} from './diagnosticCompare';

const D = { ...EMPTY_METRICS, pzmrMedianRt: 251.4, pzmrMeanRt: 262.4, szmrMedianRt: 402, szmrMeanRt: 401.6, gonogoScore: 93.3,
  rdoMeanAbsErrorMs: 18.6, gorbov: { V: 41.25, P: 70.5, Pi: -12 }, numseriesCorrect: 14, pomehQuietRt: 300, pomehNoisyRt: 335.2,
  pomehDeltaMs: 35.2, stroopCongruentRt: 520.5, stroopIncongruentRt: 610, stroopInterferenceMs: 89.5, memorySpan: 7 };

describe('diagnosticCompare', () => {
  it('values as Done shows them', () => {
    expect(DIAGNOSTIC_ROW_IDS.map((id) => diagnosticValue(D, id))).toEqual([251, 402, 93, 19, 41.3, 70.5, -12, 14, 35, 89, null, 7]);
    expect(diagnosticValue({ ...D, gorbov: null }, 'gorbovV')).toBeNull();
  });

  it('a value with its unit, in one place for the cells and the changes', () => {
    const texts = DIAGNOSTIC_ROW_IDS.map((id) => {
      const v = diagnosticValue(D, id);
      return v === null ? null : diagnosticValueText(id, v);
    });
    expect(texts).toEqual(['251 мс', '402 мс', '93 %', '19 мс', '41,3 с', '70,5 с', '−12,0 с', '14', '+35 мс', '+89 мс', null, '7']);
    expect(diagnosticValueText('stroop', -12)).toBe('−12 мс');
    expect(diagnosticValueText('pomeh', 0)).toBe('0 мс');
    expect(diagnosticValueText('gorbovPi', 0.4)).toBe('0,4 с');
  });

  it('the Горбов rows are not comparable between one table and three (F10); the other rows always are', () => {
    const one = { ...EMPTY_RESULTS, ...D, gorbovOneTable: true };
    const three = { ...EMPTY_RESULTS, ...D, gorbovOneTable: false };
    const gorbov = ['gorbovV', 'gorbovP', 'gorbovPi'] as const;
    for (const id of DIAGNOSTIC_ROW_IDS) {
      const isGorbov = (gorbov as readonly string[]).includes(id);
      expect(diagnosticComparable(id, one, three), id).toBe(!isGorbov);
      expect(diagnosticComparable(id, three, one), id).toBe(!isGorbov);
      expect(diagnosticComparable(id, one, one), id).toBe(true);
      expect(diagnosticComparable(id, three, three), id).toBe(true);
    }
  });

  it('changes: 2 % or 5 ms is no change; the direction decides better or worse', () => {
    expect(diagnosticChange('pzmr', 251, 264)).toBe('−13 мс, лучше');
    expect(diagnosticChange('pzmr', 245, 250)).toBe('−5 мс, лучше');
    expect(diagnosticChange('pzmr', 246, 250)).toBe('без изменений');
    expect(diagnosticChange('szmr', 402, 398)).toBe('без изменений');
    expect(diagnosticChange('gonogo', 93, 90)).toBe('+3 %, лучше');
    expect(diagnosticChange('rdo', 19, 25)).toBe('−6 мс, лучше');
    expect(diagnosticChange('gorbovV', 41.3, 45)).toBe('−3,7 с, лучше');
    expect(diagnosticChange('gorbovP', 102, 100)).toBe('+2,0 с, хуже');
    expect(diagnosticChange('gorbovP', 101.9, 100)).toBe('без изменений');
    expect(diagnosticChange('gorbovPi', -12, -10)).toBe('−2,0 с, лучше');
    expect(diagnosticChange('numseries', 13, 12)).toBe('+1, лучше');
    expect(diagnosticChange('memory', 6, 7)).toBe('−1, хуже');
    expect(diagnosticChange('stroop', 90, 100)).toBe('−10 мс, лучше');
    expect(diagnosticChange('stroop', 3, 0)).toBe('без изменений');
  });

  it('exactly 2 % in seconds is a change, despite floating point (A-R20)', () => {
    expect(diagnosticChange('gorbovV', 35.7, 35)).toBe('+0,7 с, хуже');
    expect(diagnosticChange('gorbovP', 71.4, 70)).toBe('+1,4 с, хуже');
    // Every previous value 0,1…400,0 s: the smallest change of at least 2 % counts, one tenth less does not.
    const wrong: string[] = [];
    for (let t = 1; t <= 4000; t++) {
      const min = Math.ceil(t / 50);
      for (const sign of [1, -1]) {
        const at = (k: number): string => diagnosticChange('gorbovV', (t + sign * k) / 10, t / 10);
        if (at(min) === 'без изменений') wrong.push(`${String(t)}${sign > 0 ? '+' : '−'}${String(min)}`);
        if (min > 1 && at(min - 1) !== 'без изменений') wrong.push(`${String(t)}${sign > 0 ? '+' : '−'}${String(min - 1)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the diagnostic plays СЗМР with 2 colours on 2 keys, as the 2-choice norm of its «Ориентир» needs', () => {
    expect(isTwoChoice(DIAGNOSTIC_PARAMS.szmr)).toBe(true);
  });

  it('no difference in the shown rounding is no change, also from a previous 0 (A-R3)', () => {
    expect(diagnosticChange('numseries', 0, 0)).toBe('без изменений');
    expect(diagnosticChange('gonogo', 0, 0)).toBe('без изменений');
    expect(diagnosticChange('gorbovPi', 0, 0)).toBe('без изменений');
    // 0,1 + 0,2 − 0,3 is not 0 in floating point, but it shows as 0,0 с.
    expect(diagnosticChange('gorbovPi', 0.1 + 0.2, 0.3)).toBe('без изменений');
    // From 0 any shown difference is a change: 2 % of 0 is 0.
    expect(diagnosticChange('numseries', 1, 0)).toBe('+1, лучше');
    expect(diagnosticChange('gorbovPi', 0.1, 0)).toBe('+0,1 с, хуже');
  });

  it('the reference band: by the mean for ПЗМР and СЗМР, none for Π', () => {
    expect(DIAGNOSTIC_ROW_IDS.map((id) => diagnosticNorm(D, id))).toEqual([
      'по среднему 262 мс: средний', 'по среднему 402 мс: ниже среднего', null, null, 'средний', 'высокий', null, null, null, null, null, 'средний']);
    expect(diagnosticNorm({ ...D, pzmrMeanRt: null }, 'pzmr')).toBeNull();
  });

  it('a diagnostic played on the mouse: no reference band for ПЗМР and СЗМР, the others as usual (T-R23)', () => {
    expect(DIAGNOSTIC_ROW_IDS.map((id) => diagnosticNorm(D, id, 'mouse'))).toEqual([
      null, null, null, null, 'средний', 'высокий', null, null, null, null, null, 'средний']);
    expect(diagnosticNorm(D, 'pzmr', 'pult')).toBe('по среднему 262 мс: средний');
    expect(diagnosticNorm(D, 'szmr', 'keyboard')).toBe('по среднему 402 мс: ниже среднего');
  });

  it('no value, no reference band', () => {
    expect(DIAGNOSTIC_ROW_IDS.map((id) => diagnosticNorm(EMPTY_METRICS, id))).toEqual(DIAGNOSTIC_ROW_IDS.map(() => null));
    expect(DIAGNOSTIC_ROW_IDS.map((id) => diagnosticValue(EMPTY_METRICS, id))).toEqual(DIAGNOSTIC_ROW_IDS.map(() => null));
  });
});

/** The F7 values of one diagnostic (Справочник F7). */
const F7 = { ...EMPTY_METRICS, pzmrSdRt: 38.4, pzmrIqrRt: 41.2, pzmrFalseStarts: 1, szmrSdRt: 51.6, szmrIqrRt: 60, szmrFalseStarts: 0, szmrWrong: 2,
  gonogoCommissions: 3, gonogoOmissions: 1, rdoEarly: 12, rdoLate: 9, rdoSignedBiasMs: -6.2 };

describe('diagnosticDetailLines (F7, Р20)', () => {
  it('spread and errors of each module, in the order of the table', () => {
    expect(diagnosticDetailLines(F7)).toEqual([
      'ПЗМР: разброс (SD) 38 мс, IQR 41 мс, фальстарты 1',
      'СЗМР: разброс (SD) 52 мс, IQR 60 мс, фальстарты 0, неверная клавиша 2',
      'Go/No-Go: нажатия на no-go 3, пропуски 1',
      'РДО: рано 12, поздно 9, смещение −6 мс (раньше отметки)',
    ]);
  });

  it('the РДО bias: + is after the mark, 0 has no side', () => {
    expect(diagnosticDetailLines({ ...EMPTY_METRICS, rdoEarly: 2, rdoLate: 5, rdoSignedBiasMs: 4.4 })).toEqual(['РДО: рано 2, поздно 5, смещение +4 мс (позже отметки)']);
    expect(diagnosticDetailLines({ ...EMPTY_METRICS, rdoEarly: 0, rdoLate: 0, rdoSignedBiasMs: -0.4 })).toEqual(['РДО: рано 0, поздно 0, смещение 0 мс']);
    expect(diagnosticDetailLines({ ...EMPTY_METRICS, rdoEarly: 0, rdoLate: 0, rdoSignedBiasMs: 0 })).toEqual(['РДО: рано 0, поздно 0, смещение 0 мс']);
  });

  it('a count that is not a whole number ≥ 0 (a damaged or imported row) counts as missing: no line (T-R55)', () => {
    for (const bad of [1.5, -2]) {
      expect(diagnosticDetailLines({ ...F7, szmrWrong: bad })).not.toContainEqual(expect.stringMatching(/^СЗМР/));
      expect(diagnosticDetailLines({ ...F7, pzmrFalseStarts: bad })).not.toContainEqual(expect.stringMatching(/^ПЗМР/));
      expect(diagnosticDetailLines({ ...F7, gonogoOmissions: bad })).not.toContainEqual(expect.stringMatching(/^Go\/No-Go/));
      expect(diagnosticDetailLines({ ...F7, rdoLate: bad })).not.toContainEqual(expect.stringMatching(/^РДО/));
    }
    expect(diagnosticDetailLines({ ...F7, szmrFalseStarts: 2.5, gonogoCommissions: -1, rdoEarly: 0.5, pzmrFalseStarts: -0.5 })).toEqual([]);
  });

  it('a module without data has no line; a row stored before F7 has none at all', () => {
    expect(diagnosticDetailLines({ ...F7, szmrSdRt: null, szmrIqrRt: null, szmrFalseStarts: null, szmrWrong: null, gonogoCommissions: null, gonogoOmissions: null })).toEqual([
      'ПЗМР: разброс (SD) 38 мс, IQR 41 мс, фальстарты 1',
      'РДО: рано 12, поздно 9, смещение −6 мс (раньше отметки)',
    ]);
    expect(diagnosticDetailLines(D)).toEqual([]);
    expect(diagnosticDetailLines(EMPTY_METRICS)).toEqual([]);
  });
});
