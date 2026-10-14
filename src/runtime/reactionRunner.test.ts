import { describe, expect, it } from 'vitest';
import { resolveBlock } from '../engine/reaction/resolve';
import type { BlockTimeline, Stimulus, TrialSpec } from '../engine/reaction/types';
import {
  LATE_GRACE_MS,
  MIN_FRAME_SAMPLES,
  ReactionBlockRunner,
  type RunnerEnd,
  type StimulusRenderer,
} from './reactionRunner';
import { FakeClock, FRAME } from '../testing/fakeClock';


type Call =
  | { op: 'cue'; at: number; stimulus: Stimulus }
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

/** A press trial whose cue appears `cueLeadMs` before the stimulus. */
const cuedTrial = (isiMs: number, cueLeadMs: number, windowMs = 1000): TrialSpec => ({ ...pressTrial(isiMs, windowMs), cueLeadMs });

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

function setup(
  specs: readonly TrialSpec[],
  opts: {
    nominalFrameMs?: number;
    presentationLeadMs?: number;
    /** The display's actual frame interval (FakeClock step); default FRAME. */
    frameMs?: number;
    onShow?: (at: number) => void;
  } = {},
): Harness {
  const clock = new FakeClock(opts.frameMs);
  const calls: Call[] = [];
  const renderer: StimulusRenderer = {
    cue(stimulus) {
      calls.push({ op: 'cue', at: clock.now, stimulus });
    },
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
  const runner = new ReactionBlockRunner({
    specs,
    clock,
    renderer,
    nominalFrameMs: opts.nominalFrameMs ?? FRAME,
    ...(opts.presentationLeadMs === undefined ? {} : { presentationLeadMs: opts.presentationLeadMs }),
  });
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

  it.each([
    [24, false],
    [26, true],
  ])('judges a %s ms onset frame against the block median, not nominalFrameMs', async (gap, dropped) => {
    const h = setup([pressTrial(500)], { nominalFrameMs: 30 });
    const { clock } = h;
    clock.step();
    const t0 = clock.now;
    while (clock.now + gap < t0 + 500) clock.step();
    clock.step(gap); // limit 1.5 · 16.667 ≈ 25; nominalFrameMs alone would allow 45
    const onset = clock.now;
    clock.runOut();
    const tl = await timelineOf(h);
    expect(tl.onsets).toEqual([onset]);
    expect(tl.frameMs).toBeCloseTo(FRAME, 6);
    expect(tl.droppedOnset).toEqual([dropped]);
  });
});

describe('ReactionBlockRunner: block frame interval (R37)', () => {
  it("flags dropped onsets against the block's own frame interval", async () => {
    const h = setup([pressTrial(500)], { nominalFrameMs: 16.667, frameMs: 8.333 });
    const { clock } = h;
    clock.step();
    const t0 = clock.now;
    while (clock.now + 20 < t0 + 500) clock.step();
    clock.step(20); // 20 > 1.5 · 8.333, but ≤ 1.5 · 16.667
    const onset = clock.now;
    clock.runOut();
    const tl = await timelineOf(h);
    expect(tl.onsets).toEqual([onset]);
    expect(tl.droppedOnset).toEqual([true]);
    expect(tl.frameMs).toBeCloseTo(8.333, 2);
  });

  it('a stale session interval does not flag normal frames', async () => {
    const h = setup(
      Array.from({ length: 5 }, () => pressTrial(500, 300)),
      { nominalFrameMs: 8.333, frameMs: 16.667 },
    );
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(tl.droppedOnset).toEqual([false, false, false, false, false]);
    expect(tl.frameMs).toBeCloseTo(16.667, 2);
  });

  it('falls back to nominalFrameMs with fewer than 10 frame deltas', async () => {
    const h = setup([pressTrial(0, 100)], { nominalFrameMs: 16.667, frameMs: 200 });
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(h.clock.frames.length - 1).toBeLessThan(MIN_FRAME_SAMPLES);
    expect(tl.frameMs).toBe(16.667);
    expect(tl.droppedOnset).toEqual([false]);
  });

  it.each([
    [100, true],
    [150, false],
  ])('with fewer than 10 deltas a 200 ms onset frame is judged against nominalFrameMs %s (dropped: %s)', async (nominalFrameMs, dropped) => {
    const h = setup([pressTrial(200, 100)], { nominalFrameMs, frameMs: 200 });
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(h.clock.frames.length - 1).toBeLessThan(MIN_FRAME_SAMPLES);
    expect(tl.onsets).toEqual([h.clock.frames[1]]); // the onset frame's own delta is 200 ms
    expect(tl.frameMs).toBe(nominalFrameMs);
    expect(tl.droppedOnset).toEqual([dropped]); // limit 1.5 · 100 = 150 < 200 ≤ 225 = 1.5 · 150
  });

  it.each([
    [100, 9, FRAME],
    [150, 10, 50],
  ])('a %s ms window at 50 ms frames gives %s frame deltas and frameMs %s', async (windowMs, deltas, frameMs) => {
    expect(MIN_FRAME_SAMPLES).toBe(10);
    const h = setup([pressTrial(0, windowMs)], { frameMs: 50 });
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(h.clock.frames).toHaveLength(deltas + 1); // every frame of the block counts, the closing one too
    expect(tl.frameMs).toBe(frameMs);
  });

  it("RDO lead follows the block's frames", async () => {
    const h = setup([rdoTrial(500, 1000)], { nominalFrameMs: 16.667, frameMs: 8.333 });
    h.clock.runOut();
    await timelineOf(h);
    expect(h.calls.find((c) => c.op === 'tick')?.elapsed).toBeCloseTo(8.333, 2);
  });

  it('RDO lead falls back before 10 frames and stays fixed for the trial', async () => {
    const h = setup([rdoTrial(0, 1000)], { nominalFrameMs: 16.667, frameMs: 8.333 });
    h.clock.runOut();
    const onset = (await timelineOf(h)).onsets[0] as number;
    const ticks = h.calls.filter((c) => c.op === 'tick');
    expect(ticks[0]?.elapsed).toBe(16.667);
    // More than 10 deltas arrive while the dot moves; the lead chosen at the onset is kept.
    expect(ticks.length).toBeGreaterThan(MIN_FRAME_SAMPLES);
    expect(ticks.map((c) => c.elapsed)).toEqual(ticks.map((c) => c.at - onset + 16.667));
  });

  it.each([
    [450, FRAME],
    [500, 50],
  ])('RDO lead at 50 ms frames, ISI %s ms: the onset frame delta counts toward the 10 (lead %s)', async (isiMs, lead) => {
    const h = setup([rdoTrial(isiMs, 1000)], { frameMs: 50 });
    h.clock.runOut();
    await timelineOf(h);
    expect(h.calls.find((c) => c.op === 'tick')?.elapsed).toBe(lead);
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
    const end = onset + 300;
    expect(h.at('hide')).toEqual([end]);
    const until = end + LATE_GRACE_MS;
    h.clock.stepTo(until);
    expect(h.clock.hasPending).toBe(true); // the block closes one nominal frame after the grace end
    h.clock.stepTo(until + FRAME);
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

  it('a press stamped after the frame that processes it ends the trial at its own timestamp', async () => {
    // Chromium: rAF ts is the vsync time, so input dispatched in that frame can carry a later timeStamp.
    const h = setup([pressTrial(500), pressTrial(600)]);
    while (!h.ops().includes('show')) h.clock.step();
    const onset0 = h.clock.now;
    const response = onset0 + 250;
    h.runner.press({ key: 'Space', ts: response });
    h.clock.stepTo(onset0 + 248);
    expect(h.at('hide')).toEqual([onset0 + 248]);
    h.clock.stepTo(response + 600 - 1);
    expect(h.at('show')).toEqual([onset0]);
    h.clock.stepTo(response + 600);
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(tl.onsets).toEqual([onset0, response + 600]);
    const [first] = resolveBlock([pressTrial(500), pressTrial(600)], tl);
    expect(first?.outcome).toBe('hit');
    expect(first?.rtMs).toBeCloseTo(250, 9);
  });

  it('a press during the starting phase (before the first frame) is recorded', async () => {
    const h = setup([pressTrial(500)]);
    h.runner.press({ key: 'Space', ts: -3 });
    h.clock.runOut();
    expect((await timelineOf(h)).presses).toEqual([{ key: 'Space', ts: -3 }]);
  });

  it('a press delivered while shown but stamped after the deadline ends the trial at the deadline', async () => {
    const h = setup([pressTrial(500, 300), pressTrial(400)]);
    while (!h.ops().includes('show')) h.clock.step();
    const onset0 = h.clock.now;
    const deadline = onset0 + 300;
    h.clock.stepTo(onset0 + 290);
    expect(h.ops()).toEqual(['show']);
    h.runner.press({ key: 'Space', ts: onset0 + 310 });
    h.clock.stepTo(onset0 + 320);
    expect(h.ops()).toEqual(['show', 'hide']);
    h.clock.stepTo(deadline + 400); // next onset is due from the deadline, not from the late press
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(tl.onsets).toEqual([onset0, deadline + 400]);
    expect(tl.presses).toEqual([{ key: 'Space', ts: onset0 + 310 }]);
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
  it('rdo ticks every frame while shown, one block frame ahead by default', async () => {
    const h = setup([rdoTrial(500, 200)]);
    h.clock.runOut();
    const tl = await timelineOf(h);
    const onset = tl.onsets[0] as number;
    const hideAt = h.at('hide')[0] as number;
    expect(hideAt).toBe(h.clock.firstFrameAtOrAfter(onset + 200));
    const shownFrames = h.clock.frames.filter((ts) => ts >= onset && ts < hideAt);
    const ticks = h.calls.filter((c) => c.op === 'tick');
    expect(ticks.map((c) => c.at)).toEqual(shownFrames);
    const lead = ticks[0]?.elapsed as number; // the onset frame gets the lead, not 0
    expect(lead).toBeCloseTo(FRAME, 6); // median of the measured deltas: FRAME up to float rounding
    expect(ticks.map((c) => c.elapsed)).toEqual(shownFrames.map((ts) => ts - onset + lead));
    expect(h.ops().slice(0, 2)).toEqual(['show', 'tick']);
  });

  it('default presentation lead falls back to nominalFrameMs before 10 frame deltas', async () => {
    const h = setup([rdoTrial(100, 200)], { nominalFrameMs: 20 });
    h.clock.runOut();
    const onset = (await timelineOf(h)).onsets[0] as number;
    expect(h.clock.frames.indexOf(onset)).toBeLessThan(MIN_FRAME_SAMPLES); // deltas measured up to the onset
    const ticks = h.calls.filter((c) => c.op === 'tick');
    expect(ticks[0]?.elapsed).toBe(20);
    expect(ticks.map((c) => c.elapsed)).toEqual(ticks.map((c) => c.at - onset + 20));
  });

  it.each([0, 25])('custom presentationLeadMs %s is honoured', async (lead) => {
    const h = setup([rdoTrial(500, 200)], { presentationLeadMs: lead });
    h.clock.runOut();
    const tl = await timelineOf(h);
    const onset = tl.onsets[0] as number;
    const ticks = h.calls.filter((c) => c.op === 'tick');
    expect(ticks[0]?.elapsed).toBe(lead);
    expect(ticks.map((c) => c.elapsed)).toEqual(ticks.map((c) => c.at - onset + lead));
    // the lead only moves the drawing: onsets and hide times are unchanged
    expect(onset).toBe(h.clock.firstFrameAtOrAfter((h.clock.frames[0] as number) + 500));
    expect(h.at('hide')).toEqual([h.clock.firstFrameAtOrAfter(onset + 200)]);
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

describe('ReactionBlockRunner: cue before the stimulus', () => {
  it('shows the cue cueLeadMs before onset', async () => {
    const specs = [cuedTrial(1000, 300), cuedTrial(1000, 300)];
    const ref = setup([pressTrial(1000), pressTrial(1000)]);
    ref.clock.runOut();
    const refTl = await timelineOf(ref);

    const h = setup(specs);
    h.clock.runOut();
    const tl = await timelineOf(h);
    const t0 = h.clock.frames[0] as number;
    const end0 = (tl.onsets[0] as number) + 1000;
    expect(h.ops()).toEqual(['cue', 'show', 'hide', 'cue', 'show', 'hide']);
    expect(h.at('cue')).toEqual([h.clock.firstFrameAtOrAfter(t0 + 700), h.clock.firstFrameAtOrAfter(end0 + 700)]);
    expect(h.at('show')).toEqual([h.clock.firstFrameAtOrAfter(t0 + 1000), h.clock.firstFrameAtOrAfter(end0 + 1000)]);
    expect(h.calls[0]).toEqual({ op: 'cue', at: h.at('cue')[0], stimulus: circle });
    // The onset is still the stimulus frame: the cue changes no timing.
    expect(tl.onsets).toEqual(h.at('show'));
    expect(tl.onsets).toEqual(refTl.onsets);
    expect(tl.droppedOnset).toEqual(refTl.droppedOnset);
  });

  it('a cue longer than the ISI appears in the first waiting frame', async () => {
    const h = setup([cuedTrial(200, 300, 300), cuedTrial(100, 300)]);
    h.clock.runOut();
    const tl = await timelineOf(h);
    const t0 = h.clock.frames[0] as number;
    const hide0 = h.at('hide')[0] as number;
    expect(h.ops()).toEqual(['cue', 'show', 'hide', 'cue', 'show', 'hide']);
    // Trial 0: the first frame of the block; trial 1: the frame that hides trial 0, after the hide.
    expect(h.at('cue')).toEqual([t0, hide0]);
    expect(hide0).toBe(h.clock.firstFrameAtOrAfter((tl.onsets[0] as number) + 300));
    expect(tl.onsets).toEqual([h.clock.firstFrameAtOrAfter(t0 + 200), h.clock.firstFrameAtOrAfter((tl.onsets[0] as number) + 300 + 100)]);
  });

  it('no cue without cueLeadMs', async () => {
    const h = setup([pressTrial(500), cuedTrial(500, 0)]);
    h.clock.runOut();
    await timelineOf(h);
    expect(h.ops()).toEqual(['show', 'hide', 'show', 'hide']);
  });

  it('a press during the cue is a false start', async () => {
    const specs = [cuedTrial(1000, 300), cuedTrial(1000, 300)];
    const h = setup(specs);
    const t0 = FRAME; // the first frame after start()
    h.pressAt(t0 + 800);
    h.clock.runOut();
    const tl = await timelineOf(h);
    expect(h.at('cue')[0]).toBeLessThan(t0 + 800);
    expect(tl.onsets[0]).toBeGreaterThan(t0 + 800);
    const [first] = resolveBlock(specs, tl);
    expect(first?.outcome).toBe('false_start');
  });

  it('an abort from inside renderer.cue stays aborted and shows nothing', async () => {
    const clock = new FakeClock();
    const shows: number[] = [];
    const renderer: StimulusRenderer = {
      cue() {
        runner.abort('user');
      },
      show() {
        shows.push(clock.now);
      },
      hide() {},
      tick() {},
    };
    // ISI 0: the cue and the onset are due in the same frame.
    const runner = new ReactionBlockRunner({ specs: [cuedTrial(0, 300)], clock, renderer, nominalFrameMs: FRAME });
    const done = runner.start();
    clock.step();
    expect(await done).toEqual({ kind: 'aborted', reason: 'user' });
    expect(shows).toEqual([]);
    expect(clock.hasPending).toBe(false);
  });

  it('a renderer without cue plays a cued block normally', async () => {
    const clock = new FakeClock();
    const ops: string[] = [];
    const renderer: StimulusRenderer = {
      show() {
        ops.push('show');
      },
      hide() {
        ops.push('hide');
      },
      tick() {},
    };
    const runner = new ReactionBlockRunner({ specs: [cuedTrial(500, 300)], clock, renderer, nominalFrameMs: FRAME });
    const done = runner.start();
    clock.runOut();
    expect((await done).kind).toBe('done');
    expect(ops).toEqual(['show', 'hide']);
  });
});

describe('ReactionBlockRunner: per-trial and per-frame callbacks', () => {
  it('calls onTrial when the wait for each trial begins', async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const at: Record<string, number[]> = {};
    const note = (op: string): void => {
      log.push(op);
      (at[op] ??= []).push(clock.now);
    };
    const renderer: StimulusRenderer = {
      show: () => {
        note('show');
      },
      hide: () => {
        note('hide');
      },
      tick: () => undefined,
    };
    const specs = [pressTrial(500, 300), pressTrial(400, 300), pressTrial(600, 300)];
    const runner = new ReactionBlockRunner({
      specs,
      clock,
      renderer,
      nominalFrameMs: FRAME,
      onTrial: (i) => {
        note(`trial ${String(i)}`);
      },
    });
    const done = runner.start();
    const pressTs = FRAME + 620; // trial 0 is shown about t0 + 500
    clock.input(pressTs, () => {
      runner.press({ key: 'Space', ts: pressTs });
    });
    clock.runOut();
    const end = await done;
    if (end.kind !== 'done') throw new Error('expected done');
    // t0, then the frame that ends trial 0 (answered), then the frame that ends trial 1 (window over).
    expect(log).toEqual(['trial 0', 'show', 'trial 1', 'hide', 'show', 'trial 2', 'hide', 'show', 'hide']);
    const [t0] = clock.frames;
    const [hide0, hide1] = at.hide ?? [];
    expect(at['trial 0']).toEqual([t0]);
    expect(at['trial 1']).toEqual([hide0]);
    expect(at['trial 2']).toEqual([hide1]);
    expect(hide1).toBe(clock.firstFrameAtOrAfter((end.timeline.onsets[1] as number) + 300));
  });

  it('calls renderer.frame on every frame, after that frame’s transitions', async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const frames: number[] = [];
    const renderer: StimulusRenderer = {
      show: () => log.push('show'),
      hide: () => log.push('hide'),
      tick: () => undefined,
      frame: (ts) => {
        frames.push(ts);
        log.push('frame');
      },
    };
    const runner = new ReactionBlockRunner({ specs: [pressTrial(0, 300), pressTrial(200, 300)], clock, renderer, nominalFrameMs: FRAME });
    const done = runner.start();
    clock.runOut();
    expect((await done).kind).toBe('done');
    expect(frames).toEqual(clock.frames);
    // ISI 0: the first frame shows the stimulus, then draws the frame.
    expect(log.slice(0, 2)).toEqual(['show', 'frame']);
    expect(log.filter((op) => op !== 'frame')).toEqual(['show', 'hide', 'show', 'hide']);
  });

  it('an abort from inside onTrial stays aborted', async () => {
    const clock = new FakeClock();
    const shows: number[] = [];
    const renderer: StimulusRenderer = { show: () => shows.push(clock.now), hide: () => undefined, tick: () => undefined };
    const runner = new ReactionBlockRunner({
      specs: [pressTrial(0)],
      clock,
      renderer,
      nominalFrameMs: FRAME,
      onTrial: () => {
        runner.abort('focus_lost');
      },
    });
    const done = runner.start();
    clock.step();
    expect(await done).toEqual({ kind: 'aborted', reason: 'focus_lost' });
    expect(shows).toEqual([]);
    expect(clock.hasPending).toBe(false);
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

  it('done comes in the first frame at or after end of the last trial + 300 ms + one nominal frame', async () => {
    const h = setup([pressTrial(500, 300)]);
    h.clock.runOut();
    const end = ((await timelineOf(h)).onsets[0] as number) + 300;
    expect(h.clock.frames.at(-1)).toBe(h.clock.firstFrameAtOrAfter(end + LATE_GRACE_MS + FRAME));
  });

  it('a press stamped inside the grace period but delivered after the frame at its end is captured', async () => {
    const h = setup([pressTrial(500, 300)]);
    h.clock.step();
    h.clock.step(500);
    const end = h.clock.now + 300;
    h.clock.stepTo(end); // hides
    h.clock.stepTo(end + LATE_GRACE_MS); // grace over, block still open for in-flight input
    h.runner.press({ key: 'Space', ts: end + 290 });
    h.clock.runOut();
    expect((await timelineOf(h)).presses).toEqual([{ key: 'Space', ts: end + 290 }]);
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
    expect(h.clock.frames.at(-1)).toBe(h.clock.firstFrameAtOrAfter(response + LATE_GRACE_MS + FRAME));
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

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects cueLeadMs %s', (lead) => {
    expect(() => make([pressTrial(100), cuedTrial(100, lead)])).toThrow(RangeError);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects presentationLeadMs %s', (lead) => {
    expect(
      () => new ReactionBlockRunner({ specs: [pressTrial(100)], clock, renderer, nominalFrameMs: FRAME, presentationLeadMs: lead }),
    ).toThrow(RangeError);
  });
});
