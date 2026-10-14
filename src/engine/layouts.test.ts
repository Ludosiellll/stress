import { describe, expect, it } from 'vitest';
import type { LayoutId } from './types';
import { keyLabel, layoutKeys, normalizeKey } from './layouts';

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
