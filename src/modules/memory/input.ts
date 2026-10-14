import { MEMORY_LETTERS } from './params';

/** The key of each letter on a ЙЦУКЕН keyboard (KeyboardEvent.code names the physical key, whatever the layout). */
const LETTER_BY_CODE: Readonly<Record<string, string>> = {
  Comma: 'Б',
  KeyD: 'В',
  KeyU: 'Г',
  KeyL: 'Д',
  Semicolon: 'Ж',
  KeyP: 'З',
  KeyR: 'К',
  KeyK: 'Л',
  KeyV: 'М',
  KeyY: 'Н',
  KeyG: 'П',
  KeyH: 'Р',
  KeyC: 'С',
  KeyN: 'Т',
};

const DIGIT_CODE = /^(?:Digit|Numpad)([0-9])$/;

/**
 * The letter of the set the key stands for, or null. With a Russian layout the printed letter (`key`) counts;
 * otherwise (e.g. an English layout, where the same key gives 'd') the physical key is read as ЙЦУКЕН, so the
 * user never has to switch layouts.
 */
export function letterFromKey(e: { key: string; code: string }): string | null {
  const upper = e.key.toUpperCase();
  if (MEMORY_LETTERS.includes(upper)) return upper;
  return LETTER_BY_CODE[e.code] ?? null;
}

/** The digit of the top row or the numeric keypad (also with Num Lock off or Shift held), or null. */
export function digitFromKey(e: { key: string; code: string }): string | null {
  if (/^[0-9]$/.test(e.key)) return e.key;
  return DIGIT_CODE.exec(e.code)?.[1] ?? null;
}
