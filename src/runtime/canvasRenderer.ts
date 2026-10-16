import { flickerOn, noiseFrame, noiseSlots, type Distractor, type VisualNoiseParams } from '../engine/noise';
import { COLOR_WORDS, RULE_WORDS, type ColorId, type ShapeId, type Stimulus, type SwitchRule } from '../engine/reaction/types';
import type { FeedbackMark, StimulusRenderer } from './reactionRunner';

export const BACKGROUND = '#2b2b2b';
/** The second shade of a flickering background: 15 grey levels above BACKGROUND. */
export const FLICKER_BACKGROUND = '#3a3a3a';

export const COLORS: Readonly<Record<ColorId, string>> = {
  red: '#e53935',
  green: '#43a047',
  yellow: '#fdd835',
  blue: '#1e88e5',
  white: '#f5f5f5',
  purple: '#8e24aa',
  /** Noise only (Р13). */
  gray: '#9a9a9a',
};

/** Stimulus diameter as a share of the canvas's shorter side. */
const STIMULUS_SIZE = 0.18;
const FRAME_WIDTH_PX = 12;
const FRAME_GAP_PX = 10;
const STAR_INNER = 0.45;
/** The mark: a white dot whose diameter is this share of the figure's (F8). */
const MARK_SIZE = 0.2;
/** Stroop word height as a share of the shorter side. */
const WORD_SIZE = 0.12;
/**
 * The ring around a framed word (the reverse Stroop rule), as a share of the shorter side: it clears the longest word,
 * «ЗЕЛЁНЫЙ», under 0.6 of the side wide at WORD_SIZE.
 */
const WORD_RING_RADIUS = 0.33;
const WORD_FONT = "'Segoe UI', Arial, sans-serif";
/** Task-switching figure diameters as a share of the shorter side. */
const SWITCH_SIZE = { large: 0.18, small: 0.09 } as const;
/** The rule word: height and how far above the centre, as shares of the shorter side. */
const RULE_WORD_SIZE = 0.07;
const RULE_WORD_RISE = 0.22;

/** The mark after a trial (F15, Р23): its colour, its height as a share of the shorter side, its centre at h · MARK_RISE. */
export const MARK_COLOR = '#bdbdbd';
const MARK_TEXT_SIZE = 0.06;
const MARK_RISE = 1 / 6;

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
  if (s.mark === true) {
    ctx.beginPath();
    ctx.arc(cx, cy, MARK_SIZE * r, 0, FULL_TURN);
    ctx.fillStyle = COLORS.white;
    ctx.fill();
  }
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
  if (s.frame === undefined) return;
  ctx.beginPath();
  ctx.arc(cx, cy, WORD_RING_RADIUS * side, 0, FULL_TURN);
  ctx.strokeStyle = COLORS[s.frame];
  ctx.lineWidth = FRAME_WIDTH_PX;
  ctx.stroke();
}

/** The rule word above the centre (the cue, and with the figure). */
function drawRule(ctx: CanvasRenderingContext2D, rule: SwitchRule, cx: number, cy: number, side: number): void {
  ctx.font = `bold ${String(Math.round(RULE_WORD_SIZE * side))}px ${WORD_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.white;
  ctx.fillText(RULE_WORDS[rule], cx, cy - RULE_WORD_RISE * side);
}

function drawSwitch(
  ctx: CanvasRenderingContext2D,
  s: Extract<Stimulus, { kind: 'switch' }>,
  cx: number,
  cy: number,
  side: number,
): void {
  if (s.hideRule !== true) drawRule(ctx, s.rule, cx, cy, side);
  shapePath(ctx, s.shape, cx, cy, (SWITCH_SIZE[s.size] * side) / 2);
  ctx.fillStyle = COLORS[s.color];
  ctx.fill();
}

/** A distractor: the whole shape fits in the circle of diameter `size` around its centre (corners included). */
function drawDistractor(ctx: CanvasRenderingContext2D, d: Distractor, cx: number, cy: number, side: number): void {
  const r = (d.size * side) / 2 / extent(d.shape, 1);
  shapePath(ctx, d.shape, cx + d.x * side, cy + d.y * side, r);
  ctx.fillStyle = COLORS[d.color];
  ctx.fill();
}

/** The mark, centred across the top third of the screen. */
function drawMark(ctx: CanvasRenderingContext2D, text: FeedbackMark, w: number, h: number, side: number): void {
  ctx.font = `bold ${String(Math.round(MARK_TEXT_SIZE * side))}px ${WORD_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = MARK_COLOR;
  ctx.fillText(text, w / 2, h * MARK_RISE);
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

export interface CanvasRenderer extends StimulusRenderer {
  /** Visual noise on or off from the next draw; a renderer made without noise stays plain. */
  setNoiseActive(on: boolean): void;
  /** Before a frame's transitions: noise time moves on (counted from the first call); draws nothing. */
  beginFrame(ts: number): void;
  /** Once per frame, after its transitions: noise time moves on; redraws only when the noise looks different. */
  frame(ts: number): void;
  mark(text: FeedbackMark): void;
  clearMark(): void;
}

export interface CanvasRendererOptions {
  /** The block's visual noise: figures and their seed (BlockStressors.noise, layers.seed). */
  noise?: { params: VisualNoiseParams; seed: number };
}

/** What the noise layer shows: the background shade and each figure's slot; null while off. */
interface NoiseLook {
  flicker: boolean;
  slots: number[];
}

function sameLook(a: NoiseLook | null, b: NoiseLook | null): boolean {
  if (a === null || b === null) return a === b;
  return a.flicker === b.flicker && a.slots.length === b.slots.length && a.slots.every((s, j) => s === b.slots[j]);
}

/**
 * Draws stimuli on a canvas, outside React. The backing store follows the canvas's CSS size × devicePixelRatio
 * (checked on every draw); drawing coordinates are CSS pixels. Each draw paints the whole frame: the background
 * (flickering while the noise is on), the noise figures, the stimulus or the cue, then the mark after a trial (F15).
 */
export function createCanvasRenderer(canvas: HTMLCanvasElement, o: CanvasRendererOptions = {}): CanvasRenderer {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('createCanvasRenderer: 2D context is not available');
  const noise = o.noise ?? null;
  let current: Stimulus | null = null;
  /** The rule word drawn alone before the figure (`cue`); the shown stimulus brings its own. */
  let cueRule: SwitchRule | null = null;
  let elapsedMs = 0;
  let noiseOn = false;
  /** Timestamp of the first `frame` call: noise time starts there. */
  let noiseStart: number | null = null;
  let noiseMs = 0;
  /** The noise as the last draw painted it. */
  let drawnLook: NoiseLook | null = null;
  /** The mark after a trial on screen (F15); hiding a stimulus keeps it, showing one takes it away (T-R59). */
  let markText: FeedbackMark | null = null;

  const setNoiseTime = (ts: number): void => {
    noiseStart ??= ts;
    noiseMs = ts - noiseStart;
  };

  const noiseLook = (): NoiseLook | null =>
    noise === null || !noiseOn ? null : { flicker: flickerOn(noise.params, noiseMs), slots: noiseSlots(noise.params, noiseMs) };

  const draw = (): void => {
    const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const look = noiseLook();
    drawnLook = look;
    ctx.fillStyle = look?.flicker === true ? FLICKER_BACKGROUND : BACKGROUND;
    ctx.fillRect(0, 0, w, h);
    const side = Math.min(w, h);
    if (look !== null && noise !== null && side > 0) {
      const box = { halfW: w / 2 / side, halfH: h / 2 / side };
      for (const d of noiseFrame(noise.params, noise.seed, noiseMs, box)) drawDistractor(ctx, d, w / 2, h / 2, side);
    }
    drawStimulus(w, h, side);
    if (markText !== null) drawMark(ctx, markText, w, h, side);
  };

  const drawStimulus = (w: number, h: number, side: number): void => {
    if (current === null) {
      if (cueRule !== null) drawRule(ctx, cueRule, w / 2, h / 2, side);
      return;
    }
    switch (current.kind) {
      case 'shape':
        drawShape(ctx, current, w / 2, h / 2, side);
        return;
      case 'word':
        drawWord(ctx, current, w / 2, h / 2, side);
        return;
      case 'switch':
        drawSwitch(ctx, current, w / 2, h / 2, side);
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
      cueRule = null;
      elapsedMs = 0;
      // A mark never shares a frame with a stimulus: it goes in this draw (T-R59).
      markText = null;
      draw();
    },
    hide() {
      current = null;
      cueRule = null;
      draw();
    },
    cue(s) {
      if (s.kind !== 'switch' || s.hideRule === true) return;
      current = null;
      cueRule = s.rule;
      draw();
    },
    tick(ms) {
      if (current?.kind !== 'rdo') return;
      elapsedMs = ms;
      draw();
    },
    setNoiseActive(on) {
      noiseOn = on;
    },
    mark(text) {
      markText = text;
      draw();
    },
    clearMark() {
      markText = null;
      draw();
    },
    beginFrame: setNoiseTime,
    frame(ts) {
      setNoiseTime(ts);
      if (!sameLook(noiseLook(), drawnLook)) draw();
    },
  };
}
