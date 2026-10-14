import { describe, expect, it } from 'vitest';
import type { Outcome, ReactionSummary } from '../engine/reaction/types';
import { reactionLines, seriesLines, tableLines } from './steps';

const NO_COUNTS: Record<Outcome, number> = {
  hit: 0,
  wrong: 0,
  miss: 0,
  late: 0,
  false_start: 0,
  commission: 0,
  correct_reject: 0,
  early: 0,
  timing_late: 0,
};

function summary(over: Partial<ReactionSummary> = {}, counts: Partial<Record<Outcome, number>> = {}): ReactionSummary {
  return {
    n: 20,
    score: 0.85,
    meanRt: 320,
    medianRt: 312.4,
    sdRt: 40.6,
    cvRt: 0.13,
    counts: { ...NO_COUNTS, ...counts },
    meanAbsErrorMs: null,
    meanSignedErrorMs: null,
    timingUnreliable: false,
    ...over,
  };
}

describe('reactionLines', () => {
  it('pzmr: median, SD, false starts, misses (late answers count as misses)', () => {
    expect(reactionLines('pzmr', summary({}, { false_start: 1, miss: 1, late: 1 }))).toEqual([
      'Медиана: 312 мс',
      'Разброс (SD): 41 мс',
      'Фальстарты: 1',
      'Пропуски: 2',
    ]);
  });

  it('szmr adds choice errors', () => {
    expect(reactionLines('szmr', summary({}, { wrong: 2 }))).toEqual([
      'Медиана: 312 мс',
      'Разброс (SD): 41 мс',
      'Фальстарты: 0',
      'Пропуски: 0',
      'Ошибки выбора: 2',
    ]);
  });

  it('gonogo adds presses on no-go', () => {
    expect(reactionLines('gonogo', summary({}, { commission: 1 }))).toEqual([
      'Медиана: 312 мс',
      'Разброс (SD): 41 мс',
      'Фальстарты: 0',
      'Пропуски: 0',
      'Нажатия на no-go: 1',
    ]);
  });

  it('no hits: no RT lines', () => {
    expect(reactionLines('pzmr', summary({ medianRt: null, sdRt: null }, { miss: 15 }))).toEqual([
      'Фальстарты: 0',
      'Пропуски: 15',
    ]);
  });

  it('rdo: signed mean error with the direction in words', () => {
    const rdo = (e: number | null): string[] =>
      reactionLines('rdo', summary({ medianRt: null, sdRt: null, meanSignedErrorMs: e, meanAbsErrorMs: e === null ? null : Math.abs(e) }));
    expect(rdo(12.2)).toEqual(['Средняя ошибка: +12 мс (запаздываешь)', 'Фальстарты: 0', 'Пропуски: 0']);
    expect(rdo(-7.6)).toEqual(['Средняя ошибка: −8 мс (торопишься)', 'Фальстарты: 0', 'Пропуски: 0']);
    expect(rdo(-0.4)).toEqual(['Средняя ошибка: 0 мс', 'Фальстарты: 0', 'Пропуски: 0']);
    expect(rdo(null)).toEqual(['Фальстарты: 0', 'Пропуски: 0']);
  });
});

describe('tableLines', () => {
  it('completed run: time with a decimal comma, errors', () => {
    expect(tableLines({ score: 0.9, timeMs: 41_234, errors: 2, correct: 24, completed: true })).toEqual([
      'Время: 41,2 с',
      'Ошибки: 2',
    ]);
  });

  it('run not finished in time', () => {
    expect(tableLines({ score: 0.4, timeMs: null, errors: 0, correct: 10, completed: false })).toEqual([
      'Не закончено за лимит',
      'Ошибки: 0',
    ]);
  });
});

describe('seriesLines', () => {
  it('correct count and mean time in whole seconds', () => {
    expect(seriesLines(7, 10, 14_400)).toEqual(['Верно: 7 из 10', 'Среднее время: 14 с']);
  });
});
