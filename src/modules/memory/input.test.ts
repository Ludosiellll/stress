import { describe, expect, it } from 'vitest';
import { digitFromKey, letterFromKey } from './input';
import { MEMORY_LETTERS } from './params';

describe('letterFromKey', () => {
  it('letterFromKey maps physical keys on an English layout', () => {
    expect(letterFromKey({ key: 'd', code: 'KeyD' })).toBe('В');
    expect(letterFromKey({ key: ',', code: 'Comma' })).toBe('Б');
    expect(letterFromKey({ key: 'в', code: 'KeyD' })).toBe('В');
    expect(letterFromKey({ key: 'q', code: 'KeyQ' })).toBeNull();
  });

  it('every letter of the set by its ЙЦУКЕН key, on either layout and in either case', () => {
    const codes: Record<string, string> = {
      Б: 'Comma',
      В: 'KeyD',
      Г: 'KeyU',
      Д: 'KeyL',
      Ж: 'Semicolon',
      З: 'KeyP',
      К: 'KeyR',
      Л: 'KeyK',
      М: 'KeyV',
      Н: 'KeyY',
      П: 'KeyG',
      Р: 'KeyH',
      С: 'KeyC',
      Т: 'KeyN',
    };
    expect(Object.keys(codes)).toEqual(MEMORY_LETTERS);
    for (const [letter, code] of Object.entries(codes)) {
      expect(letterFromKey({ key: 'x', code })).toBe(letter);
      expect(letterFromKey({ key: letter.toLowerCase(), code })).toBe(letter);
      expect(letterFromKey({ key: letter, code })).toBe(letter);
    }
  });

  it('the Russian key wins over the code; other keys give nothing', () => {
    // A layout where the letter is on another key: what the key prints counts.
    expect(letterFromKey({ key: 'т', code: 'KeyM' })).toBe('Т');
    expect(letterFromKey({ key: 'а', code: 'KeyF' })).toBeNull();
    expect(letterFromKey({ key: '7', code: 'Digit7' })).toBeNull();
    expect(letterFromKey({ key: 'Enter', code: 'Enter' })).toBeNull();
    expect(letterFromKey({ key: 'Backspace', code: 'Backspace' })).toBeNull();
  });
});

describe('digitFromKey', () => {
  it('digitFromKey accepts top row and numpad', () => {
    expect(digitFromKey({ key: '7', code: 'Digit7' })).toBe('7');
    expect(digitFromKey({ key: '7', code: 'Numpad7' })).toBe('7');
    expect(digitFromKey({ key: 'Unidentified', code: 'Numpad3' })).toBe('3');
    expect(digitFromKey({ key: 'a', code: 'KeyA' })).toBeNull();
  });

  it('every digit; shifted top-row keys still count by their code; other keys do not', () => {
    for (let d = 0; d <= 9; d++) {
      const s = String(d);
      expect(digitFromKey({ key: s, code: `Digit${s}` })).toBe(s);
      expect(digitFromKey({ key: 'Unidentified', code: `Numpad${s}` })).toBe(s);
    }
    expect(digitFromKey({ key: '&', code: 'Digit7' })).toBe('7');
    expect(digitFromKey({ key: 'Enter', code: 'NumpadEnter' })).toBeNull();
    expect(digitFromKey({ key: '-', code: 'Minus' })).toBeNull();
    expect(digitFromKey({ key: '12', code: 'KeyA' })).toBeNull();
  });
});
