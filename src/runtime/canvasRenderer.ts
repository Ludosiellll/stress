import type { ColorId, ShapeId, Stimulus } from '../engine/reaction/types';
import { COLOR_WORDS } from '../modules/reaction/stroop';
import type { StimulusRenderer } from './reactionRunner';

export const BACKGROUND = '#2b2b2b';

export const COLORS: Readonly<Record<ColorId, string>> = {
  red: '#e53935',
  green: '#43a047',
  yellow: '#fdd835',
  blue: '#1e88e5',
  white: '#f5f5f5',
  purple: '#8e24aa',
};

/** Stimulus diameter as a share of the canvas's shorter side. */
const STIMULUS_SIZE = 0.18;
const FRAME_WIDTH_PX = 12;
const FRAME_GAP_PX = 10;
const STAR_INNER = 0.45;
/** Stroop word height as a share of the shorter side. */
const WORD_SIZE = 0.12;
const WORD_FONT = "'Segoe UI', Arial, sans-serif";

/** RDO dial radius as a share of the shorter side. */
const RDO_RADIUS = 0.35;
const RDO_DIAL = { color: '#8a8a8a', width: 2 };
const RDO_TRAIL = { color: 'rgba(245, 245, 245, 0.35)', width: 6 };
const RDO_TARGET = { halfLength: 18, width: 5 };
const RDO_DOT_PX = 9;

const FULL_TURN = 2 * Math.PI;

/** Angle of the RDO dot (degrees, 0° = top, clockwise, in [0, 360)) after `elapsedMs` from onset. */
export function rdoAngleAt(startDeg: number, periodMs: number, elapsedMs: number): number {
  const deg = (startDeg + (360 * elapsedMs) / periodMs) % 360;
  return deg < 0 ? deg + 360 : deg;
}

/** Point at `r` from (cx, cy) in direction `deg` (0° = top, clockwise; canvas y grows downwards). */
export function polarPoint(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

/** Canvas arc angle (radians from +x, clockwise) for a dial angle (0° = top). */
const arcAngle = (deg: number): number => ((deg - 90) * Math.PI) / 180;

/** Farthest point of the shape from its centre, for a shape of radius r (half the diameter). */
function extent(shape: ShapeId, r: number): number {
  return shape === 'square' || shape === 'triangle' ? r * Math.SQRT2 : r;
}

function polygon(ctx: CanvasRenderingContext2D, points: readonly { x: number; y: number }[]): void {
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
}

/** n points around (cx, cy), the first at the top; `radiusAt(k)` gives the radius of point k. */
function around(cx: number, cy: number, n: number, radiusAt: (k: number) => number): { x: number; y: number }[] {
  return Array.from({ length: n }, (_, k) => polarPoint(cx, cy, radiusAt(k), (k * 360) / n));
}

/** Path of a shape that fits a 2r × 2r box centred on (cx, cy). */
function shapePath(ctx: CanvasRenderingContext2D, shape: ShapeId, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  switch (shape) {
    case 'circle':
      ctx.arc(cx, cy, r, 0, FULL_TURN);
      return;
    case 'square':
      ctx.rect(cx - r, cy - r, 2 * r, 2 * r);
      return;
    case 'triangle':
      polygon(ctx, [
        { x: cx, y: cy - r },
        { x: cx + r, y: cy + r },
        { x: cx - r, y: cy + r },
      ]);
      return;
    case 'diamond':
      polygon(ctx, around(cx, cy, 4, () => r));
      return;
    case 'hexagon':
      polygon(ctx, around(cx, cy, 6, () => r));
      return;
    case 'star':
      polygon(ctx, around(cx, cy, 10, (k) => (k % 2 === 0 ? r : r * STAR_INNER)));
      return;
  }
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  s: Extract<Stimulus, { kind: 'shape' }>,
  cx: number,
  cy: number,
  side: number,
): void {
  const r = (STIMULUS_SIZE * side) / 2;
  shapePath(ctx, s.shape, cx, cy, r);
  ctx.fillStyle = COLORS[s.color];
  ctx.fill();
  if (s.frame === undefined) return;
  ctx.beginPath();
  ctx.arc(cx, cy, extent(s.shape, r) + FRAME_GAP_PX + FRAME_WIDTH_PX / 2, 0, FULL_TURN);
  ctx.strokeStyle = COLORS[s.frame];
  ctx.lineWidth = FRAME_WIDTH_PX;
  ctx.stroke();
}

function drawWord(
  ctx: CanvasRenderingContext2D,
  s: Extract<Stimulus, { kind: 'word' }>,
  cx: number,
  cy: number,
  side: number,
): void {
  ctx.font = `bold ${String(Math.round(WORD_SIZE * side))}px ${WORD_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS[s.ink];
  ctx.fillText(COLOR_WORDS[s.word], cx, cy);
}

function drawRdo(
  ctx: CanvasRenderingContext2D,
  s: Extract<Stimulus, { kind: 'rdo' }>,
  elapsedMs: number,
  cx: number,
  cy: number,
  side: number,
): void {
  const R = RDO_RADIUS * side;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, FULL_TURN);
  ctx.strokeStyle = RDO_DIAL.color;
  ctx.lineWidth = RDO_DIAL.width;
  ctx.stroke();

  const sweepDeg = Math.min(360, (360 * elapsedMs) / s.periodMs);
  if (sweepDeg > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, R, arcAngle(s.startDeg), arcAngle(s.startDeg + sweepDeg));
    ctx.strokeStyle = RDO_TRAIL.color;
    ctx.lineWidth = RDO_TRAIL.width;
    ctx.stroke();
  }

  const inner = polarPoint(cx, cy, R - RDO_TARGET.halfLength, s.targetDeg);
  const outer = polarPoint(cx, cy, R + RDO_TARGET.halfLength, s.targetDeg);
  ctx.beginPath();
  ctx.moveTo(inner.x, inner.y);
  ctx.lineTo(outer.x, outer.y);
  ctx.strokeStyle = COLORS.red;
  ctx.lineWidth = RDO_TARGET.width;
  ctx.stroke();

  const dot = polarPoint(cx, cy, R, rdoAngleAt(s.startDeg, s.periodMs, elapsedMs));
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, RDO_DOT_PX, 0, FULL_TURN);
  ctx.fillStyle = COLORS.white;
  ctx.fill();
}

/**
 * Draws stimuli on a canvas, outside React. The backing store follows the canvas's CSS size × devicePixelRatio
 * (checked on every draw); drawing coordinates are CSS pixels. Each call redraws the whole frame.
 */
export function createCanvasRenderer(canvas: HTMLCanvasElement): StimulusRenderer {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('createCanvasRenderer: 2D context is not available');
  let current: Stimulus | null = null;
  let elapsedMs = 0;

  const draw = (): void => {
    const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, w, h);
    if (current === null) return;
    const side = Math.min(w, h);
    switch (current.kind) {
      case 'shape':
        drawShape(ctx, current, w / 2, h / 2, side);
        return;
      case 'word':
        drawWord(ctx, current, w / 2, h / 2, side);
        return;
      case 'rdo':
        drawRdo(ctx, current, elapsedMs, w / 2, h / 2, side);
        return;
    }
  };

  draw();
  return {
    show(s) {
      current = s;
      elapsedMs = 0;
      draw();
    },
    hide() {
      current = null;
      draw();
    },
    tick(ms) {
      if (current?.kind !== 'rdo') return;
      elapsedMs = ms;
      draw();
    },
  };
}
