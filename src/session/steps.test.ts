import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { penalizedScore } from '../engine/reaction/summary';
import type { Outcome, ReactionSummary } from '../engine/reaction/types';
import { REACTION_MODULE_IDS } from '../engine/types';
import {
  AUDIO_NOT_PLAYED,
  conditionLines,
  dayFormLine,
  DIAGNOSTIC_RESTART_NOTICE,
  discardText,
  ERROR_KINDS,
  errorLine,
  floorLine,
  MEMORY_SPAN_INSTRUCTION,
  memoryLines,
  OVERLOAD_SOUND_PREFIX,
  overloadBandPrefix,
  plural,
  reactionLines,
  RESTART_USED_HINT,
  seriesDiagnosticInstruction,
  seriesLines,
  spanLines,
  stabilityLine,
  tableLines,
  WARMUP_LEVEL_NOTE,
} from './steps';

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

/** A summary with these counts; its penalised score follows from them (penalizedScore). */
function summary(over: Partial<ReactionSummary> = {}, counts: Partial<Record<Outcome, number>> = {}): ReactionSummary {
  const all = { ...NO_COUNTS, ...counts };
  const n = over.n ?? 20;
  return {
    n,
    score: 0.85,
    penalizedScore: penalizedScore(all, n),
    meanRt: 320,
    medianRt: 312.4,
    sdRt: 40.6,
    cvRt: 0.13,
    counts: all,
    meanAbsErrorMs: null,
    meanSignedErrorMs: null,
    timingUnreliable: false,
    ...over,
  };
}

describe('errorLine (F1)', () => {
  it('names the error kinds of the module, the penalty and the penalised score', () => {
    expect(errorLine('szmr', summary({}, { hit: 17, wrong: 2, false_start: 1 }))).toBe(
      'Ошибки: неверная клавиша — 2, фальстарты — 1. Штраф −4 из 20, балл 0,65.',
    );
    expect(errorLine('gonogo', summary({}, { hit: 16, correct_reject: 3, commission: 1 }))).toBe(
      'Ошибки: нажатия на no-go — 1, фальстарты — 0. Штраф −2 из 20, балл 0,85.',
    );
    expect(errorLine('pzmr', summary({ n: 15 }, { hit: 14, false_start: 1 }))).toBe('Ошибки: фальстарты — 1. Штраф −2 из 15, балл 0,80.');
  });

  it('«Ошибок нет.» when every error kind of the module is 0: a miss or an РДО early answer is no error', () => {
    expect(errorLine('pzmr', summary({ n: 15 }, { hit: 14, miss: 1 }))).toBe('Ошибок нет.');
    expect(errorLine('rdo', summary({ n: 10 }, { hit: 9, early: 1 }))).toBe('Ошибок нет.');
  });

  it('the score is the stored penalised one, two decimals with a comma', () => {
    expect(errorLine('pomeh', summary({}, { hit: 16, wrong: 1, false_start: 2, miss: 1 }))).toBe(
      'Ошибки: неверная клавиша — 1, фальстарты — 2. Штраф −5 из 20, балл 0,55.',
    );
    expect(errorLine('rdo', summary({ n: 15 }, { hit: 2, false_start: 13 }))).toBe('Ошибки: фальстарты — 13. Штраф −26 из 15, балл 0,00.');
  });

  it('error kinds in line order: wrong keys or no-go presses first, false starts last; every reaction module has false starts', () => {
    expect(ERROR_KINDS).toEqual({
      pzmr: ['false_start'],
      szmr: ['wrong', 'false_start'],
      gonogo: ['commission', 'false_start'],
      rdo: ['false_start'],
      stroop: ['wrong', 'false_start'],
      taskswitch: ['wrong', 'false_start'],
      pomeh: ['wrong', 'false_start'],
    });
    expect(Object.keys(ERROR_KINDS).sort()).toEqual([...REACTION_MODULE_IDS].sort());
  });
});

describe('the window floor and the overload band (F3)', () => {
  it('floorLine says the window rests on the personal floor and names the nominal one', () => {
    expect(floorLine(412, 298)).toBe('Окно ответа: 412 мс — твой минимум для этой нагрузки (по уровню — 298 мс).');
  });

  it('overloadBandPrefix: the sound, the next band\'s load and a level that does not move (Р16)', () => {
    expect(overloadBandPrefix('4 цвета на 4 клавиши')).toBe(
      'Блок с перегрузкой, со звуковыми помехами. Надень наушники. Перегрузка: нагрузка следующей полосы — 4 цвета на 4 клавиши. Уровень не меняется. ',
    );
    // It never claims a level 3 above: that is РДО's prefix.
    expect(overloadBandPrefix('красный круг')).not.toContain('на 3 выше');
    expect(OVERLOAD_SOUND_PREFIX).toContain('на 3 выше');
  });
});

describe('stabilityLine (F2, F-R1)', () => {
  it('the CV cap lets the level up by 0.5 only; percent with one decimal at most', () => {
    expect(stabilityLine({ cvAll: 0.24, lapses: 0, lapseLimit: 2, cvMax: 0.22, cap: 0.5 })).toBe(
      'Уровень повышен только на 0,5: разброс 24 % при пороге 22 %.',
    );
    expect(stabilityLine({ cvAll: 0.21, lapses: 1, lapseLimit: 2, cvMax: 0.205, cap: 0.5 })).toBe(
      'Уровень повышен только на 0,5: разброс 21 % при пороге 20,5 %.',
    );
    expect(stabilityLine({ cvAll: 0.29314, lapses: 0, lapseLimit: 2, cvMax: 0.22, cap: 0.5 })).toBe(
      'Уровень повышен только на 0,5: разброс 29,3 % при пороге 22 %.',
    );
  });

  it('lapses hold the level; the line says how many are allowed (Р8: it wins over the CV line)', () => {
    expect(stabilityLine({ cvAll: 0.1, lapses: 3, lapseLimit: 2, cvMax: 0.22, cap: 0 })).toBe(
      'Уровень не повышен: провалов 3 (пропуск или ответ дольше 1,5 медианы), допускается 1.',
    );
    expect(stabilityLine({ cvAll: 0.4, lapses: 6, lapseLimit: 5, cvMax: 0.19, cap: 0 })).toBe(
      'Уровень не повышен: провалов 6 (пропуск или ответ дольше 1,5 медианы), допускается 4.',
    );
    expect(stabilityLine({ cvAll: null, lapses: 2, lapseLimit: 2, cvMax: 0.19, cap: 0 })).toBe(
      'Уровень не повышен: провалов 2 (пропуск или ответ дольше 1,5 медианы), допускается 1.',
    );
  });

  it('a CV cap needs a CV', () => {
    expect(() => stabilityLine({ cvAll: null, lapses: 0, lapseLimit: 2, cvMax: 0.22, cap: 0.5 })).toThrow(RangeError);
  });
});

describe('reactionLines', () => {
  it('reactionLines puts the errors first and keeps Пропуски last', () => {
    const lines = reactionLines('szmr', summary({}, { hit: 17, wrong: 2, false_start: 1 }));
    expect(lines[0]).toBe('Ошибки: неверная клавиша — 2, фальстарты — 1. Штраф −4 из 20, балл 0,65.');
    expect(lines.at(-1)).toBe('Пропуски: 0');
    expect(lines.filter((l) => /^(Фальстарты|Ошибки выбора|Нажатия на no-go):/.test(l))).toEqual([]);
    expect(lines.filter((l) => l.startsWith('Ошибки:'))).toEqual([lines[0]]);
  });

  it('pzmr: errors, median, mean, SD, CV, misses (late answers count as misses)', () => {
    expect(reactionLines('pzmr', summary({}, { hit: 17, false_start: 1, miss: 1, late: 1 }))).toEqual([
      'Ошибки: фальстарты — 1. Штраф −2 из 20, балл 0,75.',
      'Медиана: 312 мс',
      'Среднее: 320 мс',
      'Разброс (SD): 41 мс',
      'Стабильность (CV): 0,13',
      'Пропуски: 2',
    ]);
  });

  it('szmr: wrong keys go into the error line', () => {
    expect(reactionLines('szmr', summary({}, { hit: 18, wrong: 2 }))).toEqual([
      'Ошибки: неверная клавиша — 2, фальстарты — 0. Штраф −2 из 20, балл 0,80.',
      'Медиана: 312 мс',
      'Среднее: 320 мс',
      'Разброс (SD): 41 мс',
      'Стабильность (CV): 0,13',
      'Пропуски: 0',
    ]);
  });

  it('gonogo: presses on no-go go into the error line', () => {
    expect(reactionLines('gonogo', summary({ meanRt: 333.5, cvRt: 0.146 }, { hit: 15, correct_reject: 4, commission: 1 }))).toEqual([
      'Ошибки: нажатия на no-go — 1, фальстарты — 0. Штраф −2 из 20, балл 0,85.',
      'Медиана: 312 мс',
      'Среднее: 334 мс',
      'Разброс (SD): 41 мс',
      'Стабильность (CV): 0,15',
      'Пропуски: 0',
    ]);
  });

  it('«Стабильность (CV)» shows CV_all, what the rule sees, once the block has its stability (Р6)', () => {
    const lines = (stability: { cvAll: number | null } | null): string[] =>
      reactionLines('szmr', summary({ cvRt: 0.13 }, { hit: 18, late: 2 }), stability);
    expect(lines({ cvAll: 0.294 })).toContain('Стабильность (CV): 0,29');
    expect(lines({ cvAll: 0.294 })).not.toContain('Стабильность (CV): 0,13');
    // Fewer than 3 answers: no CV for the rule, so none on the screen either.
    expect(lines({ cvAll: null }).some((l) => l.startsWith('Стабильность (CV)'))).toBe(false);
    expect(lines(null)).toContain('Стабильность (CV): 0,13');
  });

  it('no hits: no RT lines', () => {
    expect(reactionLines('pzmr', summary({ n: 15, medianRt: null, meanRt: null, sdRt: null, cvRt: null }, { miss: 15 }))).toEqual([
      'Ошибок нет.',
      'Пропуски: 15',
    ]);
  });

  it('rdo: the error by modulus (what the history compares), the signed bias in words, exact hits, early and late answers (FW1)', () => {
    const counts = { hit: 6, early: 3, timing_late: 1 };
    const rdo = (signed: number | null, abs: number | null): string[] =>
      reactionLines(
        'rdo',
        summary({ n: 10, medianRt: null, meanRt: null, sdRt: null, cvRt: null, meanSignedErrorMs: signed, meanAbsErrorMs: abs }, counts),
      );
    const tail = ['Точных попаданий: 6 из 10', 'Опережений: 3, запаздываний: 1', 'Пропуски: 0'];
    expect(rdo(5, 25.4)).toEqual(['Ошибок нет.', 'Средняя ошибка по модулю: 25 мс', 'Смещение: +5 мс (запаздываешь)', ...tail]);
    expect(rdo(-30.4, 31)).toEqual(['Ошибок нет.', 'Средняя ошибка по модулю: 31 мс', 'Смещение: −30 мс (торопишься)', ...tail]);
    expect(rdo(-0.4, 12)).toEqual(['Ошибок нет.', 'Средняя ошибка по модулю: 12 мс', 'Смещение: 0 мс', ...tail]);
    expect(rdo(null, null)).toEqual(['Ошибок нет.', ...tail]);
  });
});

describe('Струп', () => {
  it('reactionLines: errors are wrong colours', () => {
    const lines = reactionLines('stroop', summary({}, { hit: 16, wrong: 3, miss: 1 }));
    expect([lines[0], lines.at(-1)]).toEqual(['Ошибки: неверная клавиша — 3, фальстарты — 0. Штраф −3 из 20, балл 0,65.', 'Пропуски: 1']);
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

  it('conditionLines: the difference shown is that of the medians shown, whatever the rounding', () => {
    // 610 − 520,5 = 89,5 would round to 90, but the lines read 521 and 610.
    expect(conditionLines('stroop', stats(520.5, 610))).toEqual(['Цвет совпадает со словом: 521 мс', 'Не совпадает: 610 мс', 'Интерференция: +89 мс']);
    const shown = (line: string | undefined): number => Number((line ?? '').replace(/^.*: /, '').replace(' мс', '').replace('−', '-'));
    const half = fc.integer({ min: 300, max: 2000 }).chain((x) => fc.constantFrom(x, x + 0.5, x + 0.25));
    fc.assert(
      fc.property(half, half, (fast, slow) => {
        const [f, sl, cost] = conditionLines('stroop', stats(fast, slow));
        expect(shown(cost)).toBe(shown(sl) - shown(f));
      }),
      { numRuns: 1000 },
    );
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
    const lines = reactionLines('taskswitch', summary({}, { hit: 17, wrong: 2, false_start: 1 }));
    expect([lines[0], lines.at(-1)]).toEqual(['Ошибки: неверная клавиша — 2, фальстарты — 1. Штраф −4 из 20, балл 0,65.', 'Пропуски: 0']);
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

describe('Помехоустойчивость', () => {
  it('reactionLines: choice errors and false starts first, misses last', () => {
    const lines = reactionLines('pomeh', summary({}, { hit: 16, wrong: 1, false_start: 2, miss: 1 }));
    expect([lines[0], lines.at(-1)]).toEqual(['Ошибки: неверная клавиша — 1, фальстарты — 2. Штраф −5 из 20, балл 0,55.', 'Пропуски: 1']);
  });

  it('conditionLines: quiet and noisy medians and their difference', () => {
    const stats = { quiet: { n: 10, errors: 0, medianRt: 300 }, noisy: { n: 10, errors: 1, medianRt: 335.2 } };
    expect(conditionLines('pomeh', stats)).toEqual(['Без помех: 300 мс', 'С помехами: 335 мс', 'Разница: +35 мс']);
    expect(conditionLines('pomeh', { quiet: stats.quiet, noisy: { n: 2, errors: 0, medianRt: null } })).toEqual(['Без помех: 300 мс']);
  });

  it('conditionLines: an overload block plays the sound on every trial, so only the figures tell the conditions apart (M2)', () => {
    const stats = { quiet: { n: 10, errors: 0, medianRt: 300 }, noisy: { n: 10, errors: 1, medianRt: 335.2 } };
    expect(conditionLines('pomeh', stats, true)).toEqual([
      'Без отвлекающих фигур: 300 мс',
      'С отвлекающими фигурами: 335 мс',
      'Разница: +35 мс',
    ]);
    expect(conditionLines('pomeh', stats, false)).toEqual(['Без помех: 300 мс', 'С помехами: 335 мс', 'Разница: +35 мс']);
    // Other modules' conditions do not depend on the sound.
    const stroop = { congruent: { n: 10, errors: 0, medianRt: 520 }, incongruent: { n: 10, errors: 0, medianRt: 610 } };
    expect(conditionLines('stroop', stroop, true)).toEqual(conditionLines('stroop', stroop));
  });

  it('the line for a block whose sound did not play', () => {
    expect(AUDIO_NOT_PLAYED).toBe('Звук не воспроизводился: проверь устройство вывода и громкость помех в настройках.');
  });
});

describe('memoryLines', () => {
  it('exact trials, share of items in place, row length', () => {
    expect(memoryLines(4, 6, 31, 6)).toEqual(['Верно воспроизведено: 4 из 6', 'Позиции на своих местах: 86 %', 'Длина ряда: 6']);
    expect(memoryLines(0, 0, 0, 4)[1]).toBe('Позиции на своих местах: 0 %');
  });
});

describe('spanLines', () => {
  it('rows reproduced out of the rows shown, then the span in digits', () => {
    expect(spanLines(9, 14, 7)).toEqual(['Верно воспроизведено: 9 из 14', 'Объём памяти: 7 цифр']);
    expect(spanLines(2, 4, 3)[1]).toBe('Объём памяти: 3 цифры');
    expect(spanLines(0, 2, 0)[1]).toBe('Объём памяти: 0 цифр');
  });

  it('the span instruction', () => {
    expect(MEMORY_SPAN_INSTRUCTION).toBe(
      'Запомни цифры по порядку. Потом набери их и нажми Enter. Сначала ряд из 3 цифр, после каждых двух проб он удлиняется ' +
        'на одну цифру. Проверка закончится, когда оба ряда одной длины будут набраны с ошибкой.',
    );
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

describe('dayFormLine', () => {
  it('the form of the day against the usual one, whole ms (F5)', () => {
    const f = { today: { median: 236.4, sd: 31.2 }, usual: { median: 241, sd: 35 } };
    expect(dayFormLine({ ...f, verdict: 'same' })).toBe('Форма дня: медиана 236 мс (обычно 241) · разброс 31 мс (обычно 35) — как обычно.');
    expect(dayFormLine({ ...f, verdict: 'better' })).toBe('Форма дня: медиана 236 мс (обычно 241) · разброс 31 мс (обычно 35) — лучше обычного.');
    expect(dayFormLine({ ...f, verdict: 'worse' })).toBe('Форма дня: медиана 236 мс (обычно 241) · разброс 31 мс (обычно 35) — хуже обычного.');
    expect(dayFormLine({ today: f.today, usual: null, verdict: null })).toBe(
      'Форма дня: мало данных — нужно 3 разминки за 14 дней на этой нагрузке.',
    );
    // Halves round up, as every whole-ms number on screen (whole).
    expect(dayFormLine({ today: { median: 240.5, sd: 0.4 }, usual: { median: 240.5, sd: 9.5 }, verdict: 'same' })).toBe(
      'Форма дня: медиана 241 мс (обычно 241) · разброс 0 мс (обычно 10) — как обычно.',
    );
  });

  it('the level note of a warm-up', () => {
    expect(WARMUP_LEVEL_NOTE).toBe('Разминка: уровень не меняется');
  });
});

describe('discardText (F11)', () => {
  const counted = { kind: 'counted', progress: 0.45, lBefore: 12.5, lAfter: 10.5, levelMoves: true, series: false } as const;

  it('the pause line of an Esc block: counted with the level, without it, number series; restarted', () => {
    expect(discardText(counted)).toBe('Блок прерван на 45 % — засчитан как 0, уровень 12,5 → 10,5.');
    expect(discardText({ ...counted, levelMoves: false })).toBe('Блок прерван на 45 % — засчитан как 0, уровень не меняется.');
    expect(discardText({ ...counted, levelMoves: false, series: true })).toBe(
      'Блок прерван на 45 % — отвеченные задачи засчитаны, остальные — как пропущенные.',
    );
    expect(discardText({ kind: 'restarted' })).toBe('Блок прерван в начале — не засчитан.');
  });

  it('levels with one decimal; the share rounded up, so a counted block never reads 30 % or less', () => {
    expect(discardText({ ...counted, progress: 0.31, lBefore: 5, lAfter: 3 })).toBe('Блок прерван на 31 % — засчитан как 0, уровень 5,0 → 3,0.');
    expect(discardText({ ...counted, progress: 7 / 23, lBefore: 1, lAfter: 0 })).toBe('Блок прерван на 31 % — засчитан как 0, уровень 1,0 → 0,0.');
    expect(discardText({ ...counted, progress: 0.4, levelMoves: false })).toBe('Блок прерван на 40 % — засчитан как 0, уровень не меняется.');
    expect(discardText({ ...counted, progress: 1, levelMoves: false })).toBe('Блок прерван на 100 % — засчитан как 0, уровень не меняется.');
  });

  it('the diagnostic notice and the hint after its one restart', () => {
    expect(DIAGNOSTIC_RESTART_NOTICE).toBe('Блок перезапущен. В диагностике это можно сделать один раз за задание.');
    expect(RESTART_USED_HINT).toBe('Перезапуск уже использован — доведи задание до конца.');
  });
});
