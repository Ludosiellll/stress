import { fromControl, isEnter, useKeyDown } from '../keys';

export interface InstructionProps {
  title: string;
  text: string;
  keysHint: string;
  onStart: () => void;
}

/** What to do in the next block and with which keys; Enter (or the button) starts it. */
export default function Instruction({ title, text, keysHint, onStart }: InstructionProps) {
  useKeyDown((e) => {
    if (!isEnter(e) || fromControl(e)) return;
    e.preventDefault();
    onStart();
  });

  return (
    <div className="screen-center instruction">
      <h2 tabIndex={-1}>{title}</h2>
      <p className="instruction-text">{text}</p>
      <p>Управление: {keysHint}</p>
      <p className="hint">Нажми Enter, чтобы начать. Esc — пауза.</p>
      <div className="actions">
        <button type="button" className="primary" onClick={onStart}>
          Начать (Enter)
        </button>
      </div>
    </div>
  );
}
