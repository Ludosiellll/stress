import { LETTER_KEY_CODES } from '../numseries/letters';
import { MEMORY_LETTERS } from './params';

/** The ЙЦУКЕН key of each letter of the set, from the one letters source (T-R19). */
const LETTER_BY_CODE: ReadonlyMap<string, string> = new Map(MEMORY_LETTERS.map((letter) => [LETTER_KEY_CODES[letter] as string, letter]));

const DIGIT_CODE = /^(?:Digit|Numpad)([0-9])$/;

/**
 * The letter of the set the key stands for, or null. With a Russian layout the printed letter (`key`) counts;
 * otherwise (e.g. an English layout, where the same key gives 'd') the physical key is read as ЙЦУКЕН, so the
 * user never has to switch layouts.
 * Apart from numseries' letterFromKey on purpose: only MEMORY_LETTERS count, so a printed letter outside the set
 * (a Russian layout other than ЙЦУКЕН) falls back to the physical key.
 */
export function letterFromKey(e: { key: string; code: string }): string | null {
  const upper = e.key.toUpperCase();
  if (MEMORY_LETTERS.includes(upper)) return upper;
  return LETTER_BY_CODE.get(e.code) ?? null;
}

/** The digit of the top row or the numeric keypad (also with Num Lock off or Shift held), or null. */
export function digitFromKey(e: { key: string; code: string }): string | null {
  if (/^[0-9]$/.test(e.key)) return e.key;
  return DIGIT_CODE.exec(e.code)?.[1] ?? null;
}
