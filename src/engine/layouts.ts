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
