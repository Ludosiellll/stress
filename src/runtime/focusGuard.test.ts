import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachFocusGuard } from './focusGuard';

const detach: (() => void)[] = [];

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

function setVisibility(v: DocumentVisibilityState): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(v);
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

  it('unsubscribe removes the listeners', () => {
    const g = guard();
    for (const off of detach.splice(0)) off();
    window.dispatchEvent(new FocusEvent('blur'));
    setVisibility('hidden');
    expect(g.lost).toBe(0);
  });
});
