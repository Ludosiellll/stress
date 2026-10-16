import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from 'react';
import { ALPHABET, letterFromKey, letterPosition } from '../../modules/numseries/letters';
import { parseAnswer } from '../../modules/numseries/parse';
import { SERIES_LETTER_HINT, type SeriesAnswer, type StepOf } from '../../session/steps';

export interface NumSeriesViewProps {
  step: StepOf<'numseries_block'>;
  /** e2e mode only: the answer goes into data-e2e-answer for the test bot. */
  exposeAnswer: boolean;
  /** The answers are being saved: the field is locked. */
  busy: boolean;
  /** After each item: items done / items and the answers so far (F11: Escape sends them). */
  onProgress: (p: number, answered: readonly SeriesAnswer[]) => void;
  onSubmit: (answers: SeriesAnswer[]) => void;
}

const MAX_INPUT = 12;
const TICK_MS = 250;

/** The letter at a position 1…32. */
const letterAt = (position: number): string => ALPHABET[position - 1] ?? '?';

/** «2, 5, −11, ?» with a real minus sign; a letter item «В, Д, Ж, ?». */
function seriesText(shown: readonly number[], letters: boolean): string {
  const term = (n: number): string => (letters ? letterAt(n) : n < 0 ? `−${String(-n)}` : String(n));
  return [...shown.map(term), '?'].join(', ');
}

/**
 * Number series one item at a time. Enter takes the answer if it is a whole number (a letter item: a letter, typed by
 * its key on any layout, stored as its position, F12); otherwise the hint asks for one and the item stays. Space skips
 * the item: no answer, `skipped`, a wrong one (F12). The item's own limit (training, R36) or the total limit
 * (diagnostic) is shown as a bar with the seconds left; when it runs out the item gets no answer (and with the total
 * limit, so do the items not reached). After the last item the answers go to `onSubmit`.
 */
export default function NumSeriesView({ step, exposeAnswer, busy, onProgress, onSubmit }: NumSeriesViewProps) {
  const { items, totalLimitMs } = step;
  const [index, setIndex] = useState(0);
  const [text, setText] = useState('');
  const [hint, setHint] = useState(false);
  /** The current item's limit; null for diagnostic items, where the total limit runs instead. */
  const itemLimitMs = items[index]?.timeLimitMs ?? null;
  const limitMs = itemLimitMs ?? totalLimitMs;
  /** Time left as of the last tick, and for which item (a per-item limit starts full on every item). */
  const [left, setLeft] = useState<{ index: number; ms: number } | null>(null);

  const answers = useRef<SeriesAnswer[]>([]);
  const blockStart = useRef<number | null>(null);
  const itemStart = useRef(0);
  const finished = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  // Focus follows the field whenever it is usable (it may mount locked while the block is being opened).
  useEffect(() => {
    if (!busy) input.current?.focus();
  }, [busy, index]);

  /**
   * Records the current item and moves on; `totalExpired` ends the block (the items not reached get null), `skipped`
   * marks a Space.
   */
  const record = (given: number | null, totalExpired: boolean, skipped = false): void => {
    if (finished.current) return;
    const item = items[index];
    if (item === undefined) return;
    const now = performance.now();
    answers.current.push({ itemId: item.id, given, timeMs: now - itemStart.current, ...(skipped ? { skipped } : {}) });
    if (totalExpired) {
      for (const rest of items.slice(index + 1)) answers.current.push({ itemId: rest.id, given: null, timeMs: 0 });
    }
    onProgress(answers.current.length / items.length, [...answers.current]);
    if (totalExpired || index + 1 >= items.length) {
      finished.current = true;
      onSubmit([...answers.current]);
      return;
    }
    setIndex(index + 1);
    setText('');
    setHint(false);
  };
  const onTimeout = useEffectEvent(() => {
    record(null, itemLimitMs === null);
  });

  useEffect(() => {
    const now = performance.now();
    blockStart.current ??= now;
    itemStart.current = now;
    const deadline =
      itemLimitMs !== null ? now + itemLimitMs : totalLimitMs !== null ? blockStart.current + totalLimitMs : null;
    if (deadline === null) return;
    const tick = setInterval(() => {
      setLeft({ index, ms: Math.max(0, deadline - performance.now()) });
    }, TICK_MS);
    const expire = setTimeout(() => {
      onTimeout();
    }, deadline - now);
    return () => {
      clearInterval(tick);
      clearTimeout(expire);
    };
  }, [index, itemLimitMs, totalLimitMs]);

  const letters = items[index]?.family === 'letters';

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) record(null, false, true);
      return;
    }
    if (letters && e.key !== 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const letter = letterFromKey(e);
      if (letter !== null) {
        e.preventDefault();
        setText(letter);
      }
      return;
    }
    if (e.key !== 'Enter' || e.repeat) return;
    e.preventDefault();
    const given = letters ? letterPosition(text.trim()) : parseAnswer(text);
    if (given === null) {
      setHint(true);
      return;
    }
    record(given, false);
  };

  const item = items[index];
  if (item === undefined) return null;
  const leftMs = left !== null && (left.index === index || itemLimitMs === null) ? left.ms : limitMs;
  return (
    <div className="screen-center series">
      <p className="muted">
        Задача {index + 1} из {items.length}
      </p>
      <div
        className="series-item"
        data-answer-kind={letters ? 'letter' : 'number'}
        data-e2e-answer={exposeAnswer ? (letters ? letterAt(item.answer) : String(item.answer)) : undefined}
      >
        <p className="series-text">{seriesText(item.shown, letters)}</p>
      </div>
      {letters && <p className="muted">{SERIES_LETTER_HINT}</p>}
      <input
        type="text"
        inputMode={letters ? 'text' : 'numeric'}
        aria-label="Ответ"
        className="series-input"
        ref={input}
        autoComplete="off"
        maxLength={MAX_INPUT}
        disabled={busy}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      {hint && (
        <p role="alert" className="warning">
          {letters ? 'Введи букву' : 'Введи целое число'}
        </p>
      )}
      {limitMs !== null && leftMs !== null && (
        <div className="timebar-wrap">
          <div className="timebar" aria-hidden="true">
            <div className="timebar-fill" style={{ width: `${String((100 * leftMs) / limitMs)}%` }} />
          </div>
          <p className="muted">Осталось: {Math.ceil(leftMs / 1000)} с</p>
        </div>
      )}
    </div>
  );
}
