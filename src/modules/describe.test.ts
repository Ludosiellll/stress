import { describe, expect, it } from 'vitest';
import { describeChanges } from './describe';

describe('describeChanges', () => {
  it('pzmr 10 → 11: only the response window changes', () => {
    expect(describeChanges('pzmr', 10, 11)).toEqual([{ label: 'Окно ответа', from: '387 мс', to: '358 мс' }]);
  });

  it('same level: nothing changed', () => {
    expect(describeChanges('szmr', 5, 5)).toEqual([]);
    expect(describeChanges('gorbov', 3, 3, 'alternate')).toEqual([]);
  });

  it('szmr band change lists every changed parameter and skips unchanged ones', () => {
    expect(describeChanges('szmr', 7, 8)).toEqual([
      { label: 'Окно ответа', from: '903 мс', to: '843 мс' },
      { label: 'Цветов', from: '2', to: '3' },
    ]);
  });

  it('level down shows the change in the other direction', () => {
    expect(describeChanges('gonogo', 20, 19)).toEqual([
      { label: 'Окно ответа', from: '253 мс', to: '265 мс' },
      { label: 'Доля no-go', from: '30 %', to: '29 %' },
    ]);
  });

  it('rdo: period and tolerance', () => {
    expect(describeChanges('rdo', 0, 2)).toEqual([
      { label: 'Период обхода', from: '3000 мс', to: '2595 мс' },
      { label: 'Допуск', from: '60 мс', to: '53 мс' },
    ]);
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

  it('stroop: a third colour at L = 8', () => {
    expect(describeChanges('stroop', 7, 8)).toContainEqual({ label: 'Цветов', from: '2', to: '3' });
    expect(describeChanges('stroop', 11, 12)).toContainEqual({ label: 'Подсказка клавиш', from: 'да', to: 'нет' });
  });

  it('numseries has no level parameters', () => {
    expect(describeChanges('numseries', 0, 0)).toEqual([]);
  });
});
