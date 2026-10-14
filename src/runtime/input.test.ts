import { afterEach, describe, expect, it } from 'vitest';
import { layoutKeys } from '../engine/layouts';
import type { LayoutId } from '../engine/types';
import type { Press } from '../engine/reaction/types';
import { attachInput } from './input';

const detach: (() => void)[] = [];

afterEach(() => {
  for (const off of detach.splice(0)) off();
});

function attach(layout: LayoutId, allowed: Iterable<string>): Press[] {
  const presses: Press[] = [];
  detach.push(attachInput(window, layout, new Set(allowed), (p) => presses.push(p)));
  return presses;
}

/** Allowed keys for `n` alternatives in a layout, as the session would pass them. */
const keysFor = (layout: LayoutId, n: number) => layoutKeys(layout, n).keys;

function keydown(code: string, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function mousedown(button: number): MouseEvent {
  const e = new MouseEvent('mousedown', { button, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

describe('attachInput: keyboard', () => {
  it('reports an allowed key with the event timestamp and prevents its default', () => {
    const presses = attach('keyboard', ['Space']);
    const e = keydown('Space');
    expect(presses).toEqual([{ key: 'Space', ts: e.timeStamp }]);
    expect(e.defaultPrevented).toBe(true);
  });

  it('ignores key repeat', () => {
    const presses = attach('keyboard', ['Space']);
    const e = keydown('Space', { repeat: true });
    expect(presses).toEqual([]);
    // an auto-repeated allowed key still must not scroll the page
    expect(e.defaultPrevented).toBe(true);
  });

  it('ignores keys outside allowed', () => {
    const presses = attach('keyboard', keysFor('keyboard', 2));
    const e = keydown('KeyA');
    keydown('Space');
    expect(presses).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('catches keys dispatched on page elements even if they stop propagation', () => {
    const presses = attach('keyboard', ['KeyF']);
    const button = document.createElement('button');
    document.body.append(button);
    button.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });
    keydown('KeyF', {}, button);
    button.remove();
    expect(presses.map((p) => p.key)).toEqual(['KeyF']);
  });

  it('keyboard layout does not remap numpad keys', () => {
    const presses = attach('keyboard', keysFor('keyboard', 6));
    keydown('Numpad4');
    keydown('KeyF');
    expect(presses.map((p) => p.key)).toEqual(['KeyF']);
  });
});

describe('attachInput: pult and numpad (ruling R9)', () => {
  it('normalizes numpad in pult', () => {
    const presses = attach('pult', keysFor('pult', 2));
    keydown('Numpad4');
    keydown('Numpad6');
    keydown('ArrowLeft');
    expect(presses.map((p) => p.key)).toEqual(['ArrowLeft', 'ArrowRight', 'ArrowLeft']);
  });

  it('Numpad5 maps to Digit5 when Digit5 is allowed (pult n=5)', () => {
    const presses = attach('pult', keysFor('pult', 5));
    keydown('Numpad5');
    expect(presses.map((p) => p.key)).toEqual(['Digit5']);
  });

  it('falls back from an arrow to the digit when only digits are allowed (pult n=5, n=6)', () => {
    const presses = attach('pult', keysFor('pult', 6));
    for (const code of ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6']) keydown(code);
    expect(presses.map((p) => p.key)).toEqual(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6']);
  });

  it('numpad keys with no allowed equivalent are ignored', () => {
    const presses = attach('pult', keysFor('pult', 2));
    const e = keydown('Numpad1'); // → Digit1, not allowed with arrows
    keydown('Numpad7');
    keydown('Numpad8'); // → ArrowUp, not allowed for n=2
    expect(presses).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('Numpad8 maps to ArrowUp in pult n=4', () => {
    const presses = attach('pult', keysFor('pult', 4));
    keydown('Numpad8');
    keydown('Numpad2');
    expect(presses.map((p) => p.key)).toEqual(['ArrowUp', 'ArrowDown']);
  });
});

describe('attachInput: mouse', () => {
  it('maps mouse buttons', () => {
    const presses = attach('mouse', keysFor('mouse', 2));
    const left = mousedown(0);
    const right = mousedown(2);
    const middle = mousedown(1);
    expect(presses).toEqual([
      { key: 'MouseLeft', ts: left.timeStamp },
      { key: 'MouseRight', ts: right.timeStamp },
    ]);
    expect(left.defaultPrevented).toBe(true);
    expect(right.defaultPrevented).toBe(true);
    expect(middle.defaultPrevented).toBe(false);
  });

  it('ignores mouse buttons outside allowed', () => {
    const presses = attach('mouse', keysFor('mouse', 1));
    const right = mousedown(2);
    mousedown(0);
    expect(presses.map((p) => p.key)).toEqual(['MouseLeft']);
    expect(right.defaultPrevented).toBe(false);
  });

  it('suppresses the context menu while attached', () => {
    detach.push(attachInput(window, 'keyboard', new Set(['Space']), () => undefined));
    const during = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
    for (const off of detach.splice(0)) off();
    const after = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});

describe('attachInput: unsubscribe', () => {
  it('removes all listeners', () => {
    const presses: Press[] = [];
    const off = attachInput(window, 'mouse', new Set(['MouseLeft', 'Space']), (p) => presses.push(p));
    off();
    const k = keydown('Space');
    const m = mousedown(0);
    expect(presses).toEqual([]);
    expect(k.defaultPrevented).toBe(false);
    expect(m.defaultPrevented).toBe(false);
  });
});
