import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from 'react';
import { parseAnswer } from '../../modules/numseries/parse';
import type { SeriesAnswer, StepOf } from '../../session/steps';

export interface NumSeriesViewProps {
  step: StepOf<'numseries_block'>;
  /** e2e mode only: the answer goes into data-e2e-answer for the test bot. */
  exposeAnswer: boolean;
  /** The answers are being saved: the field is locked. */
  busy: boolean;
  onSubmit: (answers: SeriesAnswer[]) => void;
}

const MAX_INPUT = 12;
const TICK_MS = 250;

/** «2, 5, −11, ?» with a real minus sign. */
function seriesText(shown: readonly number[]): string {
  return [...shown.map((n) => (n < 0 ? `−${String(-n)}` : String(n))), '?'].join(', ');
}

/**
 * Number series one item at a time. Enter takes the answer if it is a whole number; otherwise the hint
 * asks for one and the item stays. The item's own limit (training, R36) or the total limit (diagnostic) is
 * shown as a bar with the seconds left; when it runs out the item gets no answer (and with the total limit,
 * so do the items not reached). After the last item the answers go to `onSubmit`.
 */
export default function NumSeriesView({ step, exposeAnswer, busy, onSubmit }: NumSeriesViewProps) {
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

  /** Records the current item and moves on; `totalExpired` ends the block (the items not reached get null). */
  const record = (given: number | null, totalExpired: boolean): void => {
    if (finished.current) return;
    const item = items[index];
    if (item === undefined) return;
    const now = performance.now();
    answers.current.push({ itemId: item.id, given, timeMs: now - itemStart.current });
    if (totalExpired) {
      for (const rest of items.slice(index + 1)) answers.current.push({ itemId: rest.id, given: null, timeMs: 0 });
    }
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

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || e.repeat) return;
    e.preventDefault();
    const given = parseAnswer(text);
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
      <div className="series-item" data-e2e-answer={exposeAnswer ? String(item.answer) : undefined}>
        <p className="series-text">{seriesText(item.shown)}</p>
      </div>
      <input
        type="text"
        inputMode="numeric"
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
          Введи целое число
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
