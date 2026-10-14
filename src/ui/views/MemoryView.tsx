import { useEffect, useEffectEvent, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { digitFromKey, letterFromKey } from '../../modules/memory/input';
import { spanProtocolStops, type MemoryAnswer } from '../../modules/memory/score';
import { attachFocusGuard } from '../../runtime/focusGuard';
import { browserFrameClock } from '../../runtime/frameClock';
import { presentMemoryTrial } from '../../runtime/memoryPresenter';
import { createMemoryRenderer } from '../../runtime/memoryRenderer';
import type { StepOf } from '../../session/steps';
import { isEnter, useKeyDown } from '../keys';

export interface MemoryViewProps {
  step: StepOf<'memory_block'>;
  /** e2e mode only: the row goes into data-e2e-answer for the test bot. */
  exposeAnswer: boolean;
  /** The answers are being saved: input is locked. */
  busy: boolean;
  onSubmit: (answers: MemoryAnswer[]) => void;
  /** The block is void. The view itself reports focus_lost (the window lost focus); Escape is the session screen's. */
  onAbort: (reason: 'focus_lost' | 'user') => void;
}

type Phase = 'present' | 'respond';

/**
 * A memory block, one trial at a time: the row is shown on a full-screen canvas (presentMemoryTrial, frame
 * timing, no cursor), then reproduced on a DOM screen — typed (digits, letters, card: Backspace erases, Enter
 * sends) or clicked (positions: a click on the last chosen cell takes it back; Enter or «Готово» sends).
 * After the last trial every answer goes to `onSubmit`; the span protocol sends them as soon as it stops
 * (spanProtocolStops). The focus guard covers the whole block; Escape is the session screen's (it pauses and
 * discards the block, as for tables).
 */
export default function MemoryView({ step, exposeAnswer, busy, onSubmit, onAbort }: MemoryViewProps) {
  const { trials } = step;
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('present');
  const [given, setGiven] = useState<string[]>([]);
  /** Answers sent or the block lost: nothing more is taken and nothing more is shown. */
  const [over, setOver] = useState(false);
  const [crash, setCrash] = useState<Error | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const answers = useRef<MemoryAnswer[]>([]);
  const respondStart = useRef(0);
  /** All answers went to onSubmit: the block is over, focus no longer matters. */
  const sent = useRef(false);
  const aborted = useEffectEvent(onAbort);

  useEffect(
    () =>
      attachFocusGuard(window, document, () => {
        if (sent.current) return;
        setOver(true);
        aborted('focus_lost');
      }),
    [],
  );

  const trial = trials[index];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (phase !== 'present' || trial === undefined || canvas === null || over) return;
    const ac = new AbortController();
    // Async, so a canvas without a 2D context rejects like a failed frame.
    const show = async (): Promise<'done' | 'aborted'> =>
      presentMemoryTrial(trial, browserFrameClock, createMemoryRenderer(canvas), ac.signal);
    show().then(
      (end) => {
        if (end !== 'done') return;
        respondStart.current = performance.now();
        setPhase('respond');
      },
      (e: unknown) => {
        setCrash(e instanceof Error ? e : new Error(String(e)));
      },
    );
    return () => {
      ac.abort();
    };
  }, [phase, trial, over]);

  // A drawing failure goes to the session's error boundary (logged; stored blocks stay stored).
  if (crash !== null) throw crash;

  const locked = busy || phase !== 'respond' || over;

  const send = (): void => {
    // One answer per trial, even if Enter comes twice before the next render.
    if (locked || trial === undefined || answers.current.length !== index) return;
    answers.current.push({ given, timeMs: performance.now() - respondStart.current });
    setGiven([]);
    // The span protocol (diagnostics) ends as soon as both rows of a length are wrong.
    const stopped = step.protocol === 'span' && spanProtocolStops(trials, answers.current);
    if (stopped || index + 1 >= trials.length) {
      sent.current = true;
      setOver(true);
      onSubmit([...answers.current]);
      return;
    }
    setIndex(index + 1);
    setPhase('present');
  };

  useKeyDown(
    (e) => {
      if (trial === undefined || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isEnter(e)) {
        e.preventDefault();
        send();
        return;
      }
      if (trial.mode === 'positions') return;
      if (e.key === 'Backspace') {
        e.preventDefault();
        setGiven((g) => g.slice(0, -1));
        return;
      }
      const x = trial.mode === 'letters' ? letterFromKey(e) : digitFromKey(e);
      if (x === null) return;
      e.preventDefault();
      setGiven((g) => [...g, x]);
    },
    !locked,
  );

  const onCell = (cell: string, e: MouseEvent): void => {
    e.preventDefault();
    if (locked || e.button !== 0) return;
    setGiven((g) => (g.at(-1) === cell ? g.slice(0, -1) : g.includes(cell) ? g : [...g, cell]));
  };

  if (trial === undefined) return null;
  const hideCursor = phase === 'present' || trial.mode !== 'positions';
  return (
    <div className={hideCursor ? 'memory memory-no-cursor' : 'memory'}>
      {phase === 'present' ? (
        <canvas ref={canvasRef} />
      ) : (
        <div
          className="memory-response screen-center"
          data-mode={trial.mode}
          data-e2e-answer={exposeAnswer ? trial.items.join(',') : undefined}
        >
          <p className="muted">
            Проба {index + 1} из {trials.length}
          </p>
          {trial.mode === 'positions' ? (
            <>
              <div
                role="group"
                aria-label="Клетки"
                className="memory-grid"
                style={{ '--size': trial.gridSide } as CSSProperties}
              >
                {Array.from({ length: trial.gridSide * trial.gridSide }, (_, i) => {
                  const cell = String(i);
                  const order = given.indexOf(cell);
                  return (
                    <button
                      key={cell}
                      type="button"
                      tabIndex={-1}
                      disabled={busy}
                      className={order >= 0 ? 'memory-cell chosen' : 'memory-cell'}
                      data-cell={cell}
                      onMouseDown={(e) => {
                        onCell(cell, e);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                      }}
                    >
                      {order >= 0 ? order + 1 : ''}
                    </button>
                  );
                })}
              </div>
              <div className="actions">
                <button type="button" className="primary" disabled={busy} onClick={send}>
                  Готово
                </button>
              </div>
            </>
          ) : (
            <p className="memory-typed" aria-label="Ответ" aria-live="polite">
              {[...given, ...Array.from({ length: Math.max(0, trial.items.length - given.length) }, () => '_')].map((x, i) => (
                <span key={i}>{x}</span>
              ))}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
