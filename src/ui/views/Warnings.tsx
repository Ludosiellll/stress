import { useEffect, useEffectEvent, useState } from 'react';
import { measureRefresh } from '../../engine/timing';
import { useApp } from '../AppContext';
import { FALLBACK_FRAME_MS } from '../frameSampler';
import { useKeyDown } from '../keys';

export interface WarningsProps {
  /** Frame timestamps for about 1 s (requestAnimationFrame); stops when `signal` aborts. */
  measureFrames: (signal: AbortSignal) => Promise<number[]>;
  /** Measured frame interval in ms (60 Hz when the measurement failed). */
  onReady: (nominalFrameMs: number) => void;
  onBack: () => void;
}

const DROPPED_LIMIT = 0.05;

const HEADLINE = {
  battery: 'Подключи зарядку и включи режим максимальной производительности. Иначе время реакции будет измерено неточно.',
  dropping: 'Экран пропускает кадры. Закрой лишние программы и включи режим максимальной производительности.',
  failed: 'Не удалось проверить экран.',
} as const;

/** 0.075 → «7,5», 0.1 → «10». */
const percent = (ratio: number): string => String(Math.round(ratio * 1000) / 10).replace('.', ',');

type Check =
  | { kind: 'measuring' }
  | { kind: 'warn'; frameMs: number; battery: boolean; droppedRatio: number | null; failed: boolean };

/**
 * The pre-session check (spec §5): a short frame measurement and the power source. When the laptop is on
 * battery or frames drop, timings get worse, so the user is told and decides; otherwise the session goes on
 * by itself.
 */
export default function Warnings({ measureFrames, onReady, onBack }: WarningsProps) {
  const { platform } = useApp();
  const [check, setCheck] = useState<Check>({ kind: 'measuring' });
  const ready = useEffectEvent(onReady);

  useEffect(() => {
    const abort = new AbortController();
    const measure = async (): Promise<{ frameMs: number; droppedRatio: number | null }> => {
      try {
        const stats = measureRefresh(await measureFrames(abort.signal));
        return { frameMs: stats.intervalMs, droppedRatio: stats.droppedRatio };
      } catch {
        return { frameMs: FALLBACK_FRAME_MS, droppedRatio: null };
      }
    };
    void Promise.all([measure(), platform.powerCharging().catch(() => null)]).then(([frames, charging]) => {
      if (abort.signal.aborted) return;
      const battery = charging === false;
      const failed = frames.droppedRatio === null;
      const dropping = frames.droppedRatio !== null && frames.droppedRatio > DROPPED_LIMIT;
      if (!battery && !failed && !dropping) {
        ready(frames.frameMs);
        return;
      }
      setCheck({ kind: 'warn', frameMs: frames.frameMs, battery, droppedRatio: dropping ? frames.droppedRatio : null, failed });
    });
    return () => {
      abort.abort();
    };
  }, [measureFrames, platform]);

  useKeyDown((e) => {
    if (e.key === 'Escape') onBack();
  });

  if (check.kind === 'measuring') {
    return (
      <div className="screen-center">
        <p>Проверка экрана и питания…</p>
        <p className="muted">Не нажимай клавиши, это займёт секунду.</p>
      </div>
    );
  }
  const headline = check.battery ? HEADLINE.battery : check.droppedRatio !== null ? HEADLINE.dropping : HEADLINE.failed;
  return (
    <div className="screen-center">
      <p role="alert" className="warning">
        {headline}
      </p>
      <ul>
        {check.battery && <li>Ноутбук работает от батареи.</li>}
        {check.droppedRatio !== null && <li>Пропущено кадров: {percent(check.droppedRatio)} % (норма — до 5 %).</li>}
        {check.failed && headline !== HEADLINE.failed && <li>{HEADLINE.failed}</li>}
      </ul>
      <div className="actions">
        <button type="button" className="primary" autoFocus onClick={() => { onReady(check.frameMs); }}>
          Продолжить всё равно
        </button>
        <button type="button" onClick={onBack}>
          Назад
        </button>
      </div>
    </div>
  );
}
