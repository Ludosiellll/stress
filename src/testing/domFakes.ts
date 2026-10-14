import { act } from '@testing-library/react';
import { vi } from 'vitest';

/** DOM doubles for UI tests (jsdom has no canvas and no real frames). */

type Ctx = Record<string | symbol, unknown>;

/**
 * Makes `canvas.getContext('2d')` return a context whose methods do nothing and whose properties can be set.
 * `overrides` replace single methods (e.g. one that throws). Returns the calls made, by method name.
 */
export function mockCanvas(overrides: Record<string, (...args: unknown[]) => unknown> = {}): { calls: string[] } {
  const calls: string[] = [];
  const values: Ctx = {};
  const ctx = new Proxy(values, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      return (...args: unknown[]) => {
        calls.push(prop);
        return overrides[prop]?.(...args);
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
  return { calls };
}

export interface ManualFrames {
  /** Runs every callback requested so far with this frame timestamp. */
  run(ts: number): void;
  /** Callbacks waiting for the next frame. */
  pending(): number;
}

/** Replaces requestAnimationFrame with frames the test runs by hand (undo with vi.unstubAllGlobals). */
export function manualFrames(): ManualFrames {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    callbacks.delete(id);
  });
  return {
    run(ts) {
      const due = [...callbacks.values()];
      callbacks.clear();
      act(() => {
        for (const cb of due) cb(ts);
      });
    },
    pending: () => callbacks.size,
  };
}

/** jsdom stamps events with Date.now(); tests that compare with frame times set the stamp themselves. */
export function stamped<E extends Event>(event: E, timeStamp: number): E {
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  return event;
}

/** Lets pending timers and promises run (listeners attached "after the current key event" become active). */
export async function nextTask(): Promise<void> {
  await act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );
}

/** `count` frame timestamps `step` ms apart, from 1000; every `hiccupEvery`-th interval is 3× longer. */
export function frameStamps(count: number, step: number, hiccupEvery = 0): number[] {
  const out: number[] = [];
  let t = 1000;
  for (let i = 0; i < count; i++) {
    out.push(t);
    t += hiccupEvery > 0 && i % hiccupEvery === hiccupEvery - 1 ? step * 3 : step;
  }
  return out;
}
