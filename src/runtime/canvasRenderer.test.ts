import { describe, expect, it } from 'vitest';
import type { ColorId, ShapeId, Stimulus } from '../engine/reaction/types';
import { BACKGROUND, COLORS, createCanvasRenderer, polarPoint, rdoAngleAt } from './canvasRenderer';

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

function setup(opts: { w?: number; h?: number; dpr?: number | null } = {}) {
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
  const renderer = createCanvasRenderer(fake as unknown as HTMLCanvasElement);
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

  it('palette matches the reference colours', () => {
    expect(BACKGROUND).toBe('#2b2b2b');
    expect(COLORS).toEqual({
      red: '#e53935',
      green: '#43a047',
      yellow: '#fdd835',
      blue: '#1e88e5',
      white: '#f5f5f5',
      purple: '#8e24aa',
    });
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
