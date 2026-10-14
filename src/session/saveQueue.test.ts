import { describe, expect, it } from 'vitest';
import { SaveQueue, type Write } from './saveQueue';

function harness(): { queue: SaveQueue; sleeps: number[]; log: string[]; write: (label: string, failures?: number) => Write } {
  const sleeps: number[] = [];
  const log: string[] = [];
  const queue = new SaveQueue((ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  });
  const write = (label: string, failures = 0): Write => {
    let left = failures;
    return {
      label,
      run: () => {
        log.push(label);
        if (left > 0) {
          left--;
          return Promise.reject(new Error(`${label} failed`));
        }
        return Promise.resolve();
      },
    };
  };
  return { queue, sleeps, log, write };
}

describe('SaveQueue', () => {
  it('runs every write once when nothing fails', async () => {
    const h = harness();
    expect(await h.queue.save([h.write('a'), h.write('b')])).toEqual({ ok: true });
    expect(h.log).toEqual(['a', 'b']);
    expect(h.sleeps).toEqual([]);
    expect(h.queue.hasPending).toBe(false);
  });

  it('3 attempts with 100 and 500 ms pauses, resuming at the first write not done', async () => {
    const h = harness();
    const outcome = await h.queue.save([h.write('a'), h.write('b', 5)]);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : String(outcome.error)).toContain('b failed');
    expect(h.log).toEqual(['a', 'b', 'b', 'b']);
    expect(h.sleeps).toEqual([100, 500]);
    expect(h.queue.hasPending).toBe(true);

    expect((await h.queue.flush()).ok).toBe(true); // failures 4 and 5, then success
    expect(h.sleeps).toEqual([100, 500, 100, 500]); // the 3rd attempt of this round succeeds
    expect(h.queue.hasPending).toBe(false);
    expect(h.log).toEqual(['a', 'b', 'b', 'b', 'b', 'b', 'b']);
  });

  it('drop forgets the pending writes and names those that never succeeded', async () => {
    const h = harness();
    await h.queue.save([h.write('a'), h.write('b', 3), h.write('c')]);
    expect(h.queue.drop()).toEqual(['b', 'c']);
    expect(h.queue.hasPending).toBe(false);
    expect(h.queue.drop()).toEqual([]);
    await expect(h.queue.flush()).rejects.toThrow(/nothing to save/);
  });

  it('a second save while one is pending is a programming error', async () => {
    const h = harness();
    await h.queue.save([h.write('a', 3)]);
    await expect(h.queue.save([h.write('b')])).rejects.toThrow(/already pending/);
  });
});
