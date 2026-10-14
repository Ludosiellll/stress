import { describe, expect, it } from 'vitest';
import type { Outcome, ReactionSummary } from '../engine/reaction/types';
import { conditionLines, plural, reactionLines, seriesDiagnosticInstruction, seriesLines, tableLines } from './steps';

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
  it('pzmr: median, mean, SD, CV, false starts, misses (late answers count as misses)', () => {
    expect(reactionLines('pzmr', summary({}, { false_start: 1, miss: 1, late: 1 }))).toEqual([
      'Медиана: 312 мс',
      'Среднее: 320 мс',
      'Разброс (SD): 41 мс',
      'Стабильность (CV): 0,13',
      'Фальстарты: 1',
      'Пропуски: 2',
    ]);
  });

  it('szmr adds choice errors', () => {
    expect(reactionLines('szmr', summary({}, { wrong: 2 }))).toEqual([
      'Медиана: 312 мс',
      'Среднее: 320 мс',
      'Разброс (SD): 41 мс',
      'Стабильность (CV): 0,13',
      'Фальстарты: 0',
      'Пропуски: 0',
      'Ошибки выбора: 2',
    ]);
  });

  it('gonogo adds presses on no-go', () => {
    expect(reactionLines('gonogo', summary({ meanRt: 333.5, cvRt: 0.146 }, { commission: 1 }))).toEqual([
      'Медиана: 312 мс',
      'Среднее: 334 мс',
      'Разброс (SD): 41 мс',
      'Стабильность (CV): 0,15',
      'Фальстарты: 0',
      'Пропуски: 0',
      'Нажатия на no-go: 1',
    ]);
  });

  it('no hits: no RT lines', () => {
    expect(reactionLines('pzmr', summary({ medianRt: null, meanRt: null, sdRt: null, cvRt: null }, { miss: 15 }))).toEqual([
      'Фальстарты: 0',
      'Пропуски: 15',
    ]);
  });

  it('rdo: signed mean error with the direction in words, exact hits, early and late answers', () => {
    const counts = { hit: 6, early: 3, timing_late: 1 };
    const rdo = (e: number | null): string[] =>
      reactionLines(
        'rdo',
        summary(
          { n: 10, medianRt: null, meanRt: null, sdRt: null, cvRt: null, meanSignedErrorMs: e, meanAbsErrorMs: e === null ? null : Math.abs(e) },
          counts,
        ),
      );
    const tail = ['Точных попаданий: 6 из 10', 'Опережений: 3, запаздываний: 1', 'Фальстарты: 0', 'Пропуски: 0'];
    expect(rdo(12.2)).toEqual(['Средняя ошибка: +12 мс (запаздываешь)', ...tail]);
    expect(rdo(-7.6)).toEqual(['Средняя ошибка: −8 мс (торопишься)', ...tail]);
    expect(rdo(-0.4)).toEqual(['Средняя ошибка: 0 мс', ...tail]);
    expect(rdo(null)).toEqual(tail);
  });
});

describe('Струп', () => {
  it('reactionLines: errors are wrong colours', () => {
    expect(reactionLines('stroop', summary({}, { wrong: 3, miss: 1 })).slice(-3)).toEqual(['Фальстарты: 0', 'Пропуски: 1', 'Ошибки: 3']);
  });

  const stats = (congruent: number | null, incongruent: number | null) => ({
    congruent: { n: 8, errors: 0, medianRt: congruent },
    incongruent: { n: 12, errors: 1, medianRt: incongruent },
  });

  it('conditionLines: both medians and the interference with its sign', () => {
    expect(conditionLines('stroop', stats(520, 610))).toEqual([
      'Цвет совпадает со словом: 520 мс',
      'Не совпадает: 610 мс',
      'Интерференция: +90 мс',
    ]);
    expect(conditionLines('stroop', stats(530.4, 500.2)).at(-1)).toBe('Интерференция: −30 мс');
    expect(conditionLines('stroop', stats(500.2, 500.4)).at(-1)).toBe('Интерференция: 0 мс');
  });

  it('conditionLines: a line only for a value that is not null', () => {
    expect(conditionLines('stroop', stats(520, null))).toEqual(['Цвет совпадает со словом: 520 мс']);
    expect(conditionLines('stroop', stats(null, 610))).toEqual(['Не совпадает: 610 мс']);
    expect(conditionLines('stroop', {})).toEqual([]);
  });

  it('conditionLines: modules without conditions have none', () => {
    expect(conditionLines('szmr', stats(520, 610))).toEqual([]);
  });
});

describe('Переключение правил', () => {
  it('reactionLines: errors are answers by the wrong rule', () => {
    expect(reactionLines('taskswitch', summary({}, { wrong: 2, false_start: 1 })).slice(-3)).toEqual([
      'Фальстарты: 1',
      'Пропуски: 0',
      'Ошибки: 2',
    ]);
  });

  it('conditionLines: repeat and switch medians and the switch cost', () => {
    const stats = { repeat: { n: 15, errors: 0, medianRt: 600 }, switch: { n: 4, errors: 1, medianRt: 750 } };
    expect(conditionLines('taskswitch', stats)).toEqual([
      'Правило повторяется: 600 мс',
      'Правило сменилось: 750 мс',
      'Цена переключения: +150 мс',
    ]);
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
    expect(seriesLines(7, 10, 14_400, null)).toEqual(['Верно: 7 из 10', 'Среднее время: 14 с']);
    expect(seriesLines(7, 10, 14_400, 40_000)).toEqual(['Верно: 7 из 10', 'Среднее время: 14 с']);
  });

  it('names the shortest limit when it is under 40 s (limits are whole tenths of a second)', () => {
    expect(seriesLines(9, 10, 6000, 12_000)).toEqual(['Верно: 9 из 10', 'Среднее время: 6 с', 'Самый короткий лимит: 12 с']);
    expect(seriesLines(9, 10, 6000, 11_900)).toContain('Самый короткий лимит: 11,9 с');
    expect(seriesLines(9, 10, 6000, 39_900)).toContain('Самый короткий лимит: 39,9 с');
  });
});

describe('Russian plurals and the series diagnostic instruction', () => {
  it('plural forms', () => {
    const f = (n: number): string => plural(n, 'задача', 'задачи', 'задач');
    expect([1, 2, 4, 5, 11, 12, 14, 20, 21, 22, 25, 101, 111, 112, 122].map(f)).toEqual([
      'задача',
      'задачи',
      'задачи',
      'задач',
      'задач',
      'задач',
      'задач',
      'задач',
      'задача',
      'задачи',
      'задач',
      'задача',
      'задач',
      'задач',
      'задачи',
    ]);
  });

  it('built from the item count and the total limit', () => {
    expect(seriesDiagnosticInstruction(20, 600_000)).toBe('20 задач, общее время — 10 минут. Найди закономерность и введи следующее число.');
    expect(seriesDiagnosticInstruction(3, 12_000)).toBe('3 задачи, общее время — 12 секунд. Найди закономерность и введи следующее число.');
    expect(seriesDiagnosticInstruction(21, 60_000)).toBe('21 задача, общее время — 1 минута. Найди закономерность и введи следующее число.');
    expect(seriesDiagnosticInstruction(2, 122_000)).toBe('2 задачи, общее время — 122 секунды. Найди закономерность и введи следующее число.');
    expect(seriesDiagnosticInstruction(5, 180_000)).toBe('5 задач, общее время — 3 минуты. Найди закономерность и введи следующее число.');
    expect(seriesDiagnosticInstruction(1, 1000)).toBe('1 задача, общее время — 1 секунда. Найди закономерность и введи следующее число.');
    expect(seriesDiagnosticInstruction(4, null)).toBe('4 задачи. Найди закономерность и введи следующее число.');
  });
});
