import { normalizeKey } from '../engine/layouts';
import type { Press } from '../engine/reaction/types';
import type { InputKey, LayoutId } from '../engine/types';

const NUMPAD_DIGIT = /^Numpad([1-6])$/;

/**
 * The allowed key a `KeyboardEvent.code` stands for, or null. Ruling R9: in `pult`, Numpad2/4/6/8 normalize to
 * arrows; when only digits are allowed (5–6 alternatives), NumpadN falls back to DigitN.
 */
function keyFor(code: string, layout: LayoutId, allowed: ReadonlySet<InputKey>): InputKey | null {
  const key = normalizeKey(code, layout);
  if (allowed.has(key)) return key;
  const digit = NUMPAD_DIGIT.exec(code)?.[1];
  if (digit !== undefined && allowed.has(`Digit${digit}`)) return `Digit${digit}`;
  return null;
}

function buttonKey(button: number): InputKey | null {
  if (button === 0) return 'MouseLeft';
  if (button === 2) return 'MouseRight';
  return null;
}

/**
 * Reports presses of the allowed keys/buttons with `ts = event.timeStamp`. Key auto-repeat is not a press.
 * Listens in the capture phase so page elements can't swallow input; suppresses the context menu while attached.
 * Returns a function that removes every listener.
 */
export function attachInput(
  target: Window,
  layout: LayoutId,
  allowed: ReadonlySet<InputKey>,
  onPress: (p: Press) => void,
): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    const key = keyFor(e.code, layout, allowed);
    if (key === null) return;
    e.preventDefault(); // also for repeats: a held arrow must not scroll
    if (!e.repeat) onPress({ key, ts: e.timeStamp });
  };
  const onMouseDown = (e: MouseEvent): void => {
    const key = buttonKey(e.button);
    if (key === null || !allowed.has(key)) return;
    e.preventDefault();
    onPress({ key, ts: e.timeStamp });
  };
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  const opts = { capture: true };
  target.addEventListener('keydown', onKeyDown, opts);
  target.addEventListener('mousedown', onMouseDown, opts);
  target.addEventListener('contextmenu', onContextMenu, opts);
  return () => {
    target.removeEventListener('keydown', onKeyDown, opts);
    target.removeEventListener('mousedown', onMouseDown, opts);
    target.removeEventListener('contextmenu', onContextMenu, opts);
  };
}
