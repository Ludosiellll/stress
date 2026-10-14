import { fromControl, isEnter, useKeyDown } from '../keys';

/** Small session screens: fatigue question, save error, interruption notice, pause menu. */

export function FatiguePrompt({ busy, onAnswer }: { busy: boolean; onAnswer: (stop: boolean) => void }) {
  return (
    <div className="screen-center">
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
  busy: boolean;
  onRetry: () => void;
  onAbandon: () => void;
}

/** The writes failed three times; the data is still in memory. */
export function SaveError({ message, canAbandon, busy, onRetry, onAbandon }: SaveErrorProps) {
  return (
    <div className="screen-center">
      <p role="alert" className="warning">
        {message}
      </p>
      <div className="actions">
        <button type="button" className="primary" autoFocus disabled={busy} onClick={onRetry}>
          Повторить
        </button>
        {canAbandon && (
          <button type="button" disabled={busy} onClick={onAbandon}>
            Пропустить этот блок
          </button>
        )}
      </div>
      {busy && <p className="muted">Сохраняю…</p>}
    </div>
  );
}

/** Why the block was thrown away; Enter goes on to a fresh block. */
export function Notice({ text, onContinue }: { text: string; onContinue: () => void }) {
  useKeyDown((e) => {
    if (!isEnter(e) || fromControl(e)) return;
    e.preventDefault();
    onContinue();
  });
  return (
    <div className="screen-center">
      <p className="notice">{text}</p>
      <p className="hint">Нажми Enter, чтобы продолжить</p>
    </div>
  );
}

export interface PauseMenuProps {
  /** The pause interrupted a block (it was discarded). */
  blockDiscarded: boolean;
  onResume: () => void;
  onExit: () => void;
}

export function PauseMenu({ blockDiscarded, onResume, onExit }: PauseMenuProps) {
  useKeyDown((e) => {
    if (e.key === 'Escape') onResume();
  });
  return (
    <div className="screen-center">
      <h2>Пауза</h2>
      {blockDiscarded && <p>Блок прерван, его результат не сохранён.</p>}
      <p className="muted">Пройденные блоки уже сохранены.</p>
      <div className="actions">
        <button type="button" className="primary" autoFocus onClick={onResume}>
          {blockDiscarded ? 'Продолжить блок заново' : 'Продолжить'}
        </button>
        <button type="button" onClick={onExit}>
          Завершить сессию
        </button>
      </div>
    </div>
  );
}
