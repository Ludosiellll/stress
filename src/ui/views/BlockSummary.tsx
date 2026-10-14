import type { BlockFlag } from '../../engine/types';
import type { ParamChange } from '../../modules/describe';
import type { BlockSummaryView } from '../../session/steps';
import { decimal } from '../format';
import { fromControl, isEnter, useKeyDown } from '../keys';

export interface BlockSummaryProps {
  view: BlockSummaryView;
  /** A controller call is running: Enter and the button do nothing. */
  busy: boolean;
  onContinue: () => void;
}

const FLAG_TEXT: Record<BlockFlag, string> = {
  calibration: 'Калибровка',
  fatigued: 'Блок помечен: усталость',
  timing_unreliable: 'Замер ненадёжен: пропуски кадров — уровень не менялся',
};

/** «Окно ответа: 387 → 358 мс»: a unit shared by both values is written once. */
export function changeText({ label, from, to }: ParamChange): string {
  const a = /^(.+) (\S+)$/.exec(from);
  const b = /^(.+) (\S+)$/.exec(to);
  if (a?.[1] !== undefined && b?.[1] !== undefined && a[2] === b[2]) return `${label}: ${a[1]} → ${b[1]} ${b[2] ?? ''}`;
  return `${label}: ${from} → ${to}`;
}

/** Result of the block that just ended: level, changed parameters, score, metrics, flags. Enter goes on. */
export default function BlockSummary({ view, busy, onContinue }: BlockSummaryProps) {
  useKeyDown((e) => {
    if (busy || !isEnter(e) || fromControl(e)) return;
    e.preventDefault();
    onContinue();
  });

  return (
    <div className="screen-center summary">
      <h2 tabIndex={-1}>{view.title}</h2>
      {view.module !== 'numseries' && (
        <p className="summary-level">
          Уровень: {decimal(view.lBefore)} → {decimal(view.lAfter)}
        </p>
      )}
      {view.changes.length > 0 && (
        <ul aria-label="Изменения">
          {view.changes.map((c) => (
            <li key={c.label}>{changeText(c)}</li>
          ))}
        </ul>
      )}
      <p>Успешно: {Math.round(view.score * 100)} %</p>
      <ul aria-label="Показатели">
        {view.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {view.flags.map((f) => (
        <p key={f} className={f === 'calibration' ? 'muted' : 'warning'}>
          {FLAG_TEXT[f]}
        </p>
      ))}
      <p className="hint">Enter — дальше</p>
      <div className="actions">
        <button type="button" disabled={busy} onClick={onContinue}>
          Дальше
        </button>
      </div>
    </div>
  );
}
