/**
 * The letters of number series and of memory (F12, Р28): 32 letters without Ё, positions 1…32, typed by their physical
 * key on a ЙЦУКЕН keyboard (KeyboardEvent.code names the key, whatever the layout), so no one has to switch layouts.
 */

/** А … Я without Ё: position i + 1 is ALPHABET[i] (Справочник F12). */
export const ALPHABET: readonly string[] = Object.freeze('А Б В Г Д Е Ж З И Й К Л М Н О П Р С Т У Ф Х Ц Ч Ш Щ Ъ Ы Ь Э Ю Я'.split(' '));

/** The ЙЦУКЕН key of each letter (Справочник F12). */
export const LETTER_KEY_CODES: Readonly<Record<string, string>> = Object.freeze({
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

const LETTER_BY_CODE: ReadonlyMap<string, string> = new Map(Object.entries(LETTER_KEY_CODES).map(([letter, code]) => [code, letter]));

/** 1…32 for a letter of ALPHABET in either case; null for anything else (Ё too). */
export function letterPosition(letter: string): number | null {
  const i = ALPHABET.indexOf(letter.toUpperCase());
  return i < 0 ? null : i + 1;
}

/**
 * The letter the key stands for, or null. With a Russian layout the printed letter (`key`) counts; otherwise (e.g. an
 * English layout, where the same key gives 'd') the physical key is read as ЙЦУКЕН.
 */
export function letterFromKey(e: { key: string; code: string }): string | null {
  const upper = e.key.toUpperCase();
  if (ALPHABET.includes(upper)) return upper;
  return LETTER_BY_CODE.get(e.code) ?? null;
}
