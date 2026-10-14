import { useEffect, useEffectEvent, useRef } from 'react';
import { resolveBlock } from '../../engine/reaction/resolve';
import type { BlockTimeline } from '../../engine/reaction/types';
import { createCanvasRenderer } from '../../runtime/canvasRenderer';
import { attachFocusGuard } from '../../runtime/focusGuard';
import { browserFrameClock } from '../../runtime/frameClock';
import { attachInput } from '../../runtime/input';
import { ReactionBlockRunner, type AbortReason, type StimulusRenderer } from '../../runtime/reactionRunner';
import type { StepOf } from '../../session/steps';
import { e2eHooks, instrumentBlock } from '../../testing/e2eHooks';

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
 * Plays one reaction block on a full-screen canvas: no controls, hidden cursor, nothing but the stimulus.
 *
 * Order (so that no event is lost or misattributed): renderer → runner → focus guard (may abort at once) →
 * Escape listener; then, in the next task — after the key event that opened the block has been fully
 * dispatched — input and `start()`. Everything is released when the block ends or the view unmounts.
 */
export default function ReactionView({ step, nominalFrameMs, onDone, onAbort, onError }: ReactionViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const done = useEffectEvent(onDone);
  const aborted = useEffectEvent(onAbort);
  const failed = useEffectEvent(onError);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const hooks = e2eHooks();
    let disposed = false;

    let base: StimulusRenderer;
    try {
      base = createCanvasRenderer(canvas);
    } catch (e) {
      const timer = setTimeout(() => {
        failed(e);
      }, 0);
      return () => {
        clearTimeout(timer);
      };
    }
    const { clock, renderer } = instrumentBlock(hooks, step.module, step.specs, { clock: browserFrameClock, renderer: base });
    const runner = new ReactionBlockRunner({ specs: step.specs, clock, renderer, nominalFrameMs });

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
      offInput?.();
      offInput = null;
      offGuard();
      window.removeEventListener('keydown', onEscape, { capture: true });
    };

    const timer = setTimeout(() => {
      if (!stopped) {
        offInput = attachInput(window, step.layout, new Set(step.keys), (p) => {
          runner.press(p);
        });
      }
      runner.start().then(
        (end) => {
          release();
          if (disposed) return;
          if (end.kind === 'aborted') {
            aborted(end.reason);
            return;
          }
          if (hooks.enabled) hooks.setLastResults(resolveBlock(step.specs, end.timeline));
          done(end.timeline);
        },
        (e: unknown) => {
          release();
          hideQuietly(base);
          if (!disposed) failed(e);
        },
      );
    }, 0);

    return () => {
      disposed = true;
      clearTimeout(timer);
      runner.abort('user');
      release();
    };
  }, [step, nominalFrameMs]);

  return (
    <div className="reaction">
      <canvas ref={canvasRef} />
    </div>
  );
}
