import type { AudioStressorParams } from '../../engine/audio/stressors';
import { ms } from '../reaction/common';

/**
 * «Память»: rows of digits or letters shown one at a time, cells of a grid lit one at a time, or a 3×3 card of digits
 * shown whole as on the test; the row is reproduced in order afterwards. One level for every mode (F13, spec §4.7):
 * at the same L the modes are about equally hard for the recall model of spec §8.5.
 */

/** digits, letters and positions are sequential (one item at a time); card3x3 shows every digit at once (F13). */
export type MemoryMode = 'digits' | 'letters' | 'positions' | 'card3x3';
/** A mode a stored block may name: the played ones and the card of 0.2.0, which is only read from history (Р27). */
export type StoredMemoryMode = MemoryMode | 'card';

export interface MemoryParams {
  /** Items in a row (digits on the card). */
  length: number;
  /** How long each item of a sequential mode is on screen, ms (the card ignores it). */
  itemMs: number;
  /** Blank pause between items, ms (the card ignores it). */
  gapMs: number;
  /** How long the card is on screen, ms; null for the sequential modes. */
  exposureMs: number | null;
  /** Rows of 3 on the card; null for the sequential modes. */
  rows: number | null;
  /** The card plays CARD_AUDIO while it is on screen. */
  sound: boolean;
}

/** Trials per block (scaledCount applies under the e2e scale), F13. */
export const MEMORY_TRIALS = 10;

/** The 14 consonants of the letter rows. */
export const MEMORY_LETTERS: readonly string[] = ['Б', 'В', 'Г', 'Д', 'Ж', 'З', 'К', 'Л', 'М', 'Н', 'П', 'Р', 'С', 'Т'];

/** The sound of a card from L 21: hum and babble at 0.7 of the volume setting, only while the card is on screen. */
export const CARD_AUDIO: AudioStressorParams = { layers: ['hum', 'babble'], gain: 0.7 };

/** The strategy lesson before the first 3×3 card (Справочник F13), line by line. */
export const CARD_LESSON: readonly string[] = Object.freeze([
  'Как запоминать карточку 3×3.',
  'Читай строки как три трёхзначных числа: 4 7 2 — „четыреста семьдесят два“.',
  'Проговаривай их про себя по кругу, пока карточка на экране.',
  'Свяжи числа с чем-то знакомым: год, время, номер дома.',
  'Вводи по строкам слева направо. Не помнишь цифру — поставь любую: засчитывается каждая цифра на своём месте.',
]);

const MODE_CYCLE: readonly MemoryMode[] = ['digits', 'positions', 'card3x3', 'letters'];

/** Every mode a stored block may name (Р27). */
export const STORED_MEMORY_MODES: readonly StoredMemoryMode[] = ['digits', 'letters', 'positions', 'card3x3', 'card'];

/** A mode that is played now; the card of 0.2.0 is not (Р27). */
export function isMemoryMode(mode: string): mode is MemoryMode {
  return (MODE_CYCLE as readonly string[]).includes(mode);
}

/** The card's exposures in turn, 10 → 7 → 5 s, every 3 levels (F13). */
const CARD_EXPOSURES_MS = [10_000, 7000, 5000] as const;
const CARD_COLUMNS = 3;
/** Below this level the card has fewer than 9 digits, shown 10 s. */
const FULL_CARD_FROM = 12;
/** From this level the card has 12 digits and more, with sound. */
const BIG_CARD_FROM = 24;
/** 9 digits, 5 s, with sound: the step of the card from L 21. */
const CARD_SOUND_FROM = 21;
/** From BIG_CARD_FROM a row of 3 digits more every 9 levels. */
const LEVELS_PER_ROW = 9;
const LEVELS_PER_STEP = 3;

/** The card at L (Справочник F13): its digits, rows of 3, exposure and sound. */
function card(L: number): Pick<MemoryParams, 'length' | 'exposureMs' | 'rows' | 'sound'> {
  const step = Math.floor(L / LEVELS_PER_STEP);
  if (L < FULL_CARD_FROM) {
    const length = Math.min(9, 5 + step);
    return { length, rows: Math.ceil(length / CARD_COLUMNS), exposureMs: CARD_EXPOSURES_MS[0], sound: false };
  }
  if (L < BIG_CARD_FROM) {
    const k = Math.floor((L - FULL_CARD_FROM) / LEVELS_PER_STEP);
    return { length: 9, rows: 3, exposureMs: CARD_EXPOSURES_MS[Math.min(k, 2)] as number, sound: L >= CARD_SOUND_FROM };
  }
  const rows = 4 + Math.floor((L - BIG_CARD_FROM) / LEVELS_PER_ROW);
  const exposureMs = CARD_EXPOSURES_MS[Math.floor((L - BIG_CARD_FROM) / LEVELS_PER_STEP) % CARD_EXPOSURES_MS.length] as number;
  return { length: CARD_COLUMNS * rows, rows, exposureMs, sound: true };
}

/**
 * The parameters of a mode at L (Справочник F13): digits 4 + ⌊L/3⌋ long, letters and positions one shorter; each item
 * round(max(300, 1000·0.95^L)) ms with a round(max(100, 250·0.95^L)) ms pause; the card by its table.
 */
export function memoryParams(L: number, mode: MemoryMode): MemoryParams {
  if (!(Number.isFinite(L) && L >= 0)) throw new RangeError(`memoryParams: L must be a finite number ≥ 0, got ${String(L)}`);
  const decay = 0.95 ** L;
  const timing = { itemMs: Math.round(Math.max(300, 1000 * decay)), gapMs: Math.round(Math.max(100, 250 * decay)) };
  const step = Math.floor(L / LEVELS_PER_STEP);
  switch (mode) {
    case 'digits':
      return { length: 4 + step, ...timing, exposureMs: null, rows: null, sound: false };
    case 'letters':
    case 'positions':
      return { length: 3 + step, ...timing, exposureMs: null, rows: null, sound: false };
    case 'card3x3':
      return { ...timing, ...card(L) };
  }
}

/** Block i of a segment: digits, positions, the 3×3 card, letters, then again. */
export function memoryModeForBlock(blockIndex: number): MemoryMode {
  if (!(Number.isInteger(blockIndex) && blockIndex >= 0)) {
    throw new RangeError(`memoryModeForBlock: blockIndex must be an integer ≥ 0, got ${String(blockIndex)}`);
  }
  return MODE_CYCLE[blockIndex % MODE_CYCLE.length] as MemoryMode;
}

/** «4 цифры», «7 цифр», «21 цифра». */
function digitCount(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  const word = d === 1 && dd !== 11 ? 'цифра' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'цифры' : 'цифр';
  return `${String(n)} ${word}`;
}

/** The end of every card instruction, after the lesson (Справочник F13). */
const CARD_STRATEGY = ' Стратегия: читай строки как трёхзначные числа.';

export function memoryInstruction(mode: MemoryMode, p: MemoryParams): string {
  switch (mode) {
    case 'digits':
      return 'Запомни цифры по порядку. Потом набери их и нажми Enter.';
    case 'letters':
      return (
        'Запомни буквы по порядку. Потом набери их и нажми Enter. ' +
        'Раскладку переключать не нужно: жми клавиши, на которых нарисованы эти буквы.'
      );
    case 'positions':
      return 'Клетки загораются по одной. Потом щёлкни по ним мышью в том же порядке и нажми Enter.';
    case 'card3x3':
      return (
        `На карточке ${digitCount(p.length)}. Запомни их по строкам, слева направо. Потом набери и нажми Enter.` + CARD_STRATEGY
      );
  }
}

/** The instruction's key line. The keys do not depend on the layout setting: answers are typed or clicked. */
export function memoryKeysHint(mode: MemoryMode): string {
  switch (mode) {
    case 'digits':
    case 'card3x3':
      return 'Цифры, Backspace, Enter';
    case 'letters':
      return 'Буквы, Backspace, Enter';
    case 'positions':
      return 'Мышь, Enter';
  }
}

/** The modes as the texts name them: «цифры», «буквы», «позиции», «карточка 3×3». */
export const MEMORY_MODE_NAMES: Readonly<Record<MemoryMode, string>> = Object.freeze({
  digits: 'цифры',
  letters: 'буквы',
  positions: 'позиции',
  card3x3: 'карточка 3×3',
});

/** How long a card is shown: «7 с», «5 с, со звуком» (Справочник F13); seconds with a decimal comma when not whole. */
export function cardExposureText(exposureMs: number, sound: boolean): string {
  return `${String(exposureMs / 1000).replace('.', ',')} с${sound ? ', со звуком' : ''}`;
}

/** «Режим», «Длина ряда», «Показ» (Справочник F13). */
export function describeMemoryParams(mode: MemoryMode, p: MemoryParams): Array<{ label: string; value: string }> {
  return [
    { label: 'Режим', value: MEMORY_MODE_NAMES[mode] },
    { label: 'Длина ряда', value: String(p.length) },
    { label: 'Показ', value: p.exposureMs === null ? `${ms(p.itemMs)} на элемент` : cardExposureText(p.exposureMs, p.sound) },
  ];
}
