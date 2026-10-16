import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { nextTask } from '../../testing/domFakes';
import Instruction from './Instruction';

describe('Instruction', () => {
  it('shows the text, the keys and how to start', () => {
    render(<Instruction title="СЗМР" text="Красный — F, зелёный — J." keysHint="F, J" onStart={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'СЗМР' })).toBeTruthy();
    expect(screen.getByText('Красный — F, зелёный — J.')).toBeTruthy();
    expect(screen.getByText('Управление: F, J')).toBeTruthy();
    expect(screen.getByText('Нажми Enter, чтобы начать. Esc — пауза.')).toBeTruthy();
  });

  it('keeps a number with its unit on one line (T-R26, T-R61)', () => {
    const text = 'Нажми Пробел точно на отметке. Скорость: оборот за 1,5 с. Нагрузка: интервал 0,3–3 с.';
    render(<Instruction title="РДО" text={text} keysHint="Пробел" onStart={vi.fn()} />);
    expect(document.querySelector('.instruction-text')?.textContent).toBe(
      'Нажми Пробел точно на отметке. Скорость: оборот за 1,5 с. Нагрузка: интервал 0,3–3 с.',
    );
  });

  it('the button starts too', () => {
    const onStart = vi.fn();
    render(<Instruction title="ПЗМР" text="Жми пробел." keysHint="Пробел" onStart={onStart} />);
    fireEvent.click(screen.getByRole('button', { name: 'Начать (Enter)' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('starts on Enter once; repeats and the key that opened the screen do not count', async () => {
    const onStart = vi.fn();
    render(<Instruction title="ПЗМР" text="Жми пробел." keysHint="Пробел" onStart={onStart} />);
    // Still the key event that brought this screen up.
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    expect(onStart).not.toHaveBeenCalled();
    await nextTask();
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', repeat: true });
    fireEvent.keyDown(window, { key: 'Space', code: 'Space' });
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter', code: 'NumpadEnter' });
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
