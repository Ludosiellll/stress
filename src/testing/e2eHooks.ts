import type { Expected, TrialResult, TrialSpec } from '../engine/reaction/types';
import type { ReactionModuleId } from '../engine/types';
import type { FrameClock } from '../runtime/frameClock';
import type { StimulusRenderer } from '../runtime/reactionRunner';

/**
 * Hooks for the Playwright tests (Task 17), active only with `?e2e=1` in the address. Then
 * `window.__trainer` lets a test follow the stimuli and read the last block's results, and `&scale=0.02`
 * shrinks segment budgets and block sizes. In normal use nothing is exposed and every call is a no-op.
 */

export interface StimulusEvent {
  module: ReactionModuleId;
  expected: Expected;
  /** Frame timestamp of the stimulus onset (performance.now() time base). */
  onset: number;
}

/** `window.__trainer`. */
export interface TrainerApi {
  readonly scale: number;
  onStimulus(cb: (e: StimulusEvent) => void): void;
  /** resolveBlock results of the last finished reaction block; null before the first one. */
  lastResults: TrialResult[] | null;
}

declare global {
  interface Window {
    __trainer?: TrainerApi;
  }
}

/** The part of `window` the hooks use (tests pass a plain object). */
export interface E2eHost {
  location: { search: string };
  __trainer?: TrainerApi;
}

export interface E2eHooks {
  readonly enabled: boolean;
  /** SessionController scale; 1 unless e2e mode sets `scale=`. */
  readonly scale: number;
  emitStimulus(e: StimulusEvent): void;
  setLastResults(results: TrialResult[]): void;
}

const DISABLED: E2eHooks = {
  enabled: false,
  scale: 1,
  emitStimulus: () => undefined,
  setLastResults: () => undefined,
};

let active: E2eHooks = DISABLED;

function parseScale(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Reads the address once at startup (main.tsx) and exposes `__trainer` in e2e mode. */
export function installE2eHooks(host: E2eHost): E2eHooks {
  const params = new URLSearchParams(host.location.search);
  if (params.get('e2e') !== '1') {
    delete host.__trainer;
    active = DISABLED;
    return active;
  }
  const listeners: Array<(e: StimulusEvent) => void> = [];
  const trainer: TrainerApi = {
    scale: parseScale(params.get('scale')),
    onStimulus(cb) {
      listeners.push(cb);
    },
    lastResults: null,
  };
  host.__trainer = trainer;
  active = {
    enabled: true,
    scale: trainer.scale,
    emitStimulus(e) {
      for (const cb of listeners) {
        try {
          cb(e);
        } catch {
          // A broken test subscriber must not stop the block.
        }
      }
    },
    setLastResults(results) {
      trainer.lastResults = results;
    },
  };
  return active;
}

/** The hooks installed at startup (disabled until then). */
export function e2eHooks(): E2eHooks {
  return active;
}

/**
 * In e2e mode wraps the block's clock and renderer so that every `show` is followed by a stimulus event
 * with that frame's timestamp (the onset the runner records). Otherwise returns them unchanged.
 */
export function instrumentBlock(
  hooks: E2eHooks,
  module: ReactionModuleId,
  specs: readonly TrialSpec[],
  base: { clock: FrameClock; renderer: StimulusRenderer },
): { clock: FrameClock; renderer: StimulusRenderer } {
  if (!hooks.enabled) return base;
  let frameTs = 0;
  let shown = 0;
  const clock: FrameClock = {
    request: (cb) =>
      base.clock.request((ts) => {
        frameTs = ts;
        cb(ts);
      }),
    cancel: (id) => {
      base.clock.cancel(id);
    },
  };
  const renderer: StimulusRenderer = {
    show(s) {
      base.renderer.show(s);
      const spec = specs[shown++];
      if (spec !== undefined) hooks.emitStimulus({ module, expected: spec.expected, onset: frameTs });
    },
    hide() {
      base.renderer.hide();
    },
    tick(ms) {
      base.renderer.tick(ms);
    },
  };
  return { clock, renderer };
}
