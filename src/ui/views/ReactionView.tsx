import { useEffect, useEffectEvent, useRef } from 'react';
import { STRESSOR_LOOP_S } from '../../engine/audio/stressors';
import { resolveBlock } from '../../engine/reaction/resolve';
import type { BlockTimeline } from '../../engine/reaction/types';
import { prepareQuietly } from '../../runtime/audio/audioOut';
import { createCanvasRenderer, type CanvasRenderer } from '../../runtime/canvasRenderer';
import { attachFocusGuard } from '../../runtime/focusGuard';
import { browserFrameClock } from '../../runtime/frameClock';
import { attachInput } from '../../runtime/input';
import { ReactionBlockRunner, type AbortReason, type StimulusRenderer } from '../../runtime/reactionRunner';
import type { StepOf } from '../../session/steps';
import { e2eHooks, instrumentBlock } from '../../testing/e2eHooks';
import { useApp } from '../AppContext';

export interface ReactionViewProps {
  step: StepOf<'reaction_block'>;
  /** Measured display frame interval (pre-session check). */
  nominalFrameMs: number;
  onDone: (timeline: BlockTimeline) => void;
  /** focus_lost: the window lost focus; user: Escape. */
  onAbort: (reason: AbortReason) => void;
  /** Drawing failed; the screen is already cleared. */
  onError: (error: unknown) => void;
}

function hideQuietly(renderer: StimulusRenderer): void {
  try {
    renderer.hide();
  } catch {
    // The canvas is already failing; the error being reported is the first one.
  }
}

/**
 * A block with sound waits for the audio context to resume (the instruction's key press asked for it a moment
 * earlier), but no longer than this: a resume() that never settles must not hold the block.
 */
export const UNLOCK_WAIT_MS = 500;

/** Where in the 20 s loop the block's sound starts, s: (seed mod 20 000) / 1000. */
const loopOffsetS = (seed: number): number => (seed % (STRESSOR_LOOP_S * 1000)) / 1000;

/**
 * Plays one reaction block on a full-screen canvas: no controls, hidden cursor, nothing but the stimulus
 * (and the module's key legend at the bottom, when the level shows one).
 *
 * Order (so that no event is lost or misattributed): renderer → sound buffer → runner → focus guard (may abort at
 * once) → Escape listener; then, in the next task — after the key event that opened the block has been fully
 * dispatched — input, the sound loop (silent until a trial switches it on) and `start()`. A block with sound first
 * waits for `audio.unlock()` (at most UNLOCK_WAIT_MS), so the loop does not find the context still suspended; a block
 * without sound starts exactly as before. Everything is released, and the sound faded out, when the block ends or the
 * view unmounts. If the sound cannot be built or started, the block runs silently and reports `audioPlayed: false`.
 *
 * Stressors (`step.layers`): from the wait before trial i, the visual noise is on when its gate (`noiseGate`) is 'all'
 * or trial i is `noisy` (W2-R10), the sound when the gate is 'all' or trial i is `noisy`. A block with sound reports
 * whether it played.
 */
export default function ReactionView({ step, nominalFrameMs, onDone, onAbort, onError }: ReactionViewProps) {
  const { audio } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const done = useEffectEvent(onDone);
  const aborted = useEffectEvent(onAbort);
  const failed = useEffectEvent(onError);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const hooks = e2eHooks();
    const { layers, specs } = step;
    let disposed = false;

    let base: CanvasRenderer;
    try {
      base = createCanvasRenderer(canvas, layers.noise === null ? {} : { noise: { params: layers.noise, seed: layers.seed } });
    } catch (e) {
      const timer = setTimeout(() => {
        failed(e);
      }, 0);
      return () => {
        clearTimeout(timer);
      };
    }
    // Synthesized here, before the runner exists: nothing is built or loaded while the block runs.
    const sound = layers.audio === null ? null : prepareQuietly(audio, layers.audio, layers.seed);
    let audioPlayed = false;
    const noisy = (i: number): boolean => specs[i]?.cond === 'noisy';
    const { clock, renderer } = instrumentBlock(hooks, step.module, specs, { clock: browserFrameClock, renderer: base });
    const runner = new ReactionBlockRunner({
      specs,
      clock,
      renderer,
      nominalFrameMs,
      onTrial: (i) => {
        base.setNoiseActive(layers.noise !== null && (layers.noiseGate === 'all' || noisy(i)));
        sound?.setActive(layers.gate === 'all' || noisy(i));
      },
    });

    let stopped = false;
    let offInput: (() => void) | null = null;
    const offGuard = attachFocusGuard(window, document, () => {
      stopped = true;
      runner.abort('focus_lost');
    });
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.repeat) return;
      e.preventDefault();
      stopped = true;
      runner.abort('user');
    };
    window.addEventListener('keydown', onEscape, { capture: true });
    const release = (): void => {
      sound?.stop();
      offInput?.();
      offInput = null;
      offGuard();
      window.removeEventListener('keydown', onEscape, { capture: true });
    };

    let begun = false;
    let unlockWait: ReturnType<typeof setTimeout> | undefined;
    const begin = (): void => {
      clearTimeout(unlockWait);
      if (begun || disposed) return;
      begun = true;
      if (!stopped) {
        offInput = attachInput(window, step.layout, new Set(step.keys), (p) => {
          runner.press(p);
        });
        audioPlayed = sound?.start(loopOffsetS(layers.seed)) ?? false;
      }
      runner.start().then(
        (end) => {
          release();
          if (disposed) return;
          if (end.kind === 'aborted') {
            aborted(end.reason);
            return;
          }
          if (hooks.enabled) hooks.setLastResults(resolveBlock(specs, end.timeline));
          done(layers.audio === null ? end.timeline : { ...end.timeline, audioPlayed });
        },
        (e: unknown) => {
          release();
          hideQuietly(base);
          if (!disposed) failed(e);
        },
      );
    };

    const timer = setTimeout(() => {
      if (sound === null) {
        begin();
        return;
      }
      unlockWait = setTimeout(begin, UNLOCK_WAIT_MS);
      // unlock() never rejects by contract; a rejection still starts the block (silently) at once.
      audio.unlock().then(begin, begin);
    }, 0);

    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(unlockWait);
      runner.abort('user');
      release();
    };
  }, [step, nominalFrameMs, audio]);

  return (
    <div className="reaction">
      <canvas ref={canvasRef} />
      {step.legend !== null && <p className="reaction-legend">{step.legend}</p>}
    </div>
  );
}
