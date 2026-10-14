import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Wellbeing from './Wellbeing';

const save = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Сохранить' });

describe('Wellbeing', () => {
  it('«Пропустить» submits null', () => {
    const onSubmit = vi.fn();
    render(<Wellbeing busy={false} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Пропустить' }));
    expect(onSubmit).toHaveBeenCalledWith(null);
  });

  it('saves sleep, caffeine and mood once all are given', () => {
    const onSubmit = vi.fn();
    render(<Wellbeing busy={false} onSubmit={onSubmit} />);
    const sleep = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Сон прошлой ночью, часов' });
    expect(document.activeElement).toBe(sleep);
    expect([sleep.min, sleep.max, sleep.step]).toEqual(['0', '14', '0.5']);
    expect(save().disabled).toBe(true);
    fireEvent.change(sleep, { target: { value: '7.5' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Да' }));
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '4' }));
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(onSubmit).toHaveBeenCalledWith({ sleepH: 7.5, caffeine: true, mood: 4 });
  });

  it('caffeine needs an explicit answer; sleep must be 0–14 in half hours', () => {
    const onSubmit = vi.fn();
    render(<Wellbeing busy={false} onSubmit={onSubmit} />);
    const sleep = screen.getByRole('spinbutton', { name: 'Сон прошлой ночью, часов' });
    fireEvent.click(screen.getByRole('radio', { name: '2' }));
    fireEvent.change(sleep, { target: { value: '8' } });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Нет' }).checked).toBe(false);
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Нет' }));
    expect(save().disabled).toBe(false);
    for (const bad of ['15', '-1', '7.3', '']) {
      fireEvent.change(sleep, { target: { value: bad } });
      expect(save().disabled).toBe(true);
    }
    fireEvent.change(sleep, { target: { value: '0' } });
    fireEvent.click(save());
    expect(onSubmit).toHaveBeenCalledWith({ sleepH: 0, caffeine: false, mood: 2 });
  });

  it('disables both buttons while busy', () => {
    render(<Wellbeing busy onSubmit={vi.fn()} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Пропустить' }).disabled).toBe(true);
    expect(save().disabled).toBe(true);
  });
});
