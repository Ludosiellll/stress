import { COLOR_IDS, SHAPE_IDS, type ColorId, type ShapeId } from './reaction/types';
import { createRng, deriveSeed, type Rng } from './rng';

/**
 * Visual noise around the stimulus: figures that appear and change at random places outside the centre, and a
 * background flicker. Coordinates are in "side units": the canvas's shorter side is 1 and its centre is (0, 0).
 */
export interface VisualNoiseParams {
  /** Figures on screen at once. */
  distractors: number;
  /** How long a figure stays before another one takes its place, ms. */
  lifetimeMs: number;
  /** The background alternates #2b2b2b ↔ #3a3a3a every FLICKER_HALF_PERIOD_MS while the noise is on. */
  flicker: boolean;
  /** Only figures far from the targets: no circles and no colour of a target pair. */
  farOnly: boolean;
  /** The target (shape, colour) pairs: a distractor is never one of them. */
  forbidden: ReadonlyArray<{ shape: ShapeId; color: ColorId }>;
}

/** One figure: centre (x, y) and diameter `size` (the whole figure fits in that circle), in side units. */
export interface Distractor {
  x: number;
  y: number;
  size: number;
  shape: ShapeId;
  color: ColorId;
}

/** Radius of the central zone no figure enters, in side units. */
export const NOISE_EXCLUSION_RADIUS = 0.2;
/** Flicker: 250 ms per shade, a 500 ms period (2 Hz, below the WCAG 2.3.1 flash threshold). */
export const FLICKER_HALF_PERIOD_MS = 250;

const SIZE_MIN = 0.06;
const SIZE_MAX = 0.1;
const PLACE_ATTEMPTS = 20;

/**
 * Slot of each figure at `elapsedMs`: figure j is replaced every lifetimeMs, its phase shifted by
 * j · lifetimeMs / distractors so that the figures do not all change at once.
 */
export function noiseSlots(p: VisualNoiseParams, elapsedMs: number): number[] {
  return Array.from({ length: p.distractors }, (_, j) => Math.floor((elapsedMs + (j * p.lifetimeMs) / p.distractors) / p.lifetimeMs));
}

/** The (shape, colour) pairs a distractor may take. */
function allowedPairs(p: VisualNoiseParams): { shape: ShapeId; color: ColorId }[] {
  const targetColors = new Set(p.forbidden.map((f) => f.color));
  return SHAPE_IDS.flatMap((shape) =>
    COLOR_IDS.flatMap((color) => {
      if (p.forbidden.some((f) => f.shape === shape && f.color === color)) return [];
      if (p.farOnly && (shape === 'circle' || targetColors.has(color))) return [];
      return [{ shape, color }];
    }),
  );
}

/**
 * A point for a figure of diameter `size` inside the box (with a size/2 margin) whose distance from the centre is at
 * least NOISE_EXCLUSION_RADIUS + size/2, so that the whole figure stays out of the central zone. After 20 misses: a
 * point on that circle at a random angle (the zone always wins over the box).
 */
function place(rng: Rng, size: number, box: { halfW: number; halfH: number }): { x: number; y: number } {
  const r = size / 2;
  const minDist = NOISE_EXCLUSION_RADIUS + r;
  for (let i = 0; i < PLACE_ATTEMPTS; i++) {
    const x = (2 * rng.next() - 1) * (box.halfW - r);
    const y = (2 * rng.next() - 1) * (box.halfH - r);
    if (Math.hypot(x, y) >= minDist) return { x, y };
  }
  const angle = 2 * Math.PI * rng.next();
  return { x: minDist * Math.cos(angle), y: minDist * Math.sin(angle) };
}

/**
 * The figures on screen `elapsedMs` after the noise started. Figure j in slot s is drawn from
 * createRng(deriveSeed(seed, `j:s`)): the same inputs give the same frame, and a figure stays put within its slot.
 * `box` is the half size of the canvas in side units (the shorter half side is 0.5).
 */
export function noiseFrame(
  p: VisualNoiseParams,
  seed: number,
  elapsedMs: number,
  box: { halfW: number; halfH: number },
): Distractor[] {
  const pairs = allowedPairs(p);
  if (pairs.length === 0) throw new RangeError('noiseFrame: every shape and colour pair is excluded');
  return noiseSlots(p, elapsedMs).map((slot, j) => {
    const rng = createRng(deriveSeed(seed, `${String(j)}:${String(slot)}`));
    const size = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * rng.next();
    return { ...place(rng, size, box), size, ...rng.pick(pairs) };
  });
}

/** Whether the background shows its second shade at `elapsedMs`: never without flicker. */
export function flickerOn(p: VisualNoiseParams, elapsedMs: number): boolean {
  return p.flicker && Math.floor(elapsedMs / FLICKER_HALF_PERIOD_MS) % 2 === 1;
}
