import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachFocusGuard } from './focusGuard';

const detach: (() => void)[] = [];

// jsdom's document.hasFocus() is false unless an element has focus; a real visible window has it.
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  for (const off of detach.splice(0)) off();
  vi.restoreAllMocks();
});

function guard(): { lost: number } {
  const state = { lost: 0 };
  detach.push(
    attachFocusGuard(window, document, () => {
      state.lost++;
    }),
  );
  return state;
}

function stubVisibility(v: DocumentVisibilityState): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(v);
}

function setVisibility(v: DocumentVisibilityState): void {
  stubVisibility(v);
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('attachFocusGuard', () => {
  it('window blur calls onLost', () => {
    const g = guard();
    window.dispatchEvent(new FocusEvent('blur'));
    expect(g.lost).toBe(1);
  });

  it('visibilitychange to hidden calls onLost', () => {
    const g = guard();
    setVisibility('hidden');
    expect(g.lost).toBe(1);
  });

  it('visibilitychange while visible does not', () => {
    const g = guard();
    setVisibility('visible');
    expect(g.lost).toBe(0);
  });

  it('a blur of an element inside the page does not count', () => {
    const g = guard();
    const button = document.createElement('button');
    document.body.append(button);
    button.dispatchEvent(new FocusEvent('blur'));
    button.remove();
    expect(g.lost).toBe(0);
  });

  it('calls onLost at most once per attach', () => {
    const g = guard();
    window.dispatchEvent(new FocusEvent('blur'));
    setVisibility('hidden');
    window.dispatchEvent(new FocusEvent('blur'));
    expect(g.lost).toBe(1);
    const again = guard();
    window.dispatchEvent(new FocusEvent('blur'));
    expect(again.lost).toBe(1);
  });

  it('fires on attach when the page is already hidden', () => {
    stubVisibility('hidden');
    const g = guard();
    expect(g.lost).toBe(1);
    window.dispatchEvent(new FocusEvent('blur'));
    expect(g.lost).toBe(1);
  });

  it('fires on attach when the document has no focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const g = guard();
    expect(g.lost).toBe(1);
    setVisibility('hidden');
    expect(g.lost).toBe(1);
  });

  it('does not fire on attach when visible and focused', () => {
    stubVisibility('visible');
    expect(guard().lost).toBe(0);
  });

  it('unsubscribe removes the listeners', () => {
    const g = guard();
    for (const off of detach.splice(0)) off();
    window.dispatchEvent(new FocusEvent('blur'));
    setVisibility('hidden');
    expect(g.lost).toBe(0);
  });
});
