import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CARD_AUDIO,
  CARD_LESSON,
  cardExposureText,
  describeMemoryParams,
  isMemoryMode,
  MEMORY_LETTERS,
  MEMORY_TRIALS,
  memoryInstruction,
  memoryKeysHint,
  memoryModeForBlock,
  memoryParams,
  nextMemoryMode,
  STORED_MEMORY_MODES,
  type MemoryMode,
} from './params';

const SEQUENTIAL: readonly MemoryMode[] = ['digits', 'letters', 'positions'];
const MODES: readonly MemoryMode[] = [...SEQUENTIAL, 'card3x3'];

describe('memoryParams (F13)', () => {
  it('digits at L 9: 7 long, 630 ms each with a 158 ms pause, no card, no sound', () => {
    expect(memoryParams(9, 'digits')).toEqual({ length: 7, itemMs: 630, gapMs: 158, exposureMs: null, rows: null, sound: false });
  });

  it.each([
    [0, { length: 4, itemMs: 1000, gapMs: 250 }],
    [15, { length: 9, itemMs: 463, gapMs: 116 }],
    [24, { length: 12, itemMs: 300, gapMs: 100 }],
  ])('digits at L = %d keep the timing of 0.2.0', (L, expected) => {
    expect(memoryParams(L, 'digits')).toEqual({ ...expected, exposureMs: null, rows: null, sound: false });
  });

  it('letters and positions are one item shorter than digits: 6 at L 9', () => {
    for (const mode of ['letters', 'positions'] as const) {
      expect(memoryParams(9, mode)).toEqual({ ...memoryParams(9, 'digits'), length: 6 });
      expect(memoryParams(0, mode).length).toBe(3);
    }
  });

  it.each([
    [0, 5, 2, 10_000, false],
    [11.99, 8, 3, 10_000, false],
    [12, 9, 3, 10_000, false],
    [15, 9, 3, 7000, false],
    [18, 9, 3, 5000, false],
    [20.99, 9, 3, 5000, false],
    [21, 9, 3, 5000, true],
    [24, 12, 4, 10_000, true],
    [27, 12, 4, 7000, true],
    [30, 12, 4, 5000, true],
    [33, 15, 5, 10_000, true],
    [42, 18, 6, 10_000, true],
  ])('the 3×3 card at L %d: %d digits in %d rows, shown %d ms, sound %s', (L, length, rows, exposureMs, sound) => {
    expect(memoryParams(L, 'card3x3')).toMatchObject({ length, rows, exposureMs, sound });
  });

  it('the card keeps the level timing of the sequential modes for its unused item fields', () => {
    const { itemMs, gapMs } = memoryParams(9, 'digits');
    expect(memoryParams(9, 'card3x3')).toMatchObject({ itemMs, gapMs });
  });

  it('is monotone in every mode: rows never shorter as L grows, a row of the same length never shown longer', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MODES),
        fc.double({ min: 0, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 200, noNaN: true }),
        (mode, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const p = memoryParams(lo, mode);
          const q = memoryParams(hi, mode);
          expect(q.length).toBeGreaterThanOrEqual(p.length);
          expect(q.itemMs).toBeLessThanOrEqual(p.itemMs);
          expect(q.gapMs).toBeLessThanOrEqual(p.gapMs);
          expect(q.itemMs).toBeGreaterThanOrEqual(300);
          expect(q.gapMs).toBeGreaterThanOrEqual(100);
          if (mode === 'card3x3') {
            if (q.length === p.length) expect(q.exposureMs ?? 0).toBeLessThanOrEqual(p.exposureMs ?? 0);
            // Once on, the sound stays on.
            if (p.sound) expect(q.sound).toBe(true);
            expect(q.rows).toBe(Math.ceil(q.length / 3));
          } else {
            expect([q.exposureMs, q.rows, q.sound]).toEqual([null, null, false]);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('rejects a negative or non-finite level', () => {
    for (const mode of MODES) {
      expect(() => memoryParams(-1, mode)).toThrow(RangeError);
      expect(() => memoryParams(Number.NaN, mode)).toThrow(RangeError);
      expect(() => memoryParams(Number.POSITIVE_INFINITY, mode)).toThrow(RangeError);
    }
  });
});

describe('memory modes and texts', () => {
  it('cycles digits → positions → card3x3 → letters by block index', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(memoryModeForBlock)).toEqual([
      'digits',
      'positions',
      'card3x3',
      'letters',
      'digits',
      'positions',
      'card3x3',
      'letters',
    ]);
    // The mode after each one: what the next block plays (T-R78).
    expect(['digits', 'positions', 'card3x3', 'letters'].map((m) => nextMemoryMode(m as MemoryMode))).toEqual([
      'positions',
      'card3x3',
      'letters',
      'digits',
    ]);
    expect(() => memoryModeForBlock(-1)).toThrow(RangeError);
    expect(() => memoryModeForBlock(1.5)).toThrow(RangeError);
  });

  it('ten trials per block; fourteen consonants; the played modes and the stored ones (Р27)', () => {
    expect(MEMORY_TRIALS).toBe(10);
    expect(MEMORY_LETTERS).toEqual(['Б', 'В', 'Г', 'Д', 'Ж', 'З', 'К', 'Л', 'М', 'Н', 'П', 'Р', 'С', 'Т']);
    expect(STORED_MEMORY_MODES).toEqual(['digits', 'letters', 'positions', 'card3x3', 'card']);
    expect(STORED_MEMORY_MODES.filter(isMemoryMode)).toEqual(['digits', 'letters', 'positions', 'card3x3']);
    expect(isMemoryMode('card')).toBe(false);
  });

  it('the card sound and the lesson (Справочник F13)', () => {
    expect(CARD_AUDIO).toEqual({ layers: ['hum', 'babble'], gain: 0.7 });
    expect(CARD_LESSON).toEqual([
      'Как запоминать карточку 3×3.',
      'Читай строки как три трёхзначных числа: 4 7 2 — „четыреста семьдесят два“.',
      'Проговаривай их про себя по кругу, пока карточка на экране.',
      'Свяжи числа с чем-то знакомым: год, время, номер дома.',
      'Вводи по строкам слева направо. Не помнишь цифру — поставь любую: засчитывается каждая цифра на своём месте.',
    ]);
  });

  it('instructions per mode; the card names its digit count and ends with the strategy', () => {
    const p = memoryParams(0, 'digits');
    expect(memoryInstruction('digits', p)).toBe('Запомни цифры по порядку. Потом набери их и нажми Enter.');
    expect(memoryInstruction('letters', p)).toBe(
      'Запомни буквы по порядку. Потом набери их и нажми Enter. Раскладку переключать не нужно: жми клавиши, на которых нарисованы эти буквы.',
    );
    expect(memoryInstruction('positions', p)).toBe(
      'Клетки загораются по одной. Потом щёлкни по ним мышью в том же порядке и нажми Enter.',
    );
    expect(memoryInstruction('card3x3', memoryParams(0, 'card3x3'))).toBe(
      'На карточке 5 цифр. Запомни их по строкам, слева направо. Потом набери и нажми Enter. Стратегия: читай строки как трёхзначные числа.',
    );
    expect(memoryInstruction('card3x3', memoryParams(9, 'card3x3'))).toContain('На карточке 8 цифр.');
    // With sound the card announces it like the other sound blocks (T-R66).
    expect(memoryParams(21, 'card3x3').sound).toBe(true);
    expect(memoryInstruction('card3x3', memoryParams(21, 'card3x3'))).toBe(
      'На карточке 9 цифр. Запомни их по строкам, слева направо. Потом набери и нажми Enter. Стратегия: читай строки как трёхзначные числа. ' +
        'Пока карточка на экране, будут звуковые помехи. Надень наушники.',
    );
    const card = memoryParams(0, 'card3x3');
    expect(memoryInstruction('card3x3', { ...card, length: 21 })).toContain('На карточке 21 цифра.');
    expect(memoryInstruction('card3x3', { ...card, length: 12 })).toContain('На карточке 12 цифр.');
    expect(memoryInstruction('card3x3', { ...card, length: 3 })).toContain('На карточке 3 цифры.');
  });

  it('key hints per mode', () => {
    expect(memoryKeysHint('digits')).toBe('Цифры, Backspace, Enter');
    expect(memoryKeysHint('card3x3')).toBe('Цифры, Backspace, Enter');
    expect(memoryKeysHint('letters')).toBe('Буквы, Backspace, Enter');
    expect(memoryKeysHint('positions')).toBe('Мышь, Enter');
  });

  it('describes the mode, the row length and how it is shown', () => {
    expect(describeMemoryParams('digits', memoryParams(9, 'digits'))).toEqual([
      { label: 'Режим', value: 'цифры' },
      { label: 'Длина ряда', value: '7' },
      { label: 'Показ', value: '630 мс на элемент' },
    ]);
    expect(describeMemoryParams('positions', memoryParams(9, 'positions'))[0]).toEqual({ label: 'Режим', value: 'позиции' });
    expect(describeMemoryParams('letters', memoryParams(9, 'letters'))[0]).toEqual({ label: 'Режим', value: 'буквы' });
    expect(describeMemoryParams('card3x3', memoryParams(15, 'card3x3'))).toEqual([
      { label: 'Режим', value: 'карточка 3×3' },
      { label: 'Длина ряда', value: '9' },
      { label: 'Показ', value: '7 с' },
    ]);
    expect(describeMemoryParams('card3x3', memoryParams(21, 'card3x3'))[2]).toEqual({ label: 'Показ', value: '5 с, со звуком' });
    expect(cardExposureText(7500, false)).toBe('7,5 с');
  });
});
