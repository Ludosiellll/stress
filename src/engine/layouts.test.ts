import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LayoutId, SessionKind } from './types';
import { dayLayout, keyLabel, LAYOUT_NAMES, layoutKeys, normalizeKey, trainingDayNumber } from './layouts';

const TABLE: Record<LayoutId, (string[] | null)[]> = {
  keyboard: [
    ['Space'],
    ['KeyF', 'KeyJ'],
    ['KeyD', 'KeyF', 'KeyJ'],
    ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
    ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK'],
    ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
  ],
  pult: [
    ['ArrowDown'],
    ['ArrowLeft', 'ArrowRight'],
    ['ArrowLeft', 'ArrowDown', 'ArrowRight'],
    ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'],
    ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'],
    ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'],
  ],
  mouse: [['MouseLeft'], ['MouseLeft', 'MouseRight'], null, null, null, null],
};

describe('layoutKeys table', () => {
  const rows = (Object.keys(TABLE) as LayoutId[]).flatMap((layout) =>
    TABLE[layout].map((keys, i) => ({ layout, n: i + 1, keys })),
  );
  it.each(rows)('$layout n=$n', ({ layout, n, keys }) => {
    const r = layoutKeys(layout, n);
    if (keys) {
      expect(r.keys).toEqual(keys);
      expect(r.effectiveLayout).toBe(layout);
    } else {
      expect(r.keys).toEqual(TABLE.keyboard[n - 1]);
      expect(r.effectiveLayout).toBe('keyboard');
    }
  });

  it('mouse with n=4 falls back to keyboard', () => {
    expect(layoutKeys('mouse', 4).effectiveLayout).toBe('keyboard');
  });

  it.each([0, 7, -1, 1.5, NaN, Infinity])('throws RangeError for n=%s', (n) => {
    expect(() => layoutKeys('keyboard', n)).toThrow(RangeError);
  });
});

describe('normalizeKey', () => {
  it('maps numpad on pult', () => {
    expect(normalizeKey('Numpad4', 'pult')).toBe('ArrowLeft');
    expect(normalizeKey('Numpad6', 'pult')).toBe('ArrowRight');
    expect(normalizeKey('Numpad8', 'pult')).toBe('ArrowUp');
    expect(normalizeKey('Numpad2', 'pult')).toBe('ArrowDown');
    expect(normalizeKey('Numpad1', 'pult')).toBe('Digit1');
    expect(normalizeKey('Numpad3', 'pult')).toBe('Digit3');
    expect(normalizeKey('Numpad5', 'pult')).toBe('Digit5');
  });
  it('leaves other layouts and codes unchanged', () => {
    expect(normalizeKey('Numpad4', 'keyboard')).toBe('Numpad4');
    expect(normalizeKey('Numpad4', 'mouse')).toBe('Numpad4');
    expect(normalizeKey('KeyF', 'pult')).toBe('KeyF');
    expect(normalizeKey('Numpad7', 'pult')).toBe('Numpad7');
  });
});

describe('keyLabel', () => {
  it.each([
    ['Space', 'Пробел'],
    ['KeyF', 'F'],
    ['Digit3', '3'],
    ['Numpad5', '5'],
    ['ArrowLeft', '←'],
    ['ArrowRight', '→'],
    ['ArrowUp', '↑'],
    ['ArrowDown', '↓'],
    ['MouseLeft', 'ЛКМ'],
    ['MouseRight', 'ПКМ'],
    ['Enter', 'Enter'],
  ])('%s -> %s', (code, label) => {
    expect(keyLabel(code)).toBe(label);
  });
});

describe('dayLayout (F9, T-R64)', () => {
  const day = (trainingDay: number, daysToTest: number | null = null) => ({ trainingDay, daysToTest });

  it('training days 1–4 play the primary, the first other, the primary, the second other; the others keep the order keyboard, pult, mouse', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => dayLayout('keyboard', day(n), true))).toEqual([
      'keyboard',
      'pult',
      'keyboard',
      'mouse',
      'keyboard',
      'pult',
      'keyboard',
      'mouse',
    ]);
    expect([2, 4].map((n) => dayLayout('pult', day(n), true))).toEqual(['keyboard', 'mouse']);
    expect([2, 4].map((n) => dayLayout('mouse', day(n), true))).toEqual(['keyboard', 'pult']);
  });

  it('the primary when the rotation is off or the test is 3 days away or less', () => {
    expect(dayLayout('keyboard', day(2), false)).toBe('keyboard');
    expect(dayLayout('keyboard', day(2, 3), true)).toBe('keyboard');
    expect(dayLayout('keyboard', day(4, 0), true)).toBe('keyboard');
    expect(dayLayout('keyboard', day(2, 4), true)).toBe('pult');
  });

  it('any 28 training days in a row: the primary on exactly 14', () => {
    const layout = fc.constantFrom<LayoutId>('keyboard', 'pult', 'mouse');
    fc.assert(
      fc.property(layout, fc.integer({ min: 1, max: 10_000 }), (primary, from) => {
        const days = Array.from({ length: 28 }, (_, i) => dayLayout(primary, day(from + i), true));
        expect(days.filter((l) => l === primary)).toHaveLength(14);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('trainingDayNumber (T-R64)', () => {
  const TODAY = '2026-10-14';
  const at = (startedAt: string, kind: SessionKind = 'training') => ({ startedAt, kind });

  it('no session yet: training day 1', () => {
    expect(trainingDayNumber([], TODAY)).toBe(1);
  });

  it('the local days with a training or free session before today, plus 1; two sessions on a day count once', () => {
    const sessions = [
      at('2026-10-08T09:00:00'),
      at('2026-10-08T20:00:00', 'free'),
      at('2026-10-10T09:00:00', 'free'),
      at('2026-10-12T23:30:00'),
    ];
    expect(trainingDayNumber(sessions, TODAY)).toBe(4);
  });

  it('diagnostics, today’s sessions, later days and unreadable dates do not count', () => {
    const sessions = [
      at('2026-10-11T09:00:00', 'diagnostic'),
      at('2026-10-14T08:00:00'),
      at('2026-10-15T09:00:00'),
      at('yesterday'),
      at('2026-10-13T09:00:00', 'free'),
    ];
    expect(trainingDayNumber(sessions, TODAY)).toBe(2);
  });

  it('an every-other-day course from day 2 rotates by training day: the primary comes back every other session', () => {
    // Calendar days 2, 4, 6, 8 of a course begun by a diagnostic on day 1: by calendar day they were all «others».
    const days = ['2026-10-02', '2026-10-04', '2026-10-06', '2026-10-08'];
    const layouts = days.map((d, i) => {
      const trainingDay = trainingDayNumber(days.slice(0, i).map((x) => at(`${x}T09:00:00`)), d);
      return dayLayout('keyboard', { trainingDay, daysToTest: null }, true);
    });
    expect(layouts).toEqual(['keyboard', 'pult', 'keyboard', 'mouse']);
  });
});

describe('LAYOUT_NAMES', () => {
  it('names', () => {
    expect(LAYOUT_NAMES).toEqual({ keyboard: 'клавиатура', pult: 'пульт (стрелки и цифры)', mouse: 'мышь' });
  });
});
