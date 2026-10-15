import { describe, expect, it } from 'vitest';
import { EMPTY_METRICS } from '../engine/diagnostic';
import { DIAGNOSTIC_PARAMS } from '../modules/reaction/diagnosticParams';
import { isTwoChoice } from './blockHistory';
import { DIAGNOSTIC_ROW_IDS, diagnosticChange, diagnosticNorm, diagnosticValue, diagnosticValueText } from './diagnosticCompare';

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

  it('no value, no reference band', () => {
    expect(DIAGNOSTIC_ROW_IDS.map((id) => diagnosticNorm(EMPTY_METRICS, id))).toEqual(DIAGNOSTIC_ROW_IDS.map(() => null));
    expect(DIAGNOSTIC_ROW_IDS.map((id) => diagnosticValue(EMPTY_METRICS, id))).toEqual(DIAGNOSTIC_ROW_IDS.map(() => null));
  });
});
