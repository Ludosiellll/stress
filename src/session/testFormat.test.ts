import { describe, expect, it } from 'vitest';
import type { Outcome, TrialResult } from '../engine/reaction/types';
import { sdTrimmed } from '../engine/stats';
import {
  TEST_FORMAT_NAMES,
  readTestFormat,
  signalsText,
  testFormatBest,
  testFormatInstruction,
  testFormatLines,
  testFormatMetrics,
  type TestFormatMetrics,
} from './testFormat';

/** One result; a press hit by default. */
function result(outcome: Outcome, over: Partial<TrialResult> = {}): TrialResult {
  const success = outcome === 'hit' || outcome === 'correct_reject';
  return { idx: 0, kind: 'press', outcome, success, rtMs: null, errorMs: null, key: null, frameDropped: false, practice: false, ...over };
}
const hit = (rtMs: number, over: Partial<TrialResult> = {}): TrialResult => result('hit', { rtMs, ...over });
/** An РДО trial answered with the right key `errorMs` from the target. */
const timed = (outcome: Outcome, errorMs: number | null): TrialResult =>
  result(outcome, { kind: 'timed', errorMs, rtMs: errorMs === null ? null : 3000 + errorMs });

const METRICS: TestFormatMetrics = { mean: 352.4, sd: 57, errors: 2, falseStarts: 0, thirds: [350, 352, 355] };

describe('testFormatMetrics', () => {
  it('СЗМР: the mean and the trimmed SD of the clean hits; wrong keys, misses and late answers are errors; thirds of the trials', () => {
    const results = [
      // A practice trial and a hit on a dropped frame count for nothing.
      hit(100, { practice: true }),
      hit(300),
      hit(310),
      hit(320),
      hit(330),
      result('wrong', { rtMs: 400 }),
      hit(340),
      result('miss'),
      result('false_start', { rtMs: 50 }),
      hit(350),
    ];
    expect(testFormatMetrics('szmr', results)).toEqual({
      mean: 325,
      sd: sdTrimmed([300, 310, 320, 330, 340, 350]),
      errors: 2,
      falseStarts: 1,
      thirds: [310, 335, 350],
    });
    // A hit whose onset frame was dropped has no certain RT; it is no error either.
    expect(testFormatMetrics('szmr', [hit(300), hit(500, { frameDropped: true }), hit(320)])).toMatchObject({ mean: 310, errors: 0 });
  });

  it('ПЗМР: misses and late answers are errors', () => {
    expect(testFormatMetrics('pzmr', [hit(250), result('late', { rtMs: 1200 }), result('miss'), hit(270), result('false_start')])).toEqual({
      mean: 260,
      sd: sdTrimmed([250, 270]),
      errors: 2,
      falseStarts: 1,
      // n = 5: [0, 1), [1, 3), [3, 5).
      thirds: [250, null, 270],
    });
  });

  it('Go/No-Go: presses on no-go, misses and late answers are errors; the mean is of the go hits', () => {
    const results = [
      hit(280),
      result('correct_reject', { kind: 'withhold' }),
      result('commission', { kind: 'withhold', rtMs: 250 }),
      result('miss'),
      result('late', { rtMs: 900 }),
      hit(320),
    ];
    expect(testFormatMetrics('gonogo', results)).toMatchObject({ mean: 300, errors: 3, falseStarts: 0, thirds: [280, null, 320] });
  });

  it('РДО: the mean |error| and the trimmed SD of the signed errors; early and late are the errors', () => {
    // At a tolerance of 10 ms: −20 is early, 10 a hit, 30 late.
    const results = [timed('early', -20), timed('hit', 10), timed('timing_late', 30), result('false_start', { kind: 'timed' })];
    expect(testFormatMetrics('rdo', results)).toEqual({
      mean: 20,
      sd: sdTrimmed([-20, 10, 30]),
      errors: 2,
      falseStarts: 1,
      // n = 4: [0, 1), [1, 2), [2, 4).
      thirds: [20, 10, 30],
    });
  });

  it('no value: mean, SD and thirds are null; one value has no SD', () => {
    expect(testFormatMetrics('pzmr', [result('miss'), result('miss'), result('miss')])).toEqual({
      mean: null,
      sd: null,
      errors: 3,
      falseStarts: 0,
      thirds: [null, null, null],
    });
    expect(testFormatMetrics('pzmr', [hit(250), result('miss')])).toMatchObject({ mean: 250, sd: null });
    expect(testFormatMetrics('pzmr', [])).toEqual({ mean: null, sd: null, errors: 0, falseStarts: 0, thirds: [null, null, null] });
  });
});

describe('testFormatBest', () => {
  it('the minimum of each metric over the runs; none: null', () => {
    const runs: TestFormatMetrics[] = [
      { mean: 341, sd: 61, errors: 1, falseStarts: 2, thirds: [1, 2, 3] },
      { mean: 352, sd: 58, errors: 3, falseStarts: 0, thirds: [1, 2, 3] },
      { mean: null, sd: null, errors: 4, falseStarts: 1, thirds: [null, null, null] },
    ];
    expect(testFormatBest(runs)).toEqual({ mean: 341, sd: 58, errors: 1, falseStarts: 0 });
    expect(testFormatBest([{ mean: null, sd: null, errors: 0, falseStarts: 0, thirds: [null, null, null] }])).toEqual({
      mean: null,
      sd: null,
      errors: 0,
      falseStarts: 0,
    });
    expect(testFormatBest([])).toBeNull();
  });
});

describe('testFormatLines', () => {
  it('each metric against the personal best; a strictly better one is a new best', () => {
    expect(testFormatLines('szmr', METRICS, { mean: 341, sd: 58, errors: 1, falseStarts: 0 })).toEqual([
      'Среднее 352 мс (лучшее 341) · SD 57 мс (лучшее 58) · ошибки 2 (лучшее 1) · фальстарты 0 (лучшее 0)',
      'Новый лучший результат: SD',
    ]);
    expect(testFormatLines('pzmr', { ...METRICS, mean: 240.4, errors: 0 }, { mean: 241, sd: 58, errors: 1, falseStarts: 1 })[1]).toBe(
      'Новый лучший результат: среднее, SD, ошибки, фальстарты',
    );
    // Compared as shown: 340,6 shows as 341, no better than 341.
    expect(testFormatLines('szmr', { ...METRICS, mean: 340.6, sd: 58 }, { mean: 341, sd: 58, errors: 2, falseStarts: 0 })).toEqual([
      'Среднее 341 мс (лучшее 341) · SD 58 мс (лучшее 58) · ошибки 2 (лучшее 2) · фальстарты 0 (лучшее 0)',
    ]);
  });

  it('without earlier runs of the format: nothing to compare with', () => {
    expect(testFormatLines('szmr', METRICS, null)).toEqual([
      'Среднее 352 мс · SD 57 мс · ошибки 2 · фальстарты 0',
      'Первый прогон в этом формате: сравнивать пока не с чем.',
    ]);
  });

  it('РДО names the deviation', () => {
    const lines = testFormatLines('rdo', { ...METRICS, mean: 14.6 }, { mean: 18, sd: 50, errors: 2, falseStarts: 0 });
    expect(lines[0]?.startsWith('Отклонение 15 мс (лучшее 18) · SD 57 мс')).toBe(true);
    expect(lines[1]).toBe('Новый лучший результат: отклонение');
    expect(testFormatLines('rdo', { ...METRICS, mean: 18 }, { mean: 15, sd: 57, errors: 2, falseStarts: 0 })[0]).toMatch(/^Отклонение 18 мс \(лучшее 15\)/);
  });

  it('a metric without a value is a dash and never a new best', () => {
    const none: TestFormatMetrics = { mean: null, sd: null, errors: 5, falseStarts: 0, thirds: [null, null, null] };
    expect(testFormatLines('pzmr', none, { mean: 250, sd: null, errors: 1, falseStarts: 0 })).toEqual([
      'Среднее — (лучшее 250) · SD — (лучшее —) · ошибки 5 (лучшее 1) · фальстарты 0 (лучшее 0)',
    ]);
    expect(testFormatLines('pzmr', METRICS, { mean: null, sd: null, errors: 2, falseStarts: 0 })).toEqual([
      'Среднее 352 мс (лучшее —) · SD 57 мс (лучшее —) · ошибки 2 (лучшее 2) · фальстарты 0 (лучшее 0)',
    ]);
  });
});

describe('testFormatInstruction', () => {
  it('opens the instruction of the run', () => {
    expect(testFormatInstruction(70)).toBe(
      'Прогон в формате теста: 70 сигналов подряд, как на настоящем тесте. Сначала 5 пробных, потом без остановки. Итог — в конце. Уровень не меняется. ',
    );
  });

  it('the count of signals agrees with its number (a block the e2e scale shrinks)', () => {
    expect([1, 3, 5, 21, 50].map(signalsText)).toEqual(['1 сигнал', '3 сигнала', '5 сигналов', '21 сигнал', '50 сигналов']);
    expect(testFormatInstruction(3).startsWith('Прогон в формате теста: 3 сигнала подряд,')).toBe(true);
  });

  it('the short names of the formats', () => {
    expect(TEST_FORMAT_NAMES).toEqual({ pzmr: 'ПЗМР', szmr: 'СЗМР', gonogo: 'Go/No-Go', rdo: 'РДО' });
  });
});

describe('readTestFormat', () => {
  it('reads summaryJson.testFormat; null when absent or damaged', () => {
    const stored = { mean: 250, sd: 30, errors: 1, falseStarts: 0, thirds: [250, null, 251] };
    expect(readTestFormat(JSON.stringify({ meanRt: 250, testFormat: stored }))).toEqual(stored);
    expect(readTestFormat(JSON.stringify({ testFormat: { ...stored, mean: null, sd: null } }))).toMatchObject({ mean: null, sd: null });
    for (const bad of [
      'not json',
      '{}',
      '{"testFormat":[1]}',
      JSON.stringify({ testFormat: { ...stored, mean: '250' } }),
      JSON.stringify({ testFormat: { ...stored, sd: -1 } }),
      JSON.stringify({ testFormat: { ...stored, errors: 1.5 } }),
      JSON.stringify({ testFormat: { ...stored, falseStarts: -1 } }),
      JSON.stringify({ testFormat: { ...stored, errors: undefined } }),
      JSON.stringify({ testFormat: { ...stored, thirds: [250, 250] } }),
      JSON.stringify({ testFormat: { ...stored, thirds: [250, '1', 250] } }),
      JSON.stringify({ testFormat: { ...stored, thirds: 'x' } }),
      '{"testFormat":{"mean":1e999,"sd":1,"errors":0,"falseStarts":0,"thirds":[null,null,null]}}',
    ]) {
      expect(readTestFormat(bad), bad).toBeNull();
    }
  });
});
