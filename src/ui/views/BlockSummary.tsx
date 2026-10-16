import { useId } from 'react';
import type { BlockFlag } from '../../engine/types';
import { changeText } from '../../modules/describe';
import type { BlockAssessment } from '../../session/assessment';
import type { BlockSummaryView } from '../../session/steps';
import { decimal, noBreakUnits } from '../format';
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
  overload: 'Блок с перегрузкой: на сохранённый уровень не влияет',
  warmup: 'Разминка: на сохранённый уровень не влияет',
  test_format: 'Прогон в формате теста: на сохранённый уровень не влияет',
  // Never on a summary screen (a counted Esc block has none, F11): the pause says it. Here for completeness.
  discarded: 'Блок прерван — засчитан как 0',
};

/** Notes, not warnings. */
const NOTE_FLAGS: ReadonlySet<BlockFlag> = new Set<BlockFlag>(['calibration', 'overload', 'warmup', 'test_format']);

/** The «Оценка» lines in order: step, goal, norms, history; empty ones are left out. */
function assessmentLines(a: BlockAssessment | undefined): string[] {
  if (a === undefined) return [];
  return [a.step, a.goal, ...a.norms, a.history].filter((line): line is string => line !== null);
}

/** Result of the block that just ended: level (or its note), changed parameters, score, metrics, assessment, flags. Enter goes on. */
export default function BlockSummary({ view, busy, onContinue }: BlockSummaryProps) {
  useKeyDown((e) => {
    if (busy || !isEnter(e) || fromControl(e)) return;
    e.preventDefault();
    onContinue();
  });
  const assessment = assessmentLines(view.assessment);
  const assessmentId = useId();
  // The level note says what the notes of the flags would say again: they are left out then (T-R27), warnings stay.
  const flags = view.levelNote === null ? view.flags : view.flags.filter((f) => !NOTE_FLAGS.has(f));

  return (
    <div className="screen-center summary">
      <h2 tabIndex={-1}>{view.title}</h2>
      {view.levelNote !== null ? (
        <p className="summary-level">{view.levelNote}</p>
      ) : (
        view.showLevel && (
          <p className="summary-level">
            Уровень: {decimal(view.lBefore)} → {decimal(view.lAfter)}
          </p>
        )
      )}
      {view.showLevel && view.changes.length > 0 && (
        <ul aria-label="Изменения">
          {view.changes.map((c) => (
            <li key={c.label}>{noBreakUnits(changeText(c))}</li>
          ))}
        </ul>
      )}
      <p>Успешно: {Math.round(view.score * 100)} %</p>
      <ul aria-label="Показатели">
        {view.lines.map((line) => (
          <li key={line}>{noBreakUnits(line)}</li>
        ))}
      </ul>
      {assessment.length > 0 && (
        <section className="assessment">
          <h3 id={assessmentId}>Оценка</h3>
          <ul aria-labelledby={assessmentId}>
            {assessment.map((line) => (
              <li key={line}>{noBreakUnits(line)}</li>
            ))}
          </ul>
        </section>
      )}
      {flags.map((f) => (
        <p key={f} className={NOTE_FLAGS.has(f) ? 'muted' : 'warning'}>
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
