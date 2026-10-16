import { describe, expect, it } from 'vitest';
import { ALPHABET, LETTER_KEY_CODES, letterFromKey, letterPosition } from './letters';

describe('ALPHABET', () => {
  it('has the 32 letters without Ё, in order (Справочник F12)', () => {
    expect(ALPHABET).toHaveLength(32);
    expect(ALPHABET).not.toContain('Ё');
    expect(ALPHABET.join('')).toBe('АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ');
  });
});

describe('LETTER_KEY_CODES', () => {
  it('names the ЙЦУКЕН key of every letter, each key once', () => {
    expect(LETTER_KEY_CODES).toEqual({
      Й: 'KeyQ',
      Ц: 'KeyW',
      У: 'KeyE',
      К: 'KeyR',
      Е: 'KeyT',
      Н: 'KeyY',
      Г: 'KeyU',
      Ш: 'KeyI',
      Щ: 'KeyO',
      З: 'KeyP',
      Х: 'BracketLeft',
      Ъ: 'BracketRight',
      Ф: 'KeyA',
      Ы: 'KeyS',
      В: 'KeyD',
      А: 'KeyF',
      П: 'KeyG',
      Р: 'KeyH',
      О: 'KeyJ',
      Л: 'KeyK',
      Д: 'KeyL',
      Ж: 'Semicolon',
      Э: 'Quote',
      Я: 'KeyZ',
      Ч: 'KeyX',
      С: 'KeyC',
      М: 'KeyV',
      И: 'KeyB',
      Т: 'KeyN',
      Ь: 'KeyM',
      Б: 'Comma',
      Ю: 'Period',
    });
    expect(Object.keys(LETTER_KEY_CODES).sort()).toEqual([...ALPHABET].sort());
    expect(new Set(Object.values(LETTER_KEY_CODES)).size).toBe(32);
  });
});

describe('letterFromKey', () => {
  it('reads the physical key on any layout (Справочник F12)', () => {
    expect(letterFromKey({ key: 'd', code: 'KeyD' })).toBe('В');
    expect(letterFromKey({ key: 'в', code: 'KeyD' })).toBe('В');
    expect(letterFromKey({ key: 'ё', code: 'Backquote' })).toBeNull();
  });

  it('every letter by its key, on either layout and in either case', () => {
    for (const [letter, code] of Object.entries(LETTER_KEY_CODES)) {
      expect(letterFromKey({ key: 'x', code })).toBe(letter);
      expect(letterFromKey({ key: letter.toLowerCase(), code })).toBe(letter);
      expect(letterFromKey({ key: letter, code })).toBe(letter);
    }
  });

  it('the Russian letter the key prints wins over the code; other keys give nothing', () => {
    expect(letterFromKey({ key: 'т', code: 'KeyM' })).toBe('Т');
    expect(letterFromKey({ key: '7', code: 'Digit7' })).toBeNull();
    expect(letterFromKey({ key: ' ', code: 'Space' })).toBeNull();
    expect(letterFromKey({ key: 'Enter', code: 'Enter' })).toBeNull();
    expect(letterFromKey({ key: 'Backspace', code: 'Backspace' })).toBeNull();
  });
});

describe('letterPosition', () => {
  it('1 for А … 32 for Я; any case; null for anything else', () => {
    expect(letterPosition('А')).toBe(1);
    expect(letterPosition('Я')).toBe(32);
    expect(letterPosition('й')).toBe(10);
    ALPHABET.forEach((letter, i) => {
      expect(letterPosition(letter)).toBe(i + 1);
    });
    expect(letterPosition('Ё')).toBeNull();
    expect(letterPosition('D')).toBeNull();
    expect(letterPosition('')).toBeNull();
    expect(letterPosition('АБ')).toBeNull();
  });
});
