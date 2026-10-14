import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  describeMemoryParams,
  MEMORY_LETTERS,
  MEMORY_TRIALS,
  memoryInstruction,
  memoryKeysHint,
  memoryModeForBlock,
  memoryParams,
} from './params';

describe('memoryParams', () => {
  it.each([
    [0, { length: 4, itemMs: 1000, gapMs: 250 }],
    [9, { length: 7, itemMs: 630, gapMs: 158 }],
    [15, { length: 9, itemMs: 463, gapMs: 116 }],
    [24, { length: 12, itemMs: 300, gapMs: 100 }],
  ])('L = %d → reference point', (L, expected) => {
    expect(memoryParams(L)).toEqual(expected);
  });

  it('is monotone: longer rows, shorter display and pause as L grows', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 200, noNaN: true }), fc.double({ min: 0, max: 200, noNaN: true }), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const p = memoryParams(lo);
        const q = memoryParams(hi);
        expect(q.length).toBeGreaterThanOrEqual(p.length);
        expect(q.itemMs).toBeLessThanOrEqual(p.itemMs);
        expect(q.gapMs).toBeLessThanOrEqual(p.gapMs);
        expect(q.itemMs).toBeGreaterThanOrEqual(300);
        expect(q.gapMs).toBeGreaterThanOrEqual(100);
      }),
      { numRuns: 1000 },
    );
  });

  it('rejects a negative or non-finite level', () => {
    expect(() => memoryParams(-1)).toThrow(RangeError);
    expect(() => memoryParams(Number.NaN)).toThrow(RangeError);
    expect(() => memoryParams(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('memory modes and texts', () => {
  it('cycles digits → positions → card → letters by block index', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(memoryModeForBlock)).toEqual([
      'digits',
      'positions',
      'card',
      'letters',
      'digits',
      'positions',
      'card',
      'letters',
    ]);
    expect(() => memoryModeForBlock(-1)).toThrow(RangeError);
    expect(() => memoryModeForBlock(1.5)).toThrow(RangeError);
  });

  it('six trials per block; fourteen consonants', () => {
    expect(MEMORY_TRIALS).toBe(6);
    expect(MEMORY_LETTERS).toEqual(['Б', 'В', 'Г', 'Д', 'Ж', 'З', 'К', 'Л', 'М', 'Н', 'П', 'Р', 'С', 'Т']);
  });

  it('instructions per mode; the card names its digit count', () => {
    const p = memoryParams(0);
    expect(memoryInstruction('digits', p)).toBe('Запомни цифры по порядку. Потом набери их и нажми Enter.');
    expect(memoryInstruction('letters', p)).toBe(
      'Запомни буквы по порядку. Потом набери их и нажми Enter. Раскладку переключать не нужно: жми клавиши, на которых нарисованы эти буквы.',
    );
    expect(memoryInstruction('positions', p)).toBe(
      'Клетки загораются по одной. Потом щёлкни по ним мышью в том же порядке и нажми Enter.',
    );
    expect(memoryInstruction('card', p)).toBe('На карточке 4 цифры. Запомни их по строкам, слева направо. Потом набери и нажми Enter.');
    expect(memoryInstruction('card', memoryParams(9))).toBe(
      'На карточке 7 цифр. Запомни их по строкам, слева направо. Потом набери и нажми Enter.',
    );
    expect(memoryInstruction('card', { length: 21, itemMs: 300, gapMs: 100 })).toContain('На карточке 21 цифра.');
    expect(memoryInstruction('card', { length: 11, itemMs: 300, gapMs: 100 })).toContain('На карточке 11 цифр.');
    expect(memoryInstruction('card', { length: 12, itemMs: 300, gapMs: 100 })).toContain('На карточке 12 цифр.');
  });

  it('key hints per mode', () => {
    expect(memoryKeysHint('digits')).toBe('Цифры, Backspace, Enter');
    expect(memoryKeysHint('card')).toBe('Цифры, Backspace, Enter');
    expect(memoryKeysHint('letters')).toBe('Буквы, Backspace, Enter');
    expect(memoryKeysHint('positions')).toBe('Мышь, Enter');
  });

  it('describes length, display time and pause', () => {
    expect(describeMemoryParams(memoryParams(9))).toEqual([
      { label: 'Длина ряда', value: '7' },
      { label: 'Показ элемента', value: '630 мс' },
      { label: 'Пауза', value: '158 мс' },
    ]);
  });
});
