import { describe, expect, it } from 'vitest';
import { changeText, describeChanges, describeMemoryChanges } from './describe';

describe('describeChanges', () => {
  it('pzmr 10 → 11: only the response window changes (the load band is the same)', () => {
    expect(describeChanges('pzmr', 10, 11)).toEqual([{ label: 'Окно ответа', from: '273 мс', to: '251 мс' }]);
  });

  it('same level: nothing changed', () => {
    expect(describeChanges('szmr', 5, 5)).toEqual([]);
    expect(describeChanges('gorbov', 3, 3, 'alternate')).toEqual([]);
  });

  it('szmr band change lists the window and the load (F3)', () => {
    expect(describeChanges('szmr', 7, 8)).toEqual([
      { label: 'Окно ответа', from: '548 мс', to: '485 мс' },
      { label: 'Нагрузка', from: '2 цвета на 2 клавиши', to: '3 цвета на 2 клавиши' },
    ]);
  });

  it('describeChanges with floors shows the actual window and the load', () => {
    // The window rests on the floor 600 at both levels: no window line.
    expect(describeChanges('szmr', 7, 8, undefined, { floors: () => 600 })).toEqual([
      { label: 'Нагрузка', from: '2 цвета на 2 клавиши', to: '3 цвета на 2 клавиши' },
    ]);
    // Each band its own floor (band 1: 520, band 2: 660); round(floor) and the larger of the two.
    const asked: number[] = [];
    const floors = (band: number): number | null => {
      asked.push(band);
      return band === 1 ? 519.6 : 660;
    };
    expect(describeChanges('szmr', 7, 8, undefined, { floors })).toEqual([
      { label: 'Окно ответа', from: '548 мс', to: '660 мс' },
      { label: 'Нагрузка', from: '2 цвета на 2 клавиши', to: '3 цвета на 2 клавиши' },
    ]);
    expect(asked).toEqual([1, 2]);
    // A band without a floor keeps the nominal window.
    expect(describeChanges('pzmr', 10, 11, undefined, { floors: () => null })).toEqual(describeChanges('pzmr', 10, 11));
    // Modules without bands ignore the floors.
    expect(describeChanges('rdo', 0, 2, undefined, { floors: () => 5000 })).toEqual(describeChanges('rdo', 0, 2));
    expect(describeChanges('schulte', 7, 8, undefined, { floors: () => 5000 })).toEqual(describeChanges('schulte', 7, 8));
  });

  it('level down shows the change in the other direction', () => {
    expect(describeChanges('gonogo', 20, 19)).toEqual([
      { label: 'Окно ответа', from: '179 мс', to: '185 мс' },
      { label: 'Нагрузка', from: 'no-go — круг с белой точкой, интервал 0,3–1 с', to: 'no-go — красный квадрат, интервал 0,3–1 с' },
    ]);
    expect(describeChanges('gonogo', 8, 7)).toEqual([
      { label: 'Окно ответа', from: '371 мс', to: '411 мс' },
      { label: 'Нагрузка', from: 'no-go 15 %, интервал 0,4–1,8 с', to: 'no-go 20 %, интервал 0,5–2,5 с' },
    ]);
  });

  it('rdo: the tolerance only; the speed turns by block, not by level (F14)', () => {
    expect(describeChanges('rdo', 0, 2)).toEqual([{ label: 'Допуск', from: '60 мс', to: '53 мс' }]);
  });

  it('gorbov uses the run task (alternate has ×1.6 time)', () => {
    expect(describeChanges('gorbov', 0, 2, 'black_up')).toEqual([{ label: 'Лимит времени', from: '120 с', to: '102 с' }]);
    expect(describeChanges('gorbov', 0, 2, 'alternate')).toEqual([{ label: 'Лимит времени', from: '192 с', to: '163 с' }]);
    expect(describeChanges('gorbov', 14, 15, 'red_down')).toEqual([
      { label: 'Лимит времени', from: '37 с', to: '34 с' },
      { label: 'Перемешивание', from: 'нет', to: 'каждые 10 верных' },
    ]);
  });

  it('gorbov without a task is a programming error', () => {
    expect(() => describeChanges('gorbov', 0, 1)).toThrow(RangeError);
  });

  it('schulte: grid size and time limit', () => {
    expect(describeChanges('schulte', 7, 8)).toEqual([
      { label: 'Лимит времени', from: '36 с', to: '86 с' },
      { label: 'Размер', from: '5×5', to: '6×6' },
    ]);
  });

  it('pomeh: flicker, near figures and sound at L = 8, choice at L = 12; the figures change with every level', () => {
    expect(describeChanges('pomeh', 7, 8)).toEqual([
      { label: 'Окно ответа', from: '411 мс', to: '371 мс' },
      { label: 'Нагрузка', from: 'простая реакция, помехи далеко', to: 'простая реакция, помехи рядом, мерцание, звук' },
      { label: 'Отвлекающих фигур', from: '6', to: '7' },
      { label: 'Смена фигур', from: '648 мс', to: '610 мс' },
    ]);
    expect(describeChanges('pomeh', 11, 12)).toContainEqual({
      label: 'Нагрузка',
      from: 'простая реакция, помехи рядом, мерцание, звук',
      to: 'выбор из двух, помехи рядом, мерцание, звук',
    });
    expect(describeChanges('pomeh', 8, 9).map((c) => c.label)).not.toContain('Нагрузка');
  });

  it('taskswitch: the size rule at L = 8; runs at L = 16 drop the switch share', () => {
    expect(describeChanges('taskswitch', 7, 8)).toContainEqual({ label: 'Нагрузка', from: '2 правила, подсказка заранее', to: '3 правила, подсказка заранее' });
    expect(describeChanges('taskswitch', 15, 16)).toEqual([
      { label: 'Окно ответа', from: '446 мс', to: '412 мс' },
      { label: 'Нагрузка', from: '3 правила, подсказка вместе с фигурой', to: '3 правила, смены без подсказки' },
    ]);
  });

  it('stroop: a third colour at L = 4, four without the key hint at L = 8', () => {
    expect(describeChanges('stroop', 3, 4)).toContainEqual({ label: 'Нагрузка', from: '2 цвета, подсказка клавиш', to: '3 цвета, подсказка клавиш' });
    expect(describeChanges('stroop', 7, 8)).toContainEqual({ label: 'Нагрузка', from: '3 цвета, подсказка клавиш', to: '4 цвета без подсказки' });
  });

  it('memory: the row length and how it is shown, for the mode the block played (F13)', () => {
    expect(describeChanges('memory', 8, 9, 'digits')).toEqual([
      { label: 'Длина ряда', from: '6', to: '7' },
      { label: 'Показ', from: '663 мс на элемент', to: '630 мс на элемент' },
    ]);
    expect(describeChanges('memory', 8, 9, 'letters')).toContainEqual({ label: 'Длина ряда', from: '5', to: '6' });
    expect(describeChanges('memory', 14, 15, 'card3x3')).toEqual([{ label: 'Показ', from: '10 с', to: '7 с' }]);
    expect(describeChanges('memory', 20, 21, 'card3x3')).toEqual([{ label: 'Показ', from: '5 с', to: '5 с, со звуком' }]);
    expect(changeText({ label: 'Показ', from: '10 с', to: '7 с' })).toBe('Показ: 10 → 7 с');
    expect(describeChanges('memory', 30, 31, 'digits')).toEqual([]);
  });

  it('memory, from the block played to the next one in another mode (F13, T-R78): the mode, then what differs', () => {
    // Digits at L 8 (6 long, 663 ms) and positions at L 9 (6 long, 630 ms).
    expect(describeMemoryChanges('digits', 8, 'positions', 9)).toEqual([
      { label: 'Режим', from: 'цифры', to: 'позиции' },
      { label: 'Показ', from: '663 мс на элемент', to: '630 мс на элемент' },
    ]);
    expect(describeMemoryChanges('card3x3', 14, 'letters', 14)).toEqual([
      { label: 'Режим', from: 'карточка 3×3', to: 'буквы' },
      { label: 'Длина ряда', from: '9', to: '7' },
      { label: 'Показ', from: '10 с', to: '488 мс на элемент' },
    ]);
    expect(describeMemoryChanges('digits', 8, 'digits', 9)).toEqual(describeChanges('memory', 8, 9, 'digits'));
  });

  it('memory needs the mode, Gorbov its task', () => {
    expect(() => describeChanges('memory', 0, 1)).toThrow(RangeError);
    expect(() => describeChanges('memory', 0, 1, 'alternate')).toThrow(RangeError);
    expect(() => describeChanges('gorbov', 0, 1, 'digits')).toThrow(RangeError);
  });

  it('numseries has no level parameters', () => {
    expect(describeChanges('numseries', 0, 0)).toEqual([]);
  });
});

describe('changeText', () => {
  it('writes a shared unit once and leaves other values whole', () => {
    expect(changeText({ label: 'Лимит времени', from: '120 с', to: '102 с' })).toBe('Лимит времени: 120 → 102 с');
    expect(changeText({ label: 'Перемешивание', from: 'нет', to: 'каждые 10 верных' })).toBe('Перемешивание: нет → каждые 10 верных');
    expect(changeText({ label: 'Размер', from: '5×5', to: '6×6' })).toBe('Размер: 5×5 → 6×6');
    expect(changeText({ label: 'Окно', from: '1 с', to: '900 мс' })).toBe('Окно: 1 с → 900 мс');
    expect(changeText({ label: 'Окно', from: '1 с', to: 'нет' })).toBe('Окно: 1 с → нет');
  });

  it('keeps band labels whole, even when they end in the same word (F3)', () => {
    expect(changeText({ label: 'Нагрузка', from: '2 цвета на 2 клавиши', to: '3 цвета на 2 клавиши' })).toBe(
      'Нагрузка: 2 цвета на 2 клавиши → 3 цвета на 2 клавиши',
    );
    expect(changeText({ label: 'Нагрузка', from: 'звук, 30 сигналов', to: 'звук, 45 сигналов' })).toBe('Нагрузка: звук, 30 сигналов → звук, 45 сигналов');
    expect(changeText({ label: 'Доля смен', from: '34 %', to: '36 %' })).toBe('Доля смен: 34 → 36 %');
  });
});
