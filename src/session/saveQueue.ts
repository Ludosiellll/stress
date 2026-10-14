/** Pauses between the 3 attempts of a save: 100 ms, then 500 ms. */
export const SAVE_RETRY_DELAYS_MS: readonly number[] = [100, 500];

export interface Write {
  /** Names the write in logs, e.g. 'addBlock'. */
  label: string;
  run: () => Promise<void>;
}

export type SaveOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * Writes that must all succeed, in order. A write that succeeded is never run again: a failed attempt
 * resumes at the first write not done yet, so a stored block is not added twice.
 */
export class SaveQueue {
  private pending: Array<Write & { done: boolean }> | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(sleep: (ms: number) => Promise<void>) {
    this.sleep = sleep;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  /** Takes `writes` as the pending ones and runs them (3 attempts). */
  async save(writes: readonly Write[]): Promise<SaveOutcome> {
    if (this.pending !== null) throw new Error('SaveQueue: a save is already pending');
    this.pending = writes.map((w) => ({ ...w, done: false }));
    return this.flush();
  }

  /** Up to 3 attempts at the writes not done yet, pausing 100 and 500 ms between them. */
  async flush(): Promise<SaveOutcome> {
    const pending = this.pending;
    if (pending === null) throw new Error('SaveQueue: nothing to save');
    let error: unknown = null;
    for (let attempt = 0; attempt <= SAVE_RETRY_DELAYS_MS.length; attempt++) {
      const delay = SAVE_RETRY_DELAYS_MS[attempt - 1];
      if (delay !== undefined) await this.sleep(delay);
      try {
        for (const w of pending) {
          if (w.done) continue;
          await w.run();
          w.done = true;
        }
        this.pending = null;
        return { ok: true };
      } catch (e) {
        error = e;
      }
    }
    return { ok: false, error };
  }

  /** Forgets the pending writes; returns the labels of those that never succeeded. */
  drop(): string[] {
    const left = (this.pending ?? []).filter((w) => !w.done).map((w) => w.label);
    this.pending = null;
    return left;
  }
}
