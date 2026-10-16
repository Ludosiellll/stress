import { describe, expect, it } from 'vitest';
import { NOISE_EXCLUSION_RADIUS, noiseFrame, type VisualNoiseParams } from '../engine/noise';
import type { ColorId, ShapeId, Stimulus } from '../engine/reaction/types';
import { stressorsOf } from '../modules/reaction/common';
import { STROOP_COLORS, stroop } from '../modules/reaction/stroop';
import { pomeh } from '../modules/reaction/pomeh';
import { FakeClock, FRAME } from '../testing/fakeClock';
import { BACKGROUND, COLORS, FLICKER_BACKGROUND, MARK_COLOR, createCanvasRenderer, polarPoint, rdoAngleAt } from './canvasRenderer';
import { GRID_LINE, LIT_CELL } from './memoryRenderer';
import { ReactionBlockRunner } from './reactionRunner';

interface Call {
  name: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: unknown;
}

/** A stand-in for CanvasRenderingContext2D: records every method call with the style in effect at that moment. */
function mockContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        const name = String(prop);
        if (name in state) return state[name];
        return (...args: unknown[]) => {
          calls.push({ name, args, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, lineWidth: state.lineWidth });
        };
      },
      set: (_t, prop, value) => {
        state[String(prop)] = value;
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
  return { ctx, calls };
}

interface FakeCanvas {
  clientWidth: number;
  clientHeight: number;
  width: number;
  height: number;
}

function setup(opts: { w?: number; h?: number; dpr?: number | null; noise?: { params: VisualNoiseParams; seed: number } } = {}) {
  const { ctx, calls } = mockContext();
  const dpr = opts.dpr === undefined ? 2 : opts.dpr;
  const fake: FakeCanvas & { getContext(kind: string): unknown; ownerDocument: unknown } = {
    clientWidth: opts.w ?? 800,
    clientHeight: opts.h ?? 600,
    width: 300,
    height: 150,
    getContext: (kind: string) => (kind === '2d' ? ctx : null),
    ownerDocument: { defaultView: dpr === null ? null : { devicePixelRatio: dpr } },
  };
  const canvas = fake as unknown as HTMLCanvasElement;
  const renderer = opts.noise === undefined ? createCanvasRenderer(canvas) : createCanvasRenderer(canvas, { noise: opts.noise });
  return { renderer, calls, canvas: fake };
}

const named = (calls: Call[], name: string) => calls.filter((c) => c.name === name);

describe('rdoAngleAt', () => {
  it('starts at startDeg', () => {
    expect(rdoAngleAt(10, 1000, 0)).toBe(10);
  });

  it('moves 360° per period, clockwise', () => {
    expect(rdoAngleAt(0, 2000, 500)).toBe(90);
    expect(rdoAngleAt(45, 3000, 1500)).toBe(225);
  });

  it('wraps into [0, 360)', () => {
    expect(rdoAngleAt(300, 1000, 250)).toBe(30);
    expect(rdoAngleAt(350, 1000, 1000)).toBe(350);
    expect(rdoAngleAt(0, 1000, 1000)).toBe(0);
    expect(rdoAngleAt(-90, 1000, 0)).toBe(270);
  });
});

describe('polarPoint (0° = top, clockwise)', () => {
  it.each([
    [0, 0, -10],
    [90, 10, 0],
    [180, 0, 10],
    [270, -10, 0],
  ])('%s° → (%s, %s) around the origin', (deg, x, y) => {
    const p = polarPoint(0, 0, 10, deg);
    expect(p.x).toBeCloseTo(x, 9);
    expect(p.y).toBeCloseTo(y, 9);
  });

  it('offsets by the centre', () => {
    const p = polarPoint(100, 50, 20, 90);
    expect(p.x).toBeCloseTo(120, 9);
    expect(p.y).toBeCloseTo(50, 9);
  });
});

describe('createCanvasRenderer', () => {
  it('throws without a 2d context', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => createCanvasRenderer(canvas)).toThrow(Error);
  });

  it('sizes the backing store to client size × devicePixelRatio and draws in CSS pixels', () => {
    const { calls, canvas } = setup({ w: 800, h: 600, dpr: 2 });
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(named(calls, 'setTransform')[0]?.args).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('uses devicePixelRatio 1 without a window', () => {
    const { calls, canvas } = setup({ w: 640, h: 480, dpr: null });
    expect([canvas.width, canvas.height]).toEqual([640, 480]);
    expect(named(calls, 'setTransform')[0]?.args).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('follows client size changes on the next draw', () => {
    const { renderer, canvas } = setup({ w: 800, h: 600, dpr: 1.5 });
    canvas.clientWidth = 1000;
    renderer.hide();
    expect([canvas.width, canvas.height]).toEqual([1500, 900]);
  });

  it('clears to the background on creation and on hide', () => {
    const { renderer, calls } = setup();
    expect(named(calls, 'fillRect')).toEqual([
      { name: 'fillRect', args: [0, 0, 800, 600], fillStyle: BACKGROUND, strokeStyle: undefined, lineWidth: undefined },
    ]);
    renderer.show({ kind: 'shape', shape: 'circle', color: 'red' });
    calls.length = 0;
    renderer.hide();
    expect(calls.map((c) => c.name)).toEqual(['setTransform', 'fillRect']);
    expect(named(calls, 'fillRect')[0]?.fillStyle).toBe(BACKGROUND);
  });

  it('draws a centred circle with diameter 18% of the shorter side', () => {
    const { renderer, calls } = setup({ w: 800, h: 600 });
    calls.length = 0;
    renderer.show({ kind: 'shape', shape: 'circle', color: 'red' });
    expect(named(calls, 'arc')[0]?.args).toEqual([400, 300, 54, 0, 2 * Math.PI]);
    const fill = named(calls, 'fill');
    expect(fill).toHaveLength(1);
    expect(fill[0]?.fillStyle).toBe(COLORS.red);
  });

  it('a marked circle carries a white dot of 20 % of its diameter', () => {
    const { renderer, calls } = setup({ w: 800, h: 600 });
    calls.length = 0;
    renderer.show({ kind: 'shape', shape: 'circle', color: 'red', mark: true });
    expect(named(calls, 'arc').map((c) => c.args)).toEqual([
      [400, 300, 54, 0, 2 * Math.PI],
      [400, 300, 0.2 * 54, 0, 2 * Math.PI],
    ]);
    expect(named(calls, 'fill').map((c) => c.fillStyle)).toEqual([COLORS.red, COLORS.white]);
    // Swapped colours: the same dot on the green circle.
    calls.length = 0;
    renderer.show({ kind: 'shape', shape: 'circle', color: 'green', mark: true });
    expect(named(calls, 'fill').map((c) => c.fillStyle)).toEqual([COLORS.green, COLORS.white]);
  });

  const shapes: ShapeId[] = ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'star'];
  const colors: ColorId[] = ['red', 'green', 'yellow', 'blue', 'white', 'purple'];

  it.each(shapes)('draws %s in every colour, with and without a frame', (shape) => {
    const { renderer, calls } = setup();
    for (const color of colors) {
      calls.length = 0;
      renderer.show({ kind: 'shape', shape, color });
      expect(named(calls, 'fill').map((c) => c.fillStyle)).toEqual([COLORS[color]]);
      expect(named(calls, 'stroke')).toEqual([]);
      calls.length = 0;
      renderer.show({ kind: 'shape', shape, color, frame: 'white' });
      const ring = named(calls, 'stroke');
      expect(ring).toHaveLength(1);
      expect(ring[0]?.strokeStyle).toBe(COLORS.white);
      expect(ring[0]?.lineWidth).toBe(12);
    }
  });

  it('frame ring clears the stimulus', () => {
    const { renderer, calls } = setup({ w: 800, h: 600 });
    calls.length = 0;
    renderer.show({ kind: 'shape', shape: 'square', color: 'blue', frame: 'yellow' });
    const arcs = named(calls, 'arc');
    const ringRadius = arcs.at(-1)?.args[2] as number;
    // square half-side 54 → corner at 54·√2 ≈ 76.4; the ring's inner edge (radius − 6) lies outside it
    expect(ringRadius - 6).toBeGreaterThan(54 * Math.SQRT2);
  });

  it('draws a colour word in its ink', () => {
    const { renderer, calls } = setup({ w: 800, h: 600 });
    calls.length = 0;
    renderer.show({ kind: 'word', word: 'green', ink: 'red' });
    const text = named(calls, 'fillText');
    expect(text).toHaveLength(1);
    expect(text[0]?.args).toEqual(['ЗЕЛЁНЫЙ', 400, 300]);
    expect(text[0]?.fillStyle).toBe(COLORS.red);
    expect(named(calls, 'fill')).toEqual([]);
  });

  it('a framed word (the reverse Stroop rule) gets a white ring around it', () => {
    const { renderer, calls } = setup({ w: 800, h: 600 });
    calls.length = 0;
    renderer.show({ kind: 'word', word: 'green', ink: 'red', frame: 'white' });
    expect(named(calls, 'fillText').map((c) => [c.args, c.fillStyle])).toEqual([[['ЗЕЛЁНЫЙ', 400, 300], COLORS.red]]);
    const ring = named(calls, 'stroke');
    expect(ring).toHaveLength(1);
    expect([ring[0]?.strokeStyle, ring[0]?.lineWidth]).toEqual([COLORS.white, 12]);
    const [cx, cy, r] = named(calls, 'arc').at(-1)?.args as [number, number, number];
    expect([cx, cy]).toEqual([400, 300]);
    // The inner edge clears the longest word: «ЗЕЛЁНЫЙ» at 72 px is under 0.6 of the shorter side wide.
    expect(r - 6).toBeGreaterThan(Math.hypot(0.3 * 600, 36));
    // An unframed word has no ring.
    calls.length = 0;
    renderer.show({ kind: 'word', word: 'green', ink: 'red' });
    expect(named(calls, 'stroke')).toEqual([]);
  });

  it('a mark (F15, Р23): bold, 6 % of the shorter side, #bdbdbd, centred at five sixths of the height, over the stimulus', () => {
    const { ctx, calls } = mockContext();
    const canvas = {
      clientWidth: 1000,
      clientHeight: 500,
      width: 0,
      height: 0,
      getContext: () => ctx,
      ownerDocument: { defaultView: { devicePixelRatio: 1 } },
    } as unknown as HTMLCanvasElement;
    const renderer = createCanvasRenderer(canvas);
    renderer.show({ kind: 'shape', shape: 'circle', color: 'red' });
    calls.length = 0;
    renderer.mark('рано');
    // The lower third (F9, Task 17 note under Р23): the jittered task-switching cue reaches up into the upper one.
    expect(named(calls, 'fillText').map((c) => [c.args, c.fillStyle])).toEqual([[['рано', 500, (5 * 500) / 6], MARK_COLOR]]);
    expect(ctx.font).toBe("bold 30px 'Segoe UI', Arial, sans-serif");
    expect([ctx.textAlign, ctx.textBaseline]).toEqual(['center', 'middle']);
    // Drawn after the stimulus, in the same draw.
    const names = calls.map((c) => c.name);
    expect(names.lastIndexOf('fill')).toBeLessThan(names.indexOf('fillText'));
    // The stimulus going away keeps the mark; another mark replaces it; clearMark takes it away.
    calls.length = 0;
    renderer.hide();
    expect(named(calls, 'fillText').map((c) => c.args[0])).toEqual(['рано']);
    calls.length = 0;
    renderer.mark('ошибка');
    expect(named(calls, 'fillText').map((c) => c.args[0])).toEqual(['ошибка']);
    calls.length = 0;
    renderer.clearMark();
    expect(named(calls, 'fillText')).toEqual([]);
    expect(named(calls, 'fillRect')).toHaveLength(1);
    // Showing a stimulus takes the mark away in its own draw (T-R59): one draw, no mark.
    renderer.mark('рано');
    calls.length = 0;
    renderer.show({ kind: 'shape', shape: 'circle', color: 'red' });
    expect(named(calls, 'fillText')).toEqual([]);
    expect(named(calls, 'fillRect')).toHaveLength(1);
    calls.length = 0;
    renderer.hide();
    expect(named(calls, 'fillText')).toEqual([]);
  });

  describe('jitter (F9)', () => {
    const JITTER = { dx: 0.1, dy: -0.05, scale: 1.1 };

    it('show(s, { dx: 0.1, dy: -0.05, scale: 1.1 }) moves the centre by (0.1·side, −0.05·side) and makes the stimulus 1.1 times larger', () => {
      const { renderer, calls } = setup({ w: 800, h: 600 });
      calls.length = 0;
      renderer.show({ kind: 'shape', shape: 'circle', color: 'red', frame: 'white' }, JITTER);
      const [figure, ring] = named(calls, 'arc').map((c) => c.args as number[]);
      expect(figure?.slice(0, 2)).toEqual([460, 270]);
      expect(figure?.[2]).toBeCloseTo(1.1 * 54, 9);
      // The frame keeps its gap and width in pixels around the larger figure.
      expect(ring?.slice(0, 2)).toEqual([460, 270]);
      expect(ring?.[2]).toBeCloseTo(1.1 * 54 + 10 + 6, 9);
      // The next stimulus without jitter is centred again.
      calls.length = 0;
      renderer.show({ kind: 'shape', shape: 'square', color: 'blue' });
      expect(named(calls, 'rect')[0]?.args).toEqual([346, 246, 108, 108]);
    });

    it('a word and a task-switching figure with its rule word move and grow together; the cue stands where the figure comes', () => {
      const { ctx, calls } = mockContext();
      const canvas = {
        clientWidth: 800,
        clientHeight: 600,
        width: 0,
        height: 0,
        getContext: () => ctx,
        ownerDocument: { defaultView: { devicePixelRatio: 1 } },
      } as unknown as HTMLCanvasElement;
      const renderer = createCanvasRenderer(canvas);
      calls.length = 0;
      renderer.show({ kind: 'word', word: 'green', ink: 'red' }, JITTER);
      expect(named(calls, 'fillText')[0]?.args).toEqual(['ЗЕЛЁНЫЙ', 460, 270]);
      expect(ctx.font).toBe("bold 79px 'Segoe UI', Arial, sans-serif");

      const s: Stimulus = { kind: 'switch', rule: 'shape', color: 'blue', shape: 'circle', size: 'large' };
      calls.length = 0;
      renderer.cue?.(s, JITTER);
      // 0.22 of the larger side above the moved centre: 270 − 0.22 · 660.
      const cue = named(calls, 'fillText')[0]?.args as [string, number, number];
      expect(cue[0]).toBe('ФОРМА');
      expect(cue[1]).toBe(460);
      expect(cue[2]).toBeCloseTo(270 - 0.22 * 660, 9);
      expect(ctx.font).toBe("bold 46px 'Segoe UI', Arial, sans-serif");
      calls.length = 0;
      renderer.show(s, JITTER);
      expect(named(calls, 'fillText')[0]?.args).toEqual(cue);
      const figure = named(calls, 'arc')[0]?.args as number[];
      expect(figure.slice(0, 2)).toEqual([460, 270]);
      expect(figure[2]).toBeCloseTo(0.09 * 660, 9);
    });

    it('a framed word near the edge stays on the canvas: its ring is pulled in', () => {
      const { renderer, calls } = setup({ w: 1000, h: 600 });
      calls.length = 0;
      renderer.show({ kind: 'word', word: 'green', ink: 'red', frame: 'white' }, { dx: 0, dy: -0.15, scale: 1.1 });
      const [cx, cy, r] = named(calls, 'arc').at(-1)?.args as [number, number, number];
      expect(r).toBeCloseTo(0.33 * 660, 9);
      // Unclamped the centre would be at 300 − 90 = 210, and the ring would reach 210 − 217.8 − 6 < 0.
      expect(cy - r - 6).toBeCloseTo(0, 9);
      expect(cx).toBe(500);
      expect(named(calls, 'fillText')[0]?.args.slice(1)).toEqual([cx, cy]);
      // Inside, it moves as asked.
      calls.length = 0;
      renderer.show({ kind: 'word', word: 'green', ink: 'red', frame: 'white' }, { dx: 0.05, dy: 0.05, scale: 0.9 });
      expect((named(calls, 'arc').at(-1)?.args as number[]).slice(0, 2)).toEqual([530, 330]);
    });

    it('the worst case keeps clear of the mark, which sits in the lower third', () => {
      const { ctx, calls } = mockContext();
      const canvas = {
        clientWidth: 1000,
        clientHeight: 600,
        width: 0,
        height: 0,
        getContext: () => ctx,
        ownerDocument: { defaultView: { devicePixelRatio: 1 } },
      } as unknown as HTMLCanvasElement;
      const renderer = createCanvasRenderer(canvas);
      /** The y of the last text drawn and half its font size. */
      const lastText = (): { y: number; half: number } => ({
        y: named(calls, 'fillText').at(-1)?.args[2] as number,
        half: Number(/(\d+)px/.exec(ctx.font)?.[1]) / 2,
      });
      renderer.mark('ошибка');
      const mark = lastText();
      expect(mark).toEqual({ y: 500, half: 18 });
      renderer.clearMark();
      // A mark shares a frame with the task-switching cue only (a press during the cue lead; never with a stimulus,
      // T-R59). At its highest, dy −0.15 and scale 1.1, the cue would cover a mark at h/6 (100 px)...
      const rule: Stimulus = { kind: 'switch', rule: 'shape', color: 'blue', shape: 'circle', size: 'large' };
      renderer.cue?.(rule, { dx: 0, dy: -0.15, scale: 1.1 });
      const high = lastText();
      expect(Math.abs(high.y - 600 / 6)).toBeLessThan(high.half + mark.half);
      // ... and at its lowest, dy +0.15 and scale 0.9, it stays above the centre, far from the mark at 5h/6.
      renderer.cue?.(rule, { dx: 0, dy: 0.15, scale: 0.9 });
      const low = lastText();
      expect(low.y + low.half).toBeLessThan(300);
      // Even the lowest unframed stimulus, dy +0.15 at scale 1.1, ends 0.05 of the side above the mark's text. A framed
      // Струп word reaches lower, but no stimulus shares a frame with the mark (T-R59).
      calls.length = 0;
      renderer.show({ kind: 'shape', shape: 'circle', color: 'red' }, { dx: 0, dy: 0.15, scale: 1.1 });
      const [, cy, r] = named(calls, 'arc')[0]?.args as [number, number, number];
      expect(mark.y - mark.half - (cy + r)).toBeGreaterThan(0.05 * 600);
    });
  });

  it('the word is bold, centred, 12% of the shorter side', () => {
    const { ctx, calls } = mockContext();
    const canvas = {
      clientWidth: 1000,
      clientHeight: 500,
      width: 0,
      height: 0,
      getContext: () => ctx,
      ownerDocument: { defaultView: { devicePixelRatio: 1 } },
    } as unknown as HTMLCanvasElement;
    const renderer = createCanvasRenderer(canvas);
    renderer.show({ kind: 'word', word: 'yellow', ink: 'blue' });
    expect(ctx.font).toBe("bold 60px 'Segoe UI', Arial, sans-serif");
    expect([ctx.textAlign, ctx.textBaseline]).toEqual(['center', 'middle']);
    expect(named(calls, 'fillText')[0]?.args).toEqual(['ЖЁЛТЫЙ', 500, 250]);
    // A word stimulus does not animate.
    calls.length = 0;
    renderer.tick(100);
    expect(calls).toEqual([]);
  });

  describe('switch (task switching)', () => {
    const font = (px: number): string => `bold ${String(px)}px 'Segoe UI', Arial, sans-serif`;

    it('draws the rule word as cue and keeps it with the stimulus', () => {
      const { ctx, calls } = mockContext();
      const canvas = {
        clientWidth: 800,
        clientHeight: 600,
        width: 0,
        height: 0,
        getContext: () => ctx,
        ownerDocument: { defaultView: { devicePixelRatio: 1 } },
      } as unknown as HTMLCanvasElement;
      const renderer = createCanvasRenderer(canvas);
      const s: Stimulus = { kind: 'switch', rule: 'shape', color: 'blue', shape: 'circle', size: 'large' };
      calls.length = 0;
      renderer.cue?.(s);
      // The word alone, white, 0.07 of the shorter side, centred 0.22 of it above the centre (300 − 132).
      expect(named(calls, 'fillText')).toEqual([
        { name: 'fillText', args: ['ФОРМА', 400, 168], fillStyle: COLORS.white, strokeStyle: undefined, lineWidth: undefined },
      ]);
      expect(ctx.font).toBe(font(42));
      expect([ctx.textAlign, ctx.textBaseline]).toEqual(['center', 'middle']);
      expect(named(calls, 'fill')).toEqual([]);

      calls.length = 0;
      renderer.show(s);
      expect(named(calls, 'fillText').map((c) => [c.args, c.fillStyle])).toEqual([[['ФОРМА', 400, 168], COLORS.white]]);
      expect(named(calls, 'arc')[0]?.args).toEqual([400, 300, 54, 0, 2 * Math.PI]);
      expect(named(calls, 'fill').map((c) => c.fillStyle)).toEqual([COLORS.blue]);

      // Does not animate; hide clears the word too.
      calls.length = 0;
      renderer.tick(100);
      expect(calls).toEqual([]);
      renderer.hide();
      expect(calls.map((c) => c.name)).toEqual(['setTransform', 'fillRect']);
    });

    it('a small figure has half the radius of a large one; squares too', () => {
      const { renderer, calls } = setup({ w: 800, h: 600 });
      calls.length = 0;
      renderer.show({ kind: 'switch', rule: 'size', color: 'red', shape: 'circle', size: 'small' });
      expect(named(calls, 'arc')[0]?.args).toEqual([400, 300, 27, 0, 2 * Math.PI]);
      expect(named(calls, 'fillText')[0]?.args[0]).toBe('РАЗМЕР');
      expect(named(calls, 'fill').map((c) => c.fillStyle)).toEqual([COLORS.red]);
      calls.length = 0;
      renderer.show({ kind: 'switch', rule: 'color', color: 'red', shape: 'square', size: 'large' });
      expect(named(calls, 'rect')[0]?.args).toEqual([346, 246, 108, 108]);
      calls.length = 0;
      renderer.show({ kind: 'switch', rule: 'color', color: 'red', shape: 'square', size: 'small' });
      expect(named(calls, 'rect')[0]?.args).toEqual([373, 273, 54, 54]);
    });

    it('a figure whose rule is hidden (runs, F3) is drawn without the word, and its cue draws nothing', () => {
      const { renderer, calls } = setup({ w: 800, h: 600 });
      const hidden: Stimulus = { kind: 'switch', rule: 'shape', color: 'blue', shape: 'circle', size: 'large', hideRule: true };
      calls.length = 0;
      renderer.cue?.(hidden);
      expect(calls).toEqual([]);
      renderer.show(hidden);
      expect(named(calls, 'fillText')).toEqual([]);
      expect(named(calls, 'arc')[0]?.args).toEqual([400, 300, 54, 0, 2 * Math.PI]);
      expect(named(calls, 'fill').map((c) => c.fillStyle)).toEqual([COLORS.blue]);
    });

    it('a cue for a stimulus without a rule draws nothing; a later show of it has no word', () => {
      const { renderer, calls } = setup();
      calls.length = 0;
      renderer.cue?.({ kind: 'shape', shape: 'circle', color: 'red' });
      expect(calls).toEqual([]);
      renderer.cue?.({ kind: 'switch', rule: 'color', color: 'red', shape: 'circle', size: 'large' });
      calls.length = 0;
      renderer.show({ kind: 'shape', shape: 'circle', color: 'red' });
      expect(named(calls, 'fillText')).toEqual([]);
    });
  });

  describe('visual noise', () => {
    const NOISE: VisualNoiseParams = {
      distractors: 5,
      lifetimeMs: 1000,
      flicker: false,
      farOnly: false,
      forbidden: [{ shape: 'circle', color: 'red' }],
    };
    const SEED = 11;
    const RED_CIRCLE: Stimulus = { kind: 'shape', shape: 'circle', color: 'red' };
    /** 800 × 600: the shorter side is 600, the box in side units is 0.667 × 0.5. */
    const BOX = { halfW: 400 / 600, halfH: 0.5 };

    it('draws distractors only while noise is active, under the stimulus', () => {
      const { renderer, calls } = setup({ noise: { params: NOISE, seed: SEED } });
      renderer.frame(1000);
      calls.length = 0;
      renderer.show(RED_CIRCLE);
      expect(named(calls, 'fill').map((c) => c.fillStyle)).toEqual([COLORS.red]);

      calls.length = 0;
      renderer.setNoiseActive(true);
      renderer.frame(1016);
      const expected = noiseFrame(NOISE, SEED, 16, BOX).map((d) => COLORS[d.color]);
      expect(expected).toHaveLength(5);
      expect(named(calls, 'fill').map((c) => c.fillStyle)).toEqual([...expected, COLORS.red]);
      expect(named(calls, 'fillRect')).toHaveLength(1);

      calls.length = 0;
      renderer.setNoiseActive(false);
      renderer.frame(1032);
      expect(named(calls, 'fill').map((c) => c.fillStyle)).toEqual([COLORS.red]);
      // hide keeps the noise while it is active: the ISI before a noisy trial is noisy too.
      renderer.setNoiseActive(true);
      calls.length = 0;
      renderer.hide();
      expect(named(calls, 'fill')).toHaveLength(5);
    });

    it('draws the noise under the cue word', () => {
      const { renderer, calls } = setup({ noise: { params: NOISE, seed: SEED } });
      renderer.setNoiseActive(true);
      calls.length = 0;
      renderer.cue?.({ kind: 'switch', rule: 'color', color: 'red', shape: 'circle', size: 'large' });
      expect(calls.map((c) => c.name).filter((n) => n === 'fill' || n === 'fillText')).toEqual([
        ...Array<string>(5).fill('fill'),
        'fillText',
      ]);
    });

    it('does not redraw an unchanged noise frame', () => {
      const { renderer, calls } = setup({ noise: { params: NOISE, seed: SEED } });
      renderer.setNoiseActive(true);
      renderer.frame(1000);
      const drawn = named(calls, 'fillRect').length;
      // 5 figures × 1000 ms: one of them changes every 200 ms, the first at 200 ms.
      for (const ts of [1016, 1033, 1100, 1199]) renderer.frame(ts);
      expect(named(calls, 'fillRect')).toHaveLength(drawn);
      renderer.frame(1200);
      expect(named(calls, 'fillRect')).toHaveLength(drawn + 1);
      renderer.frame(1216);
      expect(named(calls, 'fillRect')).toHaveLength(drawn + 1);
    });

    it('flicker switches the background colour #2b2b2b ↔ #3a3a3a while the noise is on', () => {
      expect(FLICKER_BACKGROUND).toBe('#3a3a3a');
      const { renderer, calls } = setup({ noise: { params: { ...NOISE, flicker: true }, seed: SEED } });
      const background = (): unknown => named(calls, 'fillRect').at(-1)?.fillStyle;
      renderer.setNoiseActive(true);
      renderer.frame(1000);
      expect(background()).toBe('#2b2b2b');
      renderer.frame(1249);
      expect(background()).toBe('#2b2b2b');
      renderer.frame(1250);
      expect(background()).toBe('#3a3a3a');
      renderer.frame(1500);
      expect(background()).toBe('#2b2b2b');
      renderer.frame(1750);
      expect(background()).toBe('#3a3a3a');
      // Off: the plain background, whatever the flicker phase.
      renderer.setNoiseActive(false);
      renderer.frame(1760);
      expect(background()).toBe(BACKGROUND);
      renderer.frame(2250);
      expect(background()).toBe(BACKGROUND);
    });

    it('each figure fits in its size around its centre, so none reaches into the central zone', () => {
      const params: VisualNoiseParams = { ...NOISE, distractors: 14 };
      const { renderer, calls } = setup({ w: 1000, h: 500, noise: { params, seed: 3 } });
      const side = 500;
      const seen = new Set<ShapeId>();
      renderer.setNoiseActive(true);
      for (let t = 0; t < 5000; t += 250) {
        calls.length = 0;
        renderer.frame(1000 + t);
        const figures = noiseFrame(params, 3, t, { halfW: 1, halfH: 0.5 });
        // One path per figure: beginPath … fill.
        const paths: Call[][] = [];
        for (const c of calls) {
          if (c.name === 'beginPath') paths.push([]);
          else paths.at(-1)?.push(c);
        }
        expect(paths).toHaveLength(figures.length);
        figures.forEach((d, j) => {
          seen.add(d.shape);
          const cx = 500 + d.x * side;
          const cy = 250 + d.y * side;
          const limit = (d.size * side) / 2 + 1e-9;
          let farthest = 0;
          const reach = (px: number, py: number, extra = 0): void => {
            farthest = Math.max(farthest, Math.hypot(px - cx, py - cy) + extra);
          };
          for (const c of paths[j] ?? []) {
            const [x, y, a, b] = c.args as [number, number, number, number];
            if (c.name === 'arc') reach(x, y, a); // centre and radius
            if (c.name === 'rect') for (const [px, py] of [[x, y], [x + a, y], [x, y + b], [x + a, y + b]] as const) reach(px, py);
            if (c.name === 'moveTo' || c.name === 'lineTo') reach(x, y);
          }
          expect(farthest).toBeGreaterThan(0);
          expect(farthest).toBeLessThanOrEqual(limit);
          expect(Math.hypot(cx - 500, cy - 250) - farthest).toBeGreaterThanOrEqual(NOISE_EXCLUSION_RADIUS * side - 1e-9);
        });
      }
      expect([...seen].sort()).toEqual(['circle', 'diamond', 'hexagon', 'square', 'star', 'triangle']);
    });

    it('driven by the runner, an onset frame is drawn once, with that frame\'s noise (high L: figures change every frame)', async () => {
      const params = pomeh.params(36).noise;
      expect(params.lifetimeMs / params.distractors).toBeLessThan(FRAME);
      const { renderer, calls } = setup({ noise: { params, seed: SEED } });
      renderer.setNoiseActive(true);
      const specs = [500, 700, 300, 900].map((isiMs) => ({
        isiMs,
        windowMs: 200,
        stimulus: RED_CIRCLE,
        expected: { kind: 'press' as const, key: 'Space' as const },
      }));
      const clock = new FakeClock();
      const runner = new ReactionBlockRunner({ specs, clock, renderer, nominalFrameMs: FRAME });
      const done = runner.start();
      const draws = new Map<number, Call[][]>();
      while (clock.hasPending) {
        const from = calls.length;
        clock.step();
        // One draw = one background fill and what follows it.
        const frame: Call[][] = [];
        for (const c of calls.slice(from)) {
          if (c.name === 'fillRect') frame.push([]);
          else frame.at(-1)?.push(c);
        }
        draws.set(clock.now, frame);
      }
      const end = await done;
      if (end.kind !== 'done') throw new Error('expected done');
      const t0 = clock.frames[0] as number;
      expect(end.timeline.onsets).toHaveLength(4);
      for (const onset of end.timeline.onsets) {
        const frame = draws.get(onset) ?? [];
        expect(frame, `onset ${String(onset)}`).toHaveLength(1);
        const figures = noiseFrame(params, SEED, onset - t0, BOX).map((d) => COLORS[d.color]);
        expect(named(frame[0] ?? [], 'fill').map((c) => c.fillStyle)).toEqual([...figures, COLORS.red]);
      }
    });

    it('the central zone moves and grows with the jittered stimulus: no figure lies under it (T-R63)', () => {
      const params: VisualNoiseParams = { ...NOISE, distractors: 14, farOnly: true };
      const { renderer, calls } = setup({ w: 1000, h: 500, noise: { params, seed: 3 } });
      const side = 500;
      const jitter = { dx: 0.15, dy: -0.12, scale: 1.1 };
      renderer.show(RED_CIRCLE, jitter);
      renderer.setNoiseActive(true);
      let moved = false;
      for (let t = 0; t < 5000; t += 250) {
        calls.length = 0;
        renderer.frame(1000 + t);
        const box = { halfW: 1, halfH: 0.5 };
        const figures = noiseFrame(params, 3, t, box, { x: jitter.dx, y: jitter.dy, scale: jitter.scale });
        if (JSON.stringify(figures) !== JSON.stringify(noiseFrame(params, 3, t, box))) moved = true;
        // The figures as drawn: one fill each, then the stimulus.
        expect(named(calls, 'fill').map((c) => c.fillStyle)).toEqual([...figures.map((d) => COLORS[d.color]), COLORS.red]);
        for (const d of figures) {
          const gap = Math.hypot(d.x - jitter.dx, d.y - jitter.dy) - d.size / 2;
          expect(gap * side).toBeGreaterThanOrEqual(NOISE_EXCLUSION_RADIUS * jitter.scale * side - 1e-9);
        }
      }
      expect(moved).toBe(true);
    });

    it('a canvas of zero size draws no noise; without noise options nothing changes', () => {
      const empty = setup({ w: 0, h: 0, noise: { params: NOISE, seed: SEED } });
      empty.renderer.setNoiseActive(true);
      expect(() => {
        empty.renderer.frame(1000);
      }).not.toThrow();
      expect(named(empty.calls, 'fill')).toEqual([]);

      const plain = setup();
      plain.renderer.setNoiseActive(true);
      plain.calls.length = 0;
      plain.renderer.frame(1000);
      plain.renderer.frame(1300);
      expect(plain.calls).toEqual([]);
      plain.renderer.hide();
      expect(named(plain.calls, 'fill')).toEqual([]);
    });
  });

  it('palette matches the reference colours', () => {
    expect(BACKGROUND).toBe('#2b2b2b');
    expect(COLORS).toEqual({
      red: '#e53935',
      green: '#43a047',
      yellow: '#fdd835',
      blue: '#1e88e5',
      white: '#f5f5f5',
      purple: '#8e24aa',
      gray: '#9a9a9a',
    });
  });

  it('grey noise figures are drawn #9a9a9a (Р13)', () => {
    const six: ColorId[] = ['red', 'green', 'yellow', 'blue', 'white', 'purple'];
    const shapes: ShapeId[] = ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'star'];
    const params: VisualNoiseParams = {
      distractors: 6,
      lifetimeMs: 600,
      flicker: false,
      farOnly: true,
      forbidden: shapes.flatMap((shape) => six.map((color) => ({ shape, color }))),
    };
    const { renderer, calls } = setup({ noise: { params, seed: 5 } });
    renderer.setNoiseActive(true);
    calls.length = 0;
    renderer.hide();
    const fills = named(calls, 'fill').map((c) => c.fillStyle);
    expect(fills).toHaveLength(6);
    expect(new Set(fills)).toEqual(new Set(['#9a9a9a']));
  });

  describe('rdo', () => {
    const rdo: Stimulus = { kind: 'rdo', startDeg: 30, targetDeg: 200, periodMs: 2000 };

    it('draws the dial, the red target tick and the dot at startDeg on show', () => {
      const { renderer, calls } = setup({ w: 800, h: 600 });
      calls.length = 0;
      renderer.show(rdo);
      const arcs = named(calls, 'arc');
      expect(arcs[0]?.args).toEqual([400, 300, 210, 0, 2 * Math.PI]); // radius 35% of 600
      const tick = named(calls, 'stroke').find((c) => c.strokeStyle === COLORS.red);
      expect(tick).toBeDefined();
      const dot = arcs.at(-1)?.args as number[];
      const expected = polarPoint(400, 300, 210, 30);
      expect(dot[0]).toBeCloseTo(expected.x, 9);
      expect(dot[1]).toBeCloseTo(expected.y, 9);
      expect(named(calls, 'fill').at(-1)?.fillStyle).toBe(COLORS.white);
    });

    it('tick moves the dot and extends the swept arc', () => {
      const { renderer, calls } = setup({ w: 800, h: 600 });
      renderer.show(rdo);
      calls.length = 0;
      renderer.tick(500); // quarter period → 120°
      const arcs = named(calls, 'arc');
      const dot = arcs.at(-1)?.args as number[];
      const expected = polarPoint(400, 300, 210, 120);
      expect(dot[0]).toBeCloseTo(expected.x, 9);
      expect(dot[1]).toBeCloseTo(expected.y, 9);
      const sweep = arcs.find((c) => c.args[2] === 210 && c.args[3] !== 0);
      const [, , , from, to] = sweep?.args as [number, number, number, number, number];
      expect(to - from).toBeCloseTo(Math.PI / 2, 9);
    });

    it('swept arc is capped at a full circle', () => {
      const { renderer, calls } = setup({ w: 800, h: 600 });
      renderer.show(rdo);
      calls.length = 0;
      renderer.tick(2600);
      const sweep = named(calls, 'arc').find((c) => c.args[2] === 210 && c.args[3] !== 0);
      const [, , , from, to] = sweep?.args as [number, number, number, number, number];
      expect(to - from).toBeCloseTo(2 * Math.PI, 9);
    });

    it('tick does nothing while hidden or for shape stimuli', () => {
      const { renderer, calls } = setup();
      calls.length = 0;
      renderer.tick(100);
      renderer.show({ kind: 'shape', shape: 'circle', color: 'red' });
      const afterShow = calls.length;
      renderer.tick(100);
      expect(calls).toHaveLength(afterShow);
      renderer.show(rdo);
      renderer.hide();
      const afterHide = calls.length;
      renderer.tick(100);
      expect(calls).toHaveLength(afterHide);
    });
  });
});

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG 2.x contrast ratio of two #rrggbb colours (1…21). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('readability of the word stimuli (WCAG contrast, large text ≥ 3:1)', () => {
  it('computes the WCAG ratio', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrast(BACKGROUND, BACKGROUND)).toBe(1);
  });

  it('every Stroop ink reads at ≥ 3:1 on the reaction background', () => {
    const ratios = Object.fromEntries(STROOP_COLORS.map((c) => [c, Number(contrast(COLORS[c], BACKGROUND).toFixed(2))]));
    // red 3.35, green 4.29, blue 3.85, yellow 10.15 against #2b2b2b.
    expect(ratios).toEqual({ red: 3.35, green: 4.29, blue: 3.85, yellow: 10.15 });
    for (const c of STROOP_COLORS) expect(contrast(COLORS[c], BACKGROUND), c).toBeGreaterThanOrEqual(3);
  });

  it('Stroop words are never drawn on the flicker shade: its noise (F3) never flickers', () => {
    for (let L = 0; L <= 60; L++) expect(stressorsOf(stroop, stroop.params(L)).noise?.flicker ?? false, `L ${String(L)}`).toBe(false);
    expect(stressorsOf(stroop, stroop.params(24)).noise).not.toBeNull();
  });

  it('the mark after a trial (F15) reads at ≥ 4.5:1 on both background shades', () => {
    expect(MARK_COLOR).toBe('#bdbdbd');
    expect(contrast(MARK_COLOR, BACKGROUND)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(MARK_COLOR, FLICKER_BACKGROUND)).toBeGreaterThanOrEqual(4.5);
  });

  it('the task-switching rule word (white) reads at ≥ 4.5:1 on the background', () => {
    expect(contrast(COLORS.white, BACKGROUND)).toBeGreaterThanOrEqual(4.5);
  });

  it('the memory grid lines and the lit cell reach 3:1 on the background (WCAG 1.4.11, B5)', () => {
    expect(contrast(GRID_LINE, BACKGROUND)).toBeGreaterThanOrEqual(3);
    expect(contrast(LIT_CELL, BACKGROUND)).toBeGreaterThanOrEqual(3);
  });
});
