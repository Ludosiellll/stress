import { describe, expect, it } from 'vitest';
import { resolveBlock } from '../engine/reaction/resolve';
import type { BlockTimeline, Stimulus, TrialSpec } from '../engine/reaction/types';
import type { FrameClock } from './frameClock';
import { LATE_GRACE_MS, ReactionBlockRunner, type RunnerEnd, type StimulusRenderer } from './reactionRunner';

const FRAME = 16.667;

/**
 * Frame clock driven by the test. `step(dt)` moves time by one frame and runs the pending callbacks with the new
 * timestamp. Input scheduled with `input(ts, fn)` is delivered just before the first frame with timestamp ≥ ts,
 * the way the browser dispatches input before rAF callbacks.
 */
class FakeClock implements FrameClock {
  now = 0;
  /** Simulates a callback that still fires after cancel(). */
  ignoreCancel = false;
  /** Timestamps of the frames that ran at least one callback. */
  readonly frames: number[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, (ts: number) => void>();
  private inputs: { ts: number; fn: () => void }[] = [];

  request(cb: (ts: number) => void): number {
    const id = this.nextId++;
    this.pending.set(id, cb);
    return id;
  }

  cancel(id: number): void {
    if (!this.ignoreCancel) this.pending.delete(id);
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  input(ts: number, fn: () => void): void {
    this.inputs.push({ ts, fn });
  }

  step(dt = FRAME): void {
    this.stepTo(this.now + dt);
  }

  /** One frame at exactly `ts`. */
  stepTo(ts: number): void {
    const due = this.inputs.filter((e) => e.ts <= ts).sort((a, b) => a.ts - b.ts);
    this.inputs = this.inputs.filter((e) => e.ts > ts);
    for (const e of due) e.fn();
    this.now = ts;
    const cbs = [...this.pending.values()];
    this.pending.clear();
    if (cbs.length > 0) this.frames.push(ts);
    for (const cb of cbs) cb(ts);
  }

  /** Steps until no callback is pending (the runner finished). */
  runOut(maxFrames = 100_000): void {
    for (let i = 0; i < maxFrames && this.hasPending; i++) this.step();
    if (this.hasPending) throw new Error('FakeClock.runOut: runner did not finish');
  }

  /** First frame that ran with timestamp ≥ t. */
  firstFrameAtOrAfter(t: number): number {
    const f = this.frames.find((ts) => ts >= t);
    if (f === undefined) throw new Error(`no frame at or after ${String(t)}`);
    return f;
  }
}

type Call =
  | { op: 'show'; at: number; stimulus: Stimulus }
  | { op: 'hide'; at: number }
  | { op: 'tick'; at: number; elapsed: number };

const circle: Stimulus = { kind: 'shape', shape: 'circle', color: 'red' };
const rdoStim: Stimulus = { kind: 'rdo', startDeg: 30, targetDeg: 120, periodMs: 2000 };

const pressTrial = (isiMs: number, windowMs = 1000, key = 'Space'): TrialSpec => ({
  isiMs,
  windowMs,
  stimulus: circle,
  expected: { kind: 'press', key },
});

const withholdTrial = (isiMs: number, windowMs = 1000): TrialSpec => ({
  isiMs,
  windowMs,
  stimulus: { kind: 'shape', shape: 'circle', color: 'green' },
  expected: { kind: 'withhold' },
});

const rdoTrial = (isiMs: number, windowMs: number): TrialSpec => ({
  isiMs,
  windowMs,
  stimulus: rdoStim,
  expected: { kind: 'timed', key: 'Space', targetOffsetMs: 500, toleranceMs: 30 },
});

interface Harness {
  clock: FakeClock;
  calls: Call[];
  runner: ReactionBlockRunner;
  done: Promise<RunnerEnd>;
  /** Schedules a Space press stamped `ts`, delivered before the first frame at or after `ts`. */
  pressAt(ts: number, key?: string): void;
  ops(): string[];
  at(op: Call['op']): number[];
}

function setup(specs: readonly TrialSpec[], opts: { nominalFrameMs?: number; onShow?: (at: number) => void } = {}): Harness {
  const clock = new FakeClock();
  const calls: Call[] = [];
  const renderer: StimulusRenderer = {
    show(stimulus) {
      calls.push({ op: 'show', at: clock.now, stimulus });
      opts.onShow?.(clock.now);
    },
    hide() {
      calls.push({ op: 'hide', at: clock.now });
    },
    tick(elapsed) {
      calls.push({ op: 'tick', at: clock.now, elapsed });
    },
  };
  const runner = new ReactionBlockRunner({ specs, clock, renderer, nominalFrameMs: opts.nominalFrameMs ?? FRAME });
  const done = runner.start();
  return {
    clock,
    calls,
    runner,
    done,
    pressAt(ts, key = 'Space') {
      clock.input(ts, () => {
        runner.press({ key, ts });
      });
    },
    ops: () => calls.map((c) => c.op),
    at: (op) => calls.filter((c) => c.op === op).map((c) => c.at),
  };
}

async function timelineOf(h: Harness): Promise<BlockTimeline> {
  const end = await h.done;
  if (end.kind !== 'done') throw new Error(`expected done, got ${end.kind}`);
  return end.timeline;
}

describe('ReactionBlockRunner: onsets', () => {
  it('onset recorded at frame ts', async () => {
    const h = setup([pressTrial(500)]);
    h.clock.runOut();
    const tl = await timelineOf(h);
    const t0 = h.clock.frames[0] as number;
    const onset = tl.onsets[0] as number;
    const idx = h.clock.frames.indexOf(onset);
    expect(idx).toBe(30); // ceil(500 / 16.667)
    expect(onset).toBe(h.clock.frames[30]);
    expect(onset).toBeGreaterThanOrEqual(t0 + 500);
    expect(h.clock.frames[idx - 1]).toBeLessThan(t0 + 500);
    expect(h.at('show')).toEqual([onset]);
    expect(h.calls[0]).toEqual({ op: 'show', at: onset, stimulus: circle });
  });

  it('onset can happen in the first frame (ISI 0); no previous frame means not dropped', async () => {
    const h = setup([pressTrial(0)]);
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(tl.onsets).toEqual([h.clock.frames[0]]);
    expect(tl.droppedOnset).toEqual([false]);
  });

  it('marks dropped onset frame', async () => {
    const h = setup([pressTrial(500, 300), pressTrial(500, 300)]);
    const { clock } = h;
    clock.step();
    const t0 = clock.now;
    while (clock.now + 40 < t0 + 500) clock.step();
    clock.step(40); // the onset frame comes 40 ms after the previous one
    // A 40 ms frame in the next ISI is not an onset frame and must not mark anything.
    clock.step();
    clock.step(40);
    clock.runOut();
    const tl = await timelineOf(h);
    expect(tl.onsets[0]).toBe(clock.frames[clock.frames.indexOf(tl.onsets[0] as number)]);
    expect(tl.droppedOnset).toEqual([true, false]);
  });

  it('judges dropped frames against nominalFrameMs', async () => {
    const h = setup([pressTrial(500)], { nominalFrameMs: 30 });
    const { clock } = h;
    clock.step();
    const t0 = clock.now;
    while (clock.now + 40 < t0 + 500) clock.step();
    clock.step(40); // 40 ≤ 1.5 · 30
    clock.runOut();
    expect((await timelineOf(h)).droppedOnset).toEqual([false]);
  });
});

describe('ReactionBlockRunner: trial end', () => {
  it('hides on response and schedules next by isi', async () => {
    let first = true;
    const h = setup([pressTrial(500), pressTrial(700)], {
      onShow: (at) => {
        if (first) h.pressAt(at + 250);
        first = false;
      },
    });
    h.clock.runOut();
    const tl = await timelineOf(h);
    const [onset0, onset1] = tl.onsets as [number, number];
    const response = onset0 + 250;
    expect(h.ops()).toEqual(['show', 'hide', 'show', 'hide']);
    expect(h.at('hide')[0]).toBe(h.clock.firstFrameAtOrAfter(response));
    expect(onset1).toBe(h.clock.firstFrameAtOrAfter(response + 700));
    expect(tl.presses).toEqual([{ key: 'Space', ts: response }]);
  });

  it('hides at window end when no response', async () => {
    const h = setup([pressTrial(500, 300), pressTrial(400, 300)]);
    h.clock.runOut();
    const tl = await timelineOf(h);
    const [onset0, onset1] = tl.onsets as [number, number];
    const end0 = onset0 + 300;
    expect(h.at('hide')).toEqual([h.clock.firstFrameAtOrAfter(end0), h.clock.firstFrameAtOrAfter(onset1 + 300)]);
    expect(onset1).toBe(h.clock.firstFrameAtOrAfter(end0 + 400));
  });

  it('withhold trial ends at an in-window press too', async () => {
    let first = true;
    const h = setup([withholdTrial(500), pressTrial(600)], {
      onShow: (at) => {
        if (first) h.pressAt(at + 200);
        first = false;
      },
    });
    h.clock.runOut();
    const tl = await timelineOf(h);
    const response = (tl.onsets[0] as number) + 200;
    expect(h.at('hide')[0]).toBe(h.clock.firstFrameAtOrAfter(response));
    expect(tl.onsets[1]).toBe(h.clock.firstFrameAtOrAfter(response + 600));
  });

  it('only the first in-window press ends the trial; later ones are recorded', async () => {
    const h = setup([pressTrial(500, 1000, 'KeyF'), pressTrial(600, 1000, 'KeyF')]);
    while (!h.ops().includes('show')) h.clock.step();
    const onset0 = h.clock.now;
    const first = onset0 + 200;
    const second = onset0 + 205;
    h.runner.press({ key: 'KeyJ', ts: first });
    h.runner.press({ key: 'KeyF', ts: second }); // both arrive while the stimulus is still shown
    h.clock.step();
    expect(h.ops()).toEqual(['show', 'hide']);
    h.clock.stepTo(first + 600); // due exactly now if the trial ended at the first press
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(tl.onsets).toEqual([onset0, first + 600]);
    expect(tl.presses).toEqual([
      { key: 'KeyJ', ts: first },
      { key: 'KeyF', ts: second },
    ]);
  });

  it('a press stamped before onset but delivered after it does not end the trial', async () => {
    let first = true;
    const h = setup([pressTrial(500, 300)], {
      onShow: (at) => {
        if (first) {
          h.clock.input(at + 1, () => {
            h.runner.press({ key: 'Space', ts: at - 5 });
          });
        }
        first = false;
      },
    });
    h.clock.runOut();
    const tl = await timelineOf(h);
    const onset = tl.onsets[0] as number;
    expect(h.at('hide')).toEqual([h.clock.firstFrameAtOrAfter(onset + 300)]);
    expect(tl.presses).toEqual([{ key: 'Space', ts: onset - 5 }]);
  });

  it('with ISI 0 the next stimulus appears in the frame that hides the answered one', async () => {
    let first = true;
    const h = setup([pressTrial(500), pressTrial(0)], {
      onShow: (at) => {
        if (first) h.pressAt(at + 250);
        first = false;
      },
    });
    h.clock.runOut();
    const tl = await timelineOf(h);
    const hide0 = h.at('hide')[0];
    expect(hide0).toBe(h.clock.firstFrameAtOrAfter((tl.onsets[0] as number) + 250));
    expect(tl.onsets[1]).toBe(hide0);
    expect(h.ops()).toEqual(['show', 'hide', 'show', 'hide']);
  });

  it('frames landing exactly on a due time count: onset, window end, grace end', async () => {
    const h = setup([pressTrial(500, 300)]);
    h.clock.step();
    const t0 = h.clock.now;
    h.clock.step(500);
    const onset = h.clock.now;
    expect(h.at('show')).toEqual([t0 + 500]);
    h.clock.step(300);
    expect(h.at('hide')).toEqual([onset + 300]);
    h.clock.step(LATE_GRACE_MS);
    expect(h.clock.hasPending).toBe(false);
    expect((await timelineOf(h)).onsets).toEqual([onset]);
  });

  it('a press stamped exactly at onset ends the trial', async () => {
    let first = true;
    const h = setup([pressTrial(500), pressTrial(600)], {
      onShow: (at) => {
        if (first) {
          h.clock.input(at + 1, () => {
            h.runner.press({ key: 'Space', ts: at });
          });
        }
        first = false;
      },
    });
    h.clock.runOut();
    const tl = await timelineOf(h);
    const onset0 = tl.onsets[0] as number;
    expect(h.at('hide')[0]).toBe(h.clock.frames[h.clock.frames.indexOf(onset0) + 1]);
    expect(tl.onsets[1]).toBe(h.clock.firstFrameAtOrAfter(onset0 + 600));
  });

  it('press during ISI does not end anything (recorded only)', async () => {
    const specs = [pressTrial(500, 300), pressTrial(800, 300)];
    const ref = setup(specs);
    ref.clock.runOut();
    const refTl = await timelineOf(ref);

    const h = setup(specs);
    h.pressAt(200); // before the first onset (t0 = 16.667)
    const isiPress = (refTl.onsets[0] as number) + 300 + 400; // between trial 0 end and trial 1 onset
    h.pressAt(isiPress);
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(tl.onsets).toEqual(refTl.onsets);
    expect(h.calls).toEqual(ref.calls);
    expect(tl.presses).toEqual([
      { key: 'Space', ts: 200 },
      { key: 'Space', ts: isiPress },
    ]);
  });

  it('press after window end is recorded but does not hide anything', async () => {
    const specs = [pressTrial(500, 300), pressTrial(800, 300)];
    const ref = setup(specs);
    ref.clock.runOut();
    const refTl = await timelineOf(ref);

    const h = setup(specs);
    const late = (refTl.onsets[0] as number) + 300 + 100;
    h.pressAt(late);
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(h.calls).toEqual(ref.calls);
    expect(tl.onsets[1]).toBe(h.clock.firstFrameAtOrAfter((tl.onsets[0] as number) + 300 + 800));
    expect(tl.presses).toEqual([{ key: 'Space', ts: late }]);
  });
});

describe('ReactionBlockRunner: rdo', () => {
  it('rdo ticks every frame while shown', async () => {
    const h = setup([rdoTrial(500, 200)]);
    h.clock.runOut();
    const tl = await timelineOf(h);
    const onset = tl.onsets[0] as number;
    const hideAt = h.at('hide')[0] as number;
    expect(hideAt).toBe(h.clock.firstFrameAtOrAfter(onset + 200));
    const shownFrames = h.clock.frames.filter((ts) => ts >= onset && ts < hideAt);
    const ticks = h.calls.filter((c) => c.op === 'tick');
    expect(ticks.map((c) => c.at)).toEqual(shownFrames);
    expect(ticks.map((c) => c.elapsed)).toEqual(shownFrames.map((ts) => ts - onset));
    expect(ticks[0]?.elapsed).toBe(0);
    expect(h.ops().slice(0, 2)).toEqual(['show', 'tick']);
  });

  it('shape stimuli get no ticks', async () => {
    const h = setup([pressTrial(500, 200)]);
    h.clock.runOut();
    await h.done;
    expect(h.ops()).toEqual(['show', 'hide']);
  });

  it('rdo stops ticking after an in-window press', async () => {
    let first = true;
    const h = setup([rdoTrial(500, 1500)], {
      onShow: (at) => {
        if (first) h.pressAt(at + 500);
        first = false;
      },
    });
    h.clock.runOut();
    const tl = await timelineOf(h);
    const hideAt = h.at('hide')[0] as number;
    expect(hideAt).toBe(h.clock.firstFrameAtOrAfter((tl.onsets[0] as number) + 500));
    expect(Math.max(...h.at('tick'))).toBeLessThan(hideAt);
  });
});

describe('ReactionBlockRunner: end of block', () => {
  it('late presses within 300 ms after the last trial are captured, later ones are not', async () => {
    expect(LATE_GRACE_MS).toBe(300);
    const h = setup([pressTrial(500, 300)]);
    while (!h.ops().includes('hide')) h.clock.step();
    const end = (h.at('show')[0] as number) + 300;
    h.pressAt(end + 100);
    h.pressAt(end + 300);
    h.pressAt(end + 350); // delivered before the closing frame, but stamped after the grace period
    h.clock.step(400); // one long frame: all three presses arrive before it
    expect(h.clock.hasPending).toBe(false);
    const tl = await timelineOf(h);
    expect(tl.presses.map((p) => p.ts)).toEqual([end + 100, end + 300]);
    h.runner.press({ key: 'Space', ts: end + 120 }); // after done: ignored
    expect(tl.presses).toHaveLength(2);
  });

  it('done comes in the first frame at or after end of the last trial + 300 ms', async () => {
    const h = setup([pressTrial(500, 300)]);
    h.clock.runOut();
    const end = ((await timelineOf(h)).onsets[0] as number) + 300;
    expect(h.clock.frames.at(-1)).toBe(h.clock.firstFrameAtOrAfter(end + LATE_GRACE_MS));
  });

  it('grace period after an answered last trial starts at the response', async () => {
    let first = true;
    const h = setup([pressTrial(500)], {
      onShow: (at) => {
        if (first) h.pressAt(at + 250);
        first = false;
      },
    });
    h.clock.runOut();
    const tl = await timelineOf(h);
    const response = (tl.onsets[0] as number) + 250;
    expect(h.clock.frames.at(-1)).toBe(h.clock.firstFrameAtOrAfter(response + LATE_GRACE_MS));
  });

  it('end-to-end with resolveBlock', async () => {
    const specs = [pressTrial(600), pressTrial(900), pressTrial(1300)];
    const h = setup(specs, {
      onShow: (at) => {
        h.pressAt(at + 250);
      },
    });
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(tl.onsets).toHaveLength(3);
    const results = resolveBlock(specs, tl);
    for (const r of results) {
      expect(r.outcome).toBe('hit');
      // exact up to float rounding of (onset + 250) − onset
      expect(r.rtMs).toBeCloseTo(250, 9);
      expect(r.frameDropped).toBe(false);
    }
  });

  it('presses before start() are ignored', async () => {
    const clock = new FakeClock();
    const renderer: StimulusRenderer = { show() {}, hide() {}, tick() {} };
    const runner = new ReactionBlockRunner({ specs: [pressTrial(100)], clock, renderer, nominalFrameMs: FRAME });
    runner.press({ key: 'Space', ts: 1 });
    const done = runner.start();
    clock.runOut();
    const end = await done;
    expect(end.kind === 'done' && end.timeline.presses).toEqual([]);
  });
});

describe('ReactionBlockRunner: abort and lifecycle', () => {
  it('aborts on visibility/blur', async () => {
    const h = setup([pressTrial(500), pressTrial(500)]);
    h.clock.step();
    h.clock.step();
    h.runner.abort('focus_lost');
    expect(await h.done).toEqual({ kind: 'aborted', reason: 'focus_lost' });
    expect(h.ops()).toEqual(['hide']);
    expect(h.clock.hasPending).toBe(false);
  });

  it('abort while a stimulus is shown hides it and stops the loop', async () => {
    const h = setup([pressTrial(0, 1000)]);
    h.clock.step();
    h.clock.step();
    h.runner.abort('user');
    h.runner.abort('focus_lost'); // idempotent
    for (let i = 0; i < 100; i++) h.clock.step();
    expect(await h.done).toEqual({ kind: 'aborted', reason: 'user' });
    expect(h.ops()).toEqual(['show', 'hide']);
  });

  it('a frame that still fires after abort does nothing', async () => {
    const h = setup([pressTrial(0, 1000)]);
    h.clock.ignoreCancel = true;
    h.clock.step();
    h.runner.abort('user');
    h.clock.step();
    expect(await h.done).toEqual({ kind: 'aborted', reason: 'user' });
    expect(h.ops()).toEqual(['show', 'hide']);
    expect(h.clock.hasPending).toBe(false);
  });

  it('abort after done changes nothing', async () => {
    const h = setup([pressTrial(100, 100)]);
    h.clock.runOut();
    const end = await h.done;
    const before = h.calls.length;
    h.runner.abort('user');
    expect(end.kind).toBe('done');
    expect(h.calls).toHaveLength(before);
  });

  it('abort before start makes start() resolve aborted without requesting frames', async () => {
    const clock = new FakeClock();
    const hides: number[] = [];
    const renderer: StimulusRenderer = {
      show() {},
      hide() {
        hides.push(clock.now);
      },
      tick() {},
    };
    const runner = new ReactionBlockRunner({ specs: [pressTrial(100)], clock, renderer, nominalFrameMs: FRAME });
    runner.abort('focus_lost');
    expect(await runner.start()).toEqual({ kind: 'aborted', reason: 'focus_lost' });
    expect(clock.hasPending).toBe(false);
    expect(hides).toHaveLength(1);
  });

  it('an abort from inside renderer.show stays aborted', async () => {
    const clock = new FakeClock();
    let hides = 0;
    const renderer: StimulusRenderer = {
      show() {
        runner.abort('user');
      },
      hide() {
        hides++;
      },
      tick() {},
    };
    const runner = new ReactionBlockRunner({ specs: [pressTrial(0)], clock, renderer, nominalFrameMs: FRAME });
    const done = runner.start();
    clock.step();
    runner.abort('focus_lost'); // must be a no-op: the runner already finished
    expect(await done).toEqual({ kind: 'aborted', reason: 'user' });
    expect(hides).toBe(1);
    expect(clock.hasPending).toBe(false);
  });

  it('calling start() twice throws', () => {
    const h = setup([pressTrial(100)]);
    expect(() => h.runner.start()).toThrow(Error);
  });

  it('a renderer failure rejects start() and stops the loop', async () => {
    const clock = new FakeClock();
    const renderer: StimulusRenderer = {
      show() {
        throw new Error('canvas lost');
      },
      hide() {},
      tick() {},
    };
    const runner = new ReactionBlockRunner({ specs: [pressTrial(0)], clock, renderer, nominalFrameMs: FRAME });
    const done = runner.start();
    clock.step();
    await expect(done).rejects.toThrow('canvas lost');
    expect(clock.hasPending).toBe(false);
    runner.abort('user'); // no-op after failure
  });

  it('a non-Error throw is wrapped into an Error', async () => {
    const clock = new FakeClock();
    const renderer: StimulusRenderer = {
      show() {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
        throw 'boom';
      },
      hide() {},
      tick() {},
    };
    const runner = new ReactionBlockRunner({ specs: [pressTrial(0)], clock, renderer, nominalFrameMs: FRAME });
    const done = runner.start();
    clock.step();
    await expect(done).rejects.toThrow('boom');
  });
});

describe('ReactionBlockRunner: validation', () => {
  const clock = new FakeClock();
  const renderer: StimulusRenderer = { show() {}, hide() {}, tick() {} };
  const make = (specs: readonly TrialSpec[], nominalFrameMs = FRAME) =>
    new ReactionBlockRunner({ specs, clock, renderer, nominalFrameMs });

  it('rejects an empty block', () => {
    expect(() => make([])).toThrow(RangeError);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects nominalFrameMs %s', (n) => {
    expect(() => make([pressTrial(100)], n)).toThrow(RangeError);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects isiMs %s', (isi) => {
    expect(() => make([pressTrial(100), pressTrial(isi)])).toThrow(RangeError);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('rejects windowMs %s', (w) => {
    expect(() => make([pressTrial(100, w)])).toThrow(RangeError);
  });
});
