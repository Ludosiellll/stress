import { useEffect, useEffectEvent, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { STRESSOR_LOOP_S } from '../../engine/audio/stressors';
import { digitFromKey, letterFromKey } from '../../modules/memory/input';
import { spanProtocolStops, type MemoryAnswer } from '../../modules/memory/score';
import { prepareQuietly, type QuietHandle } from '../../runtime/audio/audioOut';
import { attachFocusGuard } from '../../runtime/focusGuard';
import { browserFrameClock } from '../../runtime/frameClock';
import { presentMemoryTrial } from '../../runtime/memoryPresenter';
import { createMemoryRenderer, type MemoryRenderer } from '../../runtime/memoryRenderer';
import type { StepOf } from '../../session/steps';
import { useApp } from '../AppContext';
import { isEnter, useKeyDown } from '../keys';
import { UNLOCK_WAIT_MS } from './ReactionView';

export interface MemoryViewProps {
  step: StepOf<'memory_block'>;
  /** e2e mode only: the row goes into data-e2e-answer for the test bot. */
  exposeAnswer: boolean;
  /** The answers are being saved: input is locked. */
  busy: boolean;
  onSubmit: (answers: MemoryAnswer[]) => void;
  /** After each answer: answers / rows, the share of the block done (F11). */
  onProgress: (p: number) => void;
  /** The window lost focus: the block is void. Escape is the session screen's (it pauses the block). */
  onFocusLost: () => void;
}

type Phase = 'present' | 'respond';

/** The seed of the card's sound (F13): one loop for every card, built once and cached by the player. */
const CARD_SOUND_SEED = 13;
/** Where in the 20 s loop the card of trial i starts its sound, s: each card hears another stretch of it. */
const cardSoundOffsetS = (i: number): number => (i * 7) % STRESSOR_LOOP_S;

/**
 * The renderer of a trial with sound: the card's sound starts when the card is drawn and stops when the card goes, so
 * it plays only while the card is on screen (F13). Without a handle, the renderer as it is.
 */
function withCardSound(r: MemoryRenderer, sound: QuietHandle | null, offsetS: number): MemoryRenderer {
  if (sound === null) return r;
  return {
    ...r,
    card(t) {
      r.card(t);
      sound.start(offsetS);
      sound.setActive(true);
    },
    clear() {
      sound.stop();
      r.clear();
    },
  };
}

/**
 * A memory block, one trial at a time: the row is shown on a full-screen canvas (presentMemoryTrial, frame
 * timing, no cursor), then reproduced on a DOM screen — typed (digits, letters, card: Backspace erases, Enter
 * sends) or clicked (positions: a click on the last chosen cell takes it back; Enter or «Готово» sends). Enter on
 * an empty answer sends nothing and shows a hint; «Готово» is a deliberate click and sends even an empty one.
 * After the last trial every answer goes to `onSubmit`; the span protocol sends them as soon as it stops
 * (spanProtocolStops). The focus guard covers the whole block; Escape is the session screen's (it pauses and
 * discards the block, as for tables).
 *
 * A block with sound (a 3×3 card from L 21, F13) builds its sound first and waits for `audio.unlock()` (at most
 * UNLOCK_WAIT_MS) before the first trial; the sound plays only while a card is on screen. If it cannot be built or
 * started, the cards are shown without it.
 */
export default function MemoryView({ step, exposeAnswer, busy, onSubmit, onProgress, onFocusLost }: MemoryViewProps) {
  const { audio } = useApp();
  const { trials } = step;
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('present');
  const [given, setGiven] = useState<string[]>([]);
  /** The trial on which Enter came with nothing given: the hint shows until something is. */
  const [emptyEnter, setEmptyEnter] = useState<number | null>(null);
  /** Answers sent or the block lost: nothing more is taken and nothing more is shown. */
  const [over, setOver] = useState(false);
  const [crash, setCrash] = useState<Error | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const answers = useRef<MemoryAnswer[]>([]);
  const respondStart = useRef(0);
  /** All answers went to onSubmit: the block is over, focus no longer matters. */
  const sent = useRef(false);
  const focusLost = useEffectEvent(onFocusLost);
  /** The card's sound, built once for the block; null without sound or when it cannot be built. */
  const sound = useRef<QuietHandle | null>(null);
  /** The first trial may be shown: at once without sound, after the unlock (or its wait) with it. */
  const [ready, setReady] = useState(step.audio === null);

  useEffect(() => {
    if (step.audio === null) return;
    const handle = prepareQuietly(audio, step.audio, CARD_SOUND_SEED);
    sound.current = handle;
    let live = true;
    const go = (): void => {
      if (live) setReady(true);
    };
    const wait = setTimeout(go, UNLOCK_WAIT_MS);
    // unlock() never rejects by contract; a rejection still shows the cards (silently).
    audio.unlock().then(go, go);
    return () => {
      live = false;
      clearTimeout(wait);
      handle?.stop();
      sound.current = null;
    };
  }, [step, audio]);

  useEffect(
    () =>
      attachFocusGuard(window, document, () => {
        if (sent.current) return;
        setOver(true);
        focusLost();
      }),
    [],
  );

  const trial = trials[index];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!ready || phase !== 'present' || trial === undefined || canvas === null || over) return;
    const ac = new AbortController();
    const renderer = (): MemoryRenderer =>
      withCardSound(createMemoryRenderer(canvas), trial.sound ? sound.current : null, cardSoundOffsetS(index));
    // Async, so a canvas without a 2D context rejects like a failed frame.
    const show = async (): Promise<'done' | 'aborted'> => presentMemoryTrial(trial, browserFrameClock, renderer(), ac.signal);
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
  }, [ready, phase, trial, over, index]);

  // A drawing failure goes to the session's error boundary (logged; stored blocks stay stored).
  if (crash !== null) throw crash;

  const locked = busy || phase !== 'respond' || over;

  const send = (): void => {
    // One answer per trial, even if Enter comes twice before the next render.
    if (locked || trial === undefined || answers.current.length !== index) return;
    answers.current.push({ given, timeMs: performance.now() - respondStart.current });
    onProgress(answers.current.length / trials.length);
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
        // An Enter on an empty answer is most likely by accident: it would waste the trial.
        if (given.length === 0) setEmptyEnter(index);
        else send();
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
            {/* The span protocol usually stops well before its last row: no total there. */}
            {step.protocol === 'span' ? `Проба ${String(index + 1)}` : `Проба ${String(index + 1)} из ${String(trials.length)}`}
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
          {emptyEnter === index && given.length === 0 && (
            <p className="muted" role="status">
              {trial.mode === 'positions' ? 'Нажми клетки, потом Enter.' : 'Набери ответ, потом Enter.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
