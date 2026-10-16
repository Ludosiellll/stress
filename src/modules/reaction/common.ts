import type { AudioStressorParams } from '../../engine/audio/stressors';
import { keyLabel, layoutKeys } from '../../engine/layouts';
import type { VisualNoiseParams } from '../../engine/noise';
import { COLOR_IDS, SHAPE_IDS, type ColorId, type ShapeId, type TrialSpec } from '../../engine/reaction/types';
import type { Rng } from '../../engine/rng';
import type { InputKey, LayoutId, ReactionModuleId } from '../../engine/types';
import { FLOOR_FACTOR, type FloorBand } from '../../engine/windowFloor';

/** One band of a module's load ladder (F3): what the block plays, as the texts name it, and how its window floor follows. */
export interface LoadBand extends FloorBand {
  label: string;
}

export interface ReactionModule<P> {
  id: ReactionModuleId;
  title: string;
  /**
   * `overload`: an overload block, whose prefix announces the sound on every trial, so the module leaves out its own
   * sound line (M2). Method syntax (bivariant in P) so a ReactionModule<XParams> fits the registry's ReactionModule<unknown>.
   */
  instruction(layout: LayoutId, p: P, overload?: boolean): string;
  lNorm: number;
  /** The block size of the test format (the first bands); a block plays `trials(params)`. */
  blockSize: number;
  /** The load ladder, one band every 4 levels (F3, spec §3.1.3); absent: the module has no bands (РДО). */
  bands?: readonly LoadBand[];
  /**
   * Parameters at level L: the load of band `loadBand` (default bandIndex(L); past the ladder, its last band) and the
   * nominal window of L. Modules without bands ignore `loadBand`.
   */
  params(L: number, loadBand?: number): P;
  /** Trials in a block at these parameters. */
  trials(p: P): number;
  /**
   * The CV_all limit of the stability rule (F2): above it ΔL is capped at +0.5. The same at every level (spec §2.2);
   * null: no rule (РДО).
   */
  cvMax: number | null;
  generateBlock(p: P, rng: Rng, layout: LayoutId, size?: number): TrialSpec[];
  /**
   * The parameters with the key mapping of a training or free segment (F9, Справочник): a function of `seed` (one per
   * segment) and of the colours and keys these parameters play, so the overload block and a new band inside the segment
   * take theirs from the same seed. The trials then differ from the canonical ones (mapping null, Р26) by their keys
   * only. Absent: the module maps no keys.
   */
  withMapping?(p: P, seed: number): P;
  /** Keys a block at these parameters needs (layoutKeys(layout, keyCount(p))). */
  keyCount(p: P): number;
  /** Key hint shown under the stimulus during the block, e.g. «красный — F · зелёный — J»; null or absent: none. */
  legend?(layout: LayoutId, p: P): string | null;
  /** Russian labels for the "what changed" view. */
  describeParams(p: P): Array<{ label: string; value: string }>;
  /** Visual noise and sound of a block at these parameters; absent: none (read it with stressorsOf). */
  stressors?(p: P): BlockStressors;
  /**
   * Modules with trial conditions (COND_PAIRS): the fewest trials one condition can get in a block of `size` at
   * these parameters, whatever the seed. The e2e scale sizes such blocks by it (W2-R30).
   */
  minCondTrials?(p: P, size: number): number;
}

/** What plays around the stimuli of a reaction block. */
export interface BlockStressors {
  /** Distractors (and flicker) around the centre, on the trials `noiseGate` names, whatever `gate` (W2-R10). */
  noise: VisualNoiseParams | null;
  /** Sound loop in the headphones. */
  audio: AudioStressorParams | null;
  /** Trials the sound plays on: every trial, or the `noisy` ones. */
  gate: 'all' | 'noisy';
  /** Trials the noise shows on: the `noisy` ones (Помехоустойчивость, W2), or every trial (the other modules, F3). */
  noiseGate: 'noisy' | 'all';
}

export const NO_STRESSORS: BlockStressors = Object.freeze({ noise: null, audio: null, gate: 'all', noiseGate: 'noisy' });

/** The module's stressors at these parameters; NO_STRESSORS for a module without any. */
export function stressorsOf<P>(m: ReactionModule<P>, p: P): BlockStressors {
  return m.stressors?.(p) ?? NO_STRESSORS;
}

/** Stimulus colors in the order the color → key mapping uses; never grey, the noise's own colour (Р13). */
export const COLORS: readonly ColorId[] = COLOR_IDS.filter((c) => c !== 'gray');
export const SHAPES: readonly ShapeId[] = SHAPE_IDS;

export const COLOR_NAMES: Readonly<Record<ColorId, string>> = {
  red: 'красный',
  green: 'зелёный',
  yellow: 'жёлтый',
  blue: 'синий',
  white: 'белый',
  purple: 'фиолетовый',
  gray: 'серый',
};

/** A load band every this many levels (F3). */
export const LEVELS_PER_BAND = 4;

/** The floor factors of the four tail bands after a ladder's table (spec §3.1.3). */
export const TAIL_FLOOR_FACTORS: readonly number[] = [1.15, 1.1, 1.05, 1];

/**
 * A ladder from its table, [label, chain] per band, and the tail: four more bands with the last load and label,
 * chain 1.0 and the floor factors TAIL_FLOOR_FACTORS. The table's bands take FLOOR_FACTOR.
 */
export function ladder(table: ReadonlyArray<readonly [label: string, chain: number]>): readonly LoadBand[] {
  const bands = table.map(([label, chain]): LoadBand => ({ label, chain, floorFactor: FLOOR_FACTOR }));
  const last = (bands.at(-1) as LoadBand).label;
  return Object.freeze([...bands, ...TAIL_FLOOR_FACTORS.map((floorFactor): LoadBand => ({ label: last, chain: 1, floorFactor }))]);
}

/** The load band of level L: ⌊L/4⌋, capped at the ladder's last band (Р15); 0 for a module without bands. */
export function bandIndex(m: { readonly bands?: readonly LoadBand[] }, L: number): number {
  return m.bands === undefined ? 0 : loadBandOf(m.bands, L);
}

/** The band whose load a block plays: `loadBand` (default bandIndex(L)) within the ladder. */
export function loadBandOf(bands: readonly LoadBand[], L: number, loadBand?: number): number {
  return Math.max(0, Math.min(loadBand ?? Math.floor(L / LEVELS_PER_BAND), bands.length - 1));
}

/** What the parameters of every band module carry: the load band played, its label and the window. */
export interface BandFields {
  band: number;
  bandLabel: string;
  windowMs: number;
}

/** The band fields of a band module's parameters: the band, its label and the nominal window of L. */
export function bandFields(bands: readonly LoadBand[], band: number, windowMs: number): BandFields {
  return { band, bandLabel: (bands[band] as LoadBand).label, windowMs };
}

/**
 * The parameters with the window a block plays (F3): the nominal window or round(floor), whichever is larger; the
 * parameters themselves without a floor.
 */
export function withFloor<P extends BandFields>(p: P, floor: number | null): P {
  return floor === null ? p : { ...p, windowMs: Math.max(p.windowMs, Math.round(floor)) };
}

/** Trials in a block of the bands that lengthen it: 30, 45 and 60 from band `from` on (spec §3.1.3). */
export function longBlockTrials(band: number, from: number, base: number): number {
  if (band >= from + 2) return 60;
  if (band === from + 1) return 45;
  return band === from ? 30 : base;
}

/** «Зрительные помехи, далеко» outside Помехоустойчивость (Р12): 6 figures changing every 600 ms, no flicker, far only. */
export function farNoise(forbidden: VisualNoiseParams['forbidden']): VisualNoiseParams {
  return { distractors: 6, lifetimeMs: 600, flicker: false, farOnly: true, forbidden: forbidden.map((f) => ({ ...f })) };
}

/** «+ звук» outside Помехоустойчивость (Р12): hum and beeps at 0.6, on every trial. */
export function bandSound(): AudioStressorParams {
  return { layers: ['hum', 'beeps'], gain: 0.6 };
}

/** The stressors of a band module outside Помехоустойчивость: noise and sound on every trial (Р12). */
export function everyTrial(p: { noise: VisualNoiseParams | null; audio: AudioStressorParams | null }): BlockStressors {
  return { noise: p.noise, audio: p.audio, gate: 'all', noiseGate: 'all' };
}

/**
 * The instruction's notes on the noise and the sound a band module plays on every trial. An overload block leaves out
 * the sound note: its prefix announces the sound (M2).
 */
export function stressorNotes(p: { noise: VisualNoiseParams | null; audio: AudioStressorParams | null }, overload: boolean): string {
  return (
    (p.noise === null ? '' : ' Вокруг будут появляться другие фигуры, на них не реагируй.') +
    (p.noise?.flicker === true ? ' Вместе с фигурами будет мерцать фон.' : '') +
    (p.audio === null || overload ? '' : ' В блоке будут звуковые помехи, надень наушники.')
  );
}

/**
 * Per trial, whether it lies in a framed run: runs of rng.int(8, 15) trials take turns, the first unframed (the СЗМР
 * inversion, the reverse Stroop rule).
 */
export function framedRuns(n: number, rng: Rng): boolean[] {
  const flags: boolean[] = [];
  let framed = false;
  while (flags.length < n) {
    const len = rng.int(8, 15);
    for (let i = 0; i < len && flags.length < n; i++) flags.push(framed);
    framed = !framed;
  }
  return flags;
}

/** The most framed trials framedRuns(n) can give: unframed runs of 8 and framed runs of 15 from the start. */
export function maxFramed(n: number): number {
  const period = 8 + 15;
  return 15 * Math.floor(n / period) + Math.max(0, (n % period) - 8);
}

/** ISI range shared by ПЗМР (bands 0–1), СЗМР and Помехоустойчивость; Go/No-Go starts from it and speeds up (F8). */
export const ISI_MIN = 500;
export const ISI_MAX = 2500;

export function blockLength(size: number | undefined, blockSize: number): number {
  const n = size ?? blockSize;
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`block size must be a positive integer, got ${String(n)}`);
  }
  return n;
}

export function keysFor(layout: LayoutId, n: number): InputKey[] {
  return layoutKeys(layout, n).keys;
}

/** The single-key label, e.g. «Пробел». */
export function singleKeyLabel(layout: LayoutId): string {
  return keyLabel(keysFor(layout, 1)[0] as InputKey);
}

/** « Для этого уровня нужны клавиши: …» when the layout cannot serve n keys, otherwise ''. */
export function fallbackNote(layout: LayoutId, n: number): string {
  const { keys, effectiveLayout } = layoutKeys(layout, n);
  if (effectiveLayout === layout) return '';
  return ` Для этого уровня нужны клавиши: ${keys.map(keyLabel).join(', ')}.`;
}

/** The key numbers 0 … n − 1, in order: the canonical mapping a segment's mapping shuffles (F9). */
export function keyNumbers(n: number): number[] {
  return Array.from({ length: n }, (_, k) => k);
}

export const ms = (v: number): string => `${String(v)} мс`;
export const percent = (ratio: number): string => `${String(Math.round(ratio * 100))} %`;
