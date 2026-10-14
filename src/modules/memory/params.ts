import { ms } from '../reaction/common';

/**
 * «Память»: rows of digits or letters shown one at a time, cells of a grid lit one at a time, or a card of
 * digits shown whole; the row is reproduced in order afterwards. Parameters per level (common.md, Память):
 * length 4 + ⌊L/3⌋, display round(max(300, 1000·0.95^L)) ms, pause round(max(100, 250·0.95^L)) ms.
 */

/** digits, letters and positions are sequential (one item at a time); card shows every digit at once. */
export type MemoryMode = 'digits' | 'letters' | 'positions' | 'card';

export interface MemoryParams {
  /** Items in a row. */
  length: number;
  /** How long each item (sequential modes) is on screen, ms; the card stays length·itemMs. */
  itemMs: number;
  /** Blank pause between items, ms. */
  gapMs: number;
}

/** Trials per block (scaledCount applies under the e2e scale). */
export const MEMORY_TRIALS = 6;

/** The 14 consonants of the letter rows. */
export const MEMORY_LETTERS: readonly string[] = ['Б', 'В', 'Г', 'Д', 'Ж', 'З', 'К', 'Л', 'М', 'Н', 'П', 'Р', 'С', 'Т'];

const MODE_CYCLE: readonly MemoryMode[] = ['digits', 'positions', 'card', 'letters'];

export function memoryParams(L: number): MemoryParams {
  if (!(Number.isFinite(L) && L >= 0)) throw new RangeError(`memoryParams: L must be a finite number ≥ 0, got ${String(L)}`);
  const decay = 0.95 ** L;
  return {
    length: 4 + Math.floor(L / 3),
    itemMs: Math.round(Math.max(300, 1000 * decay)),
    gapMs: Math.round(Math.max(100, 250 * decay)),
  };
}

/** Block i of a segment: digits, positions, card, letters, then again. */
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
    case 'card':
      return `На карточке ${digitCount(p.length)}. Запомни их по строкам, слева направо. Потом набери и нажми Enter.`;
  }
}

/** The instruction's key line. The keys do not depend on the layout setting: answers are typed or clicked. */
export function memoryKeysHint(mode: MemoryMode): string {
  switch (mode) {
    case 'digits':
    case 'card':
      return 'Цифры, Backspace, Enter';
    case 'letters':
      return 'Буквы, Backspace, Enter';
    case 'positions':
      return 'Мышь, Enter';
  }
}

export function describeMemoryParams(p: MemoryParams): Array<{ label: string; value: string }> {
  return [
    { label: 'Длина ряда', value: String(p.length) },
    { label: 'Показ элемента', value: ms(p.itemMs) },
    { label: 'Пауза', value: ms(p.gapMs) },
  ];
}
