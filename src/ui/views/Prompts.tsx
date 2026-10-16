import type { SaveErrorWhat } from '../../session/steps';
import { noBreakUnits } from '../format';
import { fromControl, isEnter, useKeyDown } from '../keys';

/** Small session screens: fatigue question, save error, interruption notice, pause menu. */

export function FatiguePrompt({ busy, onAnswer }: { busy: boolean; onAnswer: (stop: boolean) => void }) {
  return (
    <div className="screen-center">
      <h2 tabIndex={-1}>Усталость</h2>
      <p>Похоже на усталость: реакция замедлилась, ошибок больше. Закончить этот модуль?</p>
      <div className="actions">
        <button type="button" className="primary" autoFocus disabled={busy} onClick={() => { onAnswer(true); }}>
          Закончить модуль
        </button>
        <button type="button" disabled={busy} onClick={() => { onAnswer(false); }}>
          Продолжить
        </button>
      </div>
    </div>
  );
}

export interface SaveErrorProps {
  message: string;
  canAbandon: boolean;
  what: SaveErrorWhat;
  busy: boolean;
  onRetry: () => void;
  onAbandon: () => void;
  /** Leaves the session (offered when the writes cannot be skipped: nothing else is held in memory then). */
  onExit: () => void;
}

/** What giving up on the failed writes means, by what is pending (Ruling R32). */
const ABANDON: Record<SaveErrorWhat, { label: string; note: string | null }> = {
  block: { label: 'Пропустить этот блок', note: null },
  block_cache: {
    label: 'Продолжить без обновления уровня',
    note: 'Блок сохранён. Не записался только уровень: он пересчитается при следующем запуске программы.',
  },
  session_start: { label: 'Пропустить', note: null },
  session_end: { label: 'Завершить без сохранения итога', note: null },
};

/** The writes failed three times; the data is still in memory. */
export function SaveError({ message, canAbandon, what, busy, onRetry, onAbandon, onExit }: SaveErrorProps) {
  const abandon = ABANDON[what];
  return (
    <div className="screen-center">
      <h2 tabIndex={-1}>Ошибка сохранения</h2>
      <p role="alert" className="warning">
        {message}
      </p>
      {canAbandon && abandon.note !== null && <p className="muted">{abandon.note}</p>}
      <div className="actions">
        <button type="button" className="primary" autoFocus disabled={busy} onClick={onRetry}>
          Повторить
        </button>
        {canAbandon ? (
          <button type="button" disabled={busy} onClick={onAbandon}>
            {abandon.label}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={onExit}>
            Завершить сессию
          </button>
        )}
      </div>
      {busy && <p className="muted">Сохраняю…</p>}
    </div>
  );
}

export interface NoticeProps {
  /** Heading; default «Блок прерван». */
  title?: string;
  text: string;
  onContinue: () => void;
  /** Offered after repeated failures: leave the session instead of trying again. */
  onExit?: (() => void) | undefined;
}

/** Why the block was thrown away; Enter goes on to a fresh block. */
export function Notice({ title = 'Блок прерван', text, onContinue, onExit }: NoticeProps) {
  useKeyDown((e) => {
    if (!isEnter(e) || fromControl(e)) return;
    e.preventDefault();
    onContinue();
  });
  return (
    <div className="screen-center">
      <h2 tabIndex={-1}>{title}</h2>
      <p className="notice">{text}</p>
      <p className="hint">Нажми Enter, чтобы продолжить. Esc — пауза.</p>
      <div className="actions">
        <button type="button" className="primary" onClick={onContinue}>
          Дальше (Enter)
        </button>
        {onExit !== undefined && (
          <button type="button" onClick={onExit}>
            Завершить сессию
          </button>
        )}
      </div>
    </div>
  );
}

export interface PauseMenuProps {
  /** What Escape did to the block on screen (discardText, F11); '' when the pause stopped no block. */
  text: string;
  /** The block starts again (a free restart): «Продолжить блок заново»; otherwise «Продолжить». */
  restartBlock: boolean;
  onResume: () => void;
  onExit: () => void;
}

/** Escape does nothing here: going on takes Enter on the focused button or a click. */
export function PauseMenu({ text, restartBlock, onResume, onExit }: PauseMenuProps) {
  return (
    <div className="screen-center">
      <h2 tabIndex={-1}>Пауза</h2>
      {text !== '' && <p>{noBreakUnits(text)}</p>}
      <p>Уже сохранённые блоки не пропадут.</p>
      <div className="actions">
        <button type="button" className="primary" autoFocus onClick={onResume}>
          {restartBlock ? 'Продолжить блок заново' : 'Продолжить'}
        </button>
        <button type="button" onClick={onExit}>
          Завершить сессию
        </button>
      </div>
    </div>
  );
}
