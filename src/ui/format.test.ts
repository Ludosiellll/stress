import { describe, expect, it } from 'vitest';
import { noBreakUnits } from './format';

const NB = ' ';

describe('noBreakUnits', () => {
  it('keeps a number and its unit on one line: ms, s, % (A-R22)', () => {
    expect(noBreakUnits('Норма (ориентир), среднее: 262 мс — средний; выше среднего — меньше 234 мс.')).toBe(
      `Норма (ориентир), среднее: 262${NB}мс — средний; выше среднего — меньше 234${NB}мс.`,
    );
    expect(noBreakUnits('прошлый раз 48,2 с (ур. 11) · лучший 41,0 с')).toBe(`прошлый раз 48,2${NB}с (ур. 11) · лучший 41,0${NB}с`);
    expect(noBreakUnits('67 % / 83 %')).toBe(`67${NB}% / 83${NB}%`);
    expect(noBreakUnits('−13 мс, лучше')).toBe(`−13${NB}мс, лучше`);
    expect(noBreakUnits('+2,0 с, хуже')).toBe(`+2,0${NB}с, хуже`);
  });

  it('keeps «39 → 29 с» together, but not an arrow between words', () => {
    expect(noBreakUnits('Там: лимит времени: 39 → 29 с; перемешивание: нет → каждые 9 верных')).toBe(
      `Там: лимит времени: 39${NB}→${NB}29${NB}с; перемешивание: нет → каждые 9 верных`,
    );
    expect(noBreakUnits('окно ответа: 808 → 497 мс')).toBe(`окно ответа: 808${NB}→${NB}497${NB}мс`);
  });

  it('leaves other words after a number alone', () => {
    for (const text of ['Ступень 3 из 5+ — формат теста', '14 из 20', '3 смены', 'рейтинг 1376 (+196)', 'Последний / лучший за 30 дней', 'ещё не тренировался']) {
      expect(noBreakUnits(text)).toBe(text);
    }
  });
});
