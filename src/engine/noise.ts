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

/** Radius of the central zone no figure enters, in side units (at the stimulus's own size). */
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

/** The colour the noise takes only when no stimulus colour is left (Р13). */
const NOISE_ONLY_COLOR: ColorId = 'gray';
const STIMULUS_COLORS: readonly ColorId[] = COLOR_IDS.filter((c) => c !== NOISE_ONLY_COLOR);

/**
 * The (shape, colour) pairs a distractor may take: those of the six stimulus colours, as in 0.2.0 (T-R1); grey ones
 * only when every stimulus colour is ruled out (СЗМР with six target colours, Р13).
 */
function allowedPairs(p: VisualNoiseParams): { shape: ShapeId; color: ColorId }[] {
  const targetColors = new Set(p.forbidden.map((f) => f.color));
  const pairsOf = (colors: readonly ColorId[]): { shape: ShapeId; color: ColorId }[] =>
    SHAPE_IDS.flatMap((shape) =>
      colors.flatMap((color) => {
        if (p.forbidden.some((f) => f.shape === shape && f.color === color)) return [];
        if (p.farOnly && (shape === 'circle' || targetColors.has(color))) return [];
        return [{ shape, color }];
      }),
    );
  const pairs = pairsOf(STIMULUS_COLORS);
  return pairs.length > 0 ? pairs : pairsOf([NOISE_ONLY_COLOR]);
}

/**
 * Where the stimulus is (F9, T-R63): its centre (x, y) and its scale, in side units. The central zone no figure enters
 * sits there and grows with it.
 */
export interface NoiseZone {
  x: number;
  y: number;
  scale: number;
}

/** An unshifted stimulus at its own size: the zone of 0.2.0 (diagnostics, Помехоустойчивость without a shift). */
const CENTRED: NoiseZone = Object.freeze({ x: 0, y: 0, scale: 1 });

/**
 * A point for a figure of diameter `size` inside the box (with a size/2 margin) whose distance from the zone's centre
 * is at least NOISE_EXCLUSION_RADIUS·scale + size/2, so that the whole figure stays out of the zone. After 20 misses: a
 * point on that circle at a random angle (the zone always wins over the box). The candidates are the same whatever the
 * zone: a figure moves only when the zone takes in, or lets go of, one of its candidates.
 */
function place(rng: Rng, size: number, box: { halfW: number; halfH: number }, zone: NoiseZone): { x: number; y: number } {
  const r = size / 2;
  const minDist = NOISE_EXCLUSION_RADIUS * zone.scale + r;
  for (let i = 0; i < PLACE_ATTEMPTS; i++) {
    const x = (2 * rng.next() - 1) * (box.halfW - r);
    const y = (2 * rng.next() - 1) * (box.halfH - r);
    if (Math.hypot(x - zone.x, y - zone.y) >= minDist) return { x, y };
  }
  const angle = 2 * Math.PI * rng.next();
  return { x: zone.x + minDist * Math.cos(angle), y: zone.y + minDist * Math.sin(angle) };
}

/**
 * The figures on screen `elapsedMs` after the noise started. Figure j in slot s is drawn from
 * createRng(deriveSeed(seed, `j:s`)): the same inputs give the same frame, and a figure stays put within its slot.
 * `box` is the half size of the canvas in side units (the shorter half side is 0.5); `zone` is where the stimulus is
 * (default: the centre at scale 1, the frames of 0.2.0).
 */
export function noiseFrame(
  p: VisualNoiseParams,
  seed: number,
  elapsedMs: number,
  box: { halfW: number; halfH: number },
  zone: NoiseZone = CENTRED,
): Distractor[] {
  const pairs = allowedPairs(p);
  if (pairs.length === 0) throw new RangeError('noiseFrame: every shape and colour pair is excluded');
  return noiseSlots(p, elapsedMs).map((slot, j) => {
    const rng = createRng(deriveSeed(seed, `${String(j)}:${String(slot)}`));
    const size = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * rng.next();
    return { ...place(rng, size, box, zone), size, ...rng.pick(pairs) };
  });
}

/** Whether the background shows its second shade at `elapsedMs`: never without flicker. */
export function flickerOn(p: VisualNoiseParams, elapsedMs: number): boolean {
  return p.flicker && Math.floor(elapsedMs / FLICKER_HALF_PERIOD_MS) % 2 === 1;
}
