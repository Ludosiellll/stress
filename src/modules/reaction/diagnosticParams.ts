import type { GoNoGoParams } from './gonogo';
import type { PomehParams } from './pomeh';
import type { PzmrParams } from './pzmr';
import type { RdoParams } from './rdo';
import type { StroopParams } from './stroop';
import type { SzmrParams } from './szmr';
import type { TaskSwitchParams } from './taskswitch';

/** Parameters of every reaction module's diagnostic block (ReactionModuleId keys). */
export interface DiagnosticParams {
  pzmr: PzmrParams;
  szmr: SzmrParams;
  gonogo: GoNoGoParams;
  rdo: RdoParams;
  pomeh: PomehParams;
  stroop: StroopParams;
  taskswitch: TaskSwitchParams;
}

/** `T` with every field read-only, all the way down; arrays become read-only arrays. */
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** Freezes `v` and everything it holds; the type says so too. */
function deepFreeze<T>(v: T): DeepReadonly<T> {
  if (typeof v === 'object' && v !== null) {
    for (const inner of Object.values(v)) deepFreeze(inner);
    Object.freeze(v);
  }
  return v as DeepReadonly<T>;
}

/**
 * What the diagnostic and the test-format runs play: params(fixedL) of 0.2.0 written out, so that a change to a
 * module's training levels never changes what the diagnostic measures. A task that adds a field to a module's
 * parameters adds it here with the value that keeps the block as in 0.2.0 (the snapshot in session/blocks.test.ts).
 * switchProb is the literal 0.3 (params(5) gave 0.30000000000000004): round(0.3 · 47) = 14 switches all the same.
 */
export const DIAGNOSTIC_PARAMS: DeepReadonly<DiagnosticParams> = deepFreeze<DiagnosticParams>({
  pzmr: { windowMs: 1000, isiMin: 500, isiMax: 2500 },
  szmr: { windowMs: 1500, nColors: 2, nKeys: 2, shapeDistractor: false, inversion: false },
  gonogo: { windowMs: 446, noGoRatio: 0.2, noGoStimulus: 'green_circle' },
  rdo: { periodMs: 3000, toleranceMs: 60, isiMin: 800, isiMax: 1500 },
  pomeh: {
    windowMs: 456,
    mode: 'simple',
    isiMin: 500,
    isiMax: 2500,
    noise: { distractors: 7, lifetimeMs: 610, flicker: true, farOnly: true, forbidden: [{ shape: 'circle', color: 'red' }] },
    audio: null,
  },
  stroop: { windowMs: 1099, nColors: 3, incongruentRatio: 0.66, legend: true, isiMin: 500, isiMax: 2000 },
  taskswitch: { windowMs: 1369, rules: ['color', 'shape'], switchProb: 0.3, cueLeadMs: 475 },
});
