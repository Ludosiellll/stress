import { describe, expect, it } from 'vitest';
import type { MemoryTrial } from '../modules/memory/generate';
import { FakeClock } from '../testing/fakeClock';
import { FIXATION_MS, presentMemoryTrial } from './memoryPresenter';
import type { MemoryRenderer } from './memoryRenderer';

type Call = { op: 'fixation' | 'card' | 'clear'; at: number } | { op: 'item'; at: number; k: number };

/** A renderer that records what was drawn and on which frame. */
function recorder(clock: FakeClock, o: { throwOn?: Call['op'] } = {}): { r: MemoryRenderer; calls: Call[] } {
  const calls: Call[] = [];
  const note = (op: Call['op']): void => {
    if (o.throwOn === op) throw new Error(`${op} failed`);
    calls.push({ op, at: clock.now } as Call);
  };
  return {
    calls,
    r: {
      fixation: () => {
        note('fixation');
      },
      item: (_t, k) => {
        if (o.throwOn === 'item') throw new Error('item failed');
        calls.push({ op: 'item', at: clock.now, k });
      },
      card: () => {
        note('card');
      },
      clear: () => {
        note('clear');
      },
    },
  };
}

const DIGITS: MemoryTrial = { mode: 'digits', items: ['4', '7', '1'], gridSide: 0, itemMs: 630, gapMs: 158, cardMs: 1890 };
const CARD: MemoryTrial = { ...DIGITS, mode: 'card', items: ['4', '7', '1', '9'], gridSide: 3, cardMs: 2520 };

/** Runs the presentation to its end on `clock`. */
async function play(t: MemoryTrial, clock: FakeClock, r: MemoryRenderer, signal = new AbortController().signal) {
  const end = presentMemoryTrial(t, clock, r, signal);
  clock.runOut();
  return end;
}

describe('presentMemoryTrial', () => {
  it('fixation from the first frame t0, item k at the first frame ≥ t0 + 500 + k·(itemMs + gapMs), hidden itemMs later', async () => {
    const clock = new FakeClock();
    const { r, calls } = recorder(clock);
    await expect(play(DIGITS, clock, r)).resolves.toBe('done');
    const t0 = clock.frames[0] ?? Number.NaN;
    expect(calls[0]).toEqual({ op: 'fixation', at: t0 });
    expect(FIXATION_MS).toBe(500);
    const expected: Call[] = [{ op: 'fixation', at: t0 }];
    DIGITS.items.forEach((_x, k) => {
      const onset = clock.firstFrameAtOrAfter(t0 + 500 + k * (DIGITS.itemMs + DIGITS.gapMs));
      expected.push({ op: 'item', at: onset, k }, { op: 'clear', at: clock.firstFrameAtOrAfter(onset + DIGITS.itemMs) });
    });
    expect(calls).toEqual(expected);
    // Done at the frame that hid the last item.
    expect(clock.hasPending).toBe(false);
    expect(clock.frames.at(-1)).toBe(calls.at(-1)?.at);
  });

  it('slow, irregular frames: onsets keep to the schedule from t0, not from the previous item', async () => {
    const clock = new FakeClock(41);
    const { r, calls } = recorder(clock);
    await play(DIGITS, clock, r);
    const t0 = clock.frames[0] ?? Number.NaN;
    const onsets = calls.filter((c) => c.op === 'item').map((c) => c.at);
    expect(onsets).toEqual([0, 1, 2].map((k) => clock.firstFrameAtOrAfter(t0 + 500 + k * 788)));
  });

  it('the card appears at t0 + 500 and stays cardMs', async () => {
    const clock = new FakeClock();
    const { r, calls } = recorder(clock);
    await expect(play(CARD, clock, r)).resolves.toBe('done');
    const t0 = clock.frames[0] ?? Number.NaN;
    const shown = clock.firstFrameAtOrAfter(t0 + 500);
    expect(calls).toEqual([
      { op: 'fixation', at: t0 },
      { op: 'card', at: shown },
      { op: 'clear', at: clock.firstFrameAtOrAfter(shown + CARD.cardMs) },
    ]);
  });

  it('an abort mid-presentation clears the screen and resolves aborted; nothing is drawn after it', async () => {
    const clock = new FakeClock();
    const { r, calls } = recorder(clock);
    const ac = new AbortController();
    const end = presentMemoryTrial(DIGITS, clock, r, ac.signal);
    for (let i = 0; i < 40; i++) clock.step();
    expect(calls.some((c) => c.op === 'item')).toBe(true);
    ac.abort();
    await expect(end).resolves.toBe('aborted');
    expect(calls.at(-1)).toEqual({ op: 'clear', at: clock.now });
    expect(clock.hasPending).toBe(false);
    const n = calls.length;
    for (let i = 0; i < 300; i++) clock.step();
    expect(calls).toHaveLength(n);
  });

  it('a signal aborted before the start: aborted at once, no frame requested', async () => {
    const clock = new FakeClock();
    const { r, calls } = recorder(clock);
    const ac = new AbortController();
    ac.abort();
    await expect(presentMemoryTrial(DIGITS, clock, r, ac.signal)).resolves.toBe('aborted');
    expect(clock.hasPending).toBe(false);
    expect(calls.map((c) => c.op)).toEqual(['clear']);
  });

  it('an abort after the end changes nothing', async () => {
    const clock = new FakeClock();
    const { r, calls } = recorder(clock);
    const ac = new AbortController();
    await expect(play(DIGITS, clock, r, ac.signal)).resolves.toBe('done');
    const n = calls.length;
    ac.abort();
    expect(calls).toHaveLength(n);
  });

  it('an empty row throws RangeError and requests no frame (B3)', () => {
    for (const t of [{ ...DIGITS, items: [] }, { ...CARD, items: [] }]) {
      const clock = new FakeClock();
      const { r, calls } = recorder(clock);
      expect(() => presentMemoryTrial(t, clock, r, new AbortController().signal)).toThrow(RangeError);
      expect(clock.hasPending).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it('a drawing failure rejects with the error and stops the frames', async () => {
    const clock = new FakeClock();
    const { r } = recorder(clock, { throwOn: 'item' });
    const end = presentMemoryTrial(DIGITS, clock, r, new AbortController().signal);
    for (let i = 0; i < 60 && clock.hasPending; i++) clock.step();
    await expect(end).rejects.toThrow('item failed');
    expect(clock.hasPending).toBe(false);
  });
});
