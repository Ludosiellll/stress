import type { PhaseInfo } from './phases';
import type { InputKey, LayoutId } from './types';

const KEYBOARD: readonly (readonly InputKey[])[] = [
  ['Space'],
  ['KeyF', 'KeyJ'],
  ['KeyD', 'KeyF', 'KeyJ'],
  ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
];

const PULT: readonly (readonly InputKey[])[] = [
  ['ArrowDown'],
  ['ArrowLeft', 'ArrowRight'],
  ['ArrowLeft', 'ArrowDown', 'ArrowRight'],
  ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'],
  ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'],
  ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'],
];

const MOUSE: readonly (readonly InputKey[])[] = [['MouseLeft'], ['MouseLeft', 'MouseRight']];

export function layoutKeys(
  layout: LayoutId,
  n: number,
): { keys: InputKey[]; effectiveLayout: LayoutId } {
  if (!Number.isInteger(n) || n < 1 || n > 6) {
    throw new RangeError(`layoutKeys: n must be an integer in 1..6, got ${String(n)}`);
  }
  const pick = (table: readonly (readonly InputKey[])[]): InputKey[] =>
    table.slice(n - 1, n).flat();
  if (layout === 'mouse' && n <= 2) return { keys: pick(MOUSE), effectiveLayout: 'mouse' };
  if (layout === 'pult') return { keys: pick(PULT), effectiveLayout: 'pult' };
  return { keys: pick(KEYBOARD), effectiveLayout: 'keyboard' };
}

const PULT_EQUIVALENTS: Readonly<Record<string, InputKey>> = {
  Numpad1: 'Digit1',
  Numpad2: 'ArrowDown',
  Numpad3: 'Digit3',
  Numpad4: 'ArrowLeft',
  Numpad5: 'Digit5',
  Numpad6: 'ArrowRight',
  Numpad8: 'ArrowUp',
};

export function normalizeKey(code: string, layout: LayoutId): InputKey {
  if (layout !== 'pult') return code;
  return PULT_EQUIVALENTS[code] ?? code;
}

const LABELS: Readonly<Record<string, string>> = {
  Space: 'Пробел',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  MouseLeft: 'ЛКМ',
  MouseRight: 'ПКМ',
};

export function keyLabel(key: InputKey): string {
  const fixed = LABELS[key];
  if (fixed !== undefined) return fixed;
  return key.replace(/^(?:Key([A-Z])|Digit(\d)|Numpad(\d))$/, '$1$2$3');
}

/** The layouts as the texts name them (F9). */
export const LAYOUT_NAMES: Readonly<Record<LayoutId, string>> = Object.freeze({
  keyboard: 'клавиатура',
  pult: 'пульт (стрелки и цифры)',
  mouse: 'мышь',
});

/** The other layouts of a day take turns in this order, the primary left out. */
const LAYOUT_ORDER: readonly LayoutId[] = ['keyboard', 'pult', 'mouse'];
/** The last days before the test play the primary layout only. */
const PRIMARY_DAYS_BEFORE_TEST = 3;

/**
 * The layout of a training day (F9): c = (dayNumber − 1) mod 4; c = 0 and 2 the primary, c = 1 the first of the two
 * others, c = 3 the second, so the primary has exactly half of any 28 days. The primary only with the rotation off or
 * PRIMARY_DAYS_BEFORE_TEST days or fewer before the test. Diagnostics and test-format runs never ask: they play the
 * primary.
 */
export function dayLayout(primary: LayoutId, day: Pick<PhaseInfo, 'dayNumber' | 'daysToTest'>, rotation: boolean): LayoutId {
  if (!rotation || (day.daysToTest !== null && day.daysToTest <= PRIMARY_DAYS_BEFORE_TEST)) return primary;
  const c = (day.dayNumber - 1) % 4;
  if (c === 0 || c === 2) return primary;
  const others = LAYOUT_ORDER.filter((l) => l !== primary);
  return others[c === 1 ? 0 : 1] as LayoutId;
}
