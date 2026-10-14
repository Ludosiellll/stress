import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { frameStamps as frames } from '../../testing/domFakes';
import { createFakePlatform } from '../../testing/fakePlatform';
import { renderWithApp } from '../testUtils';
import Warnings from './Warnings';

function renderWarnings(charging: boolean | null, measured: Promise<number[]>) {
  const platform = createFakePlatform({ charging });
  const onReady = vi.fn();
  const onBack = vi.fn();
  const measureFrames = vi.fn(() => measured);
  renderWithApp(<Warnings measureFrames={measureFrames} onReady={onReady} onBack={onBack} />, platform, platform.repo);
  return { onReady, onBack, measureFrames };
}

describe('Warnings', () => {
  it('measures, then goes on by itself when power and frames are fine', async () => {
    const { onReady, measureFrames } = renderWarnings(true, Promise.resolve(frames(61, 1000 / 60)));
    expect(screen.getByText('Проверка экрана и питания…')).toBeTruthy();
    await waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1);
    });
    expect(onReady.mock.calls[0]?.[0]).toBeCloseTo(1000 / 60, 6);
    expect(measureFrames).toHaveBeenCalled();
    expect(screen.queryByText(/Подключи зарядку/)).toBeNull();
  });

  it('unknown power is not a reason to stop', async () => {
    const { onReady } = renderWarnings(null, Promise.resolve(frames(61, 1000 / 60)));
    await waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1);
    });
  });

  it('on battery: warns and offers «Продолжить всё равно» / «Назад»', async () => {
    const { onReady, onBack } = renderWarnings(false, Promise.resolve(frames(61, 10)));
    expect(await screen.findByText(/^Подключи зарядку и включи режим максимальной производительности/)).toBeTruthy();
    expect(screen.getByText('Ноутбук работает от батареи.')).toBeTruthy();
    expect(onReady).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить всё равно' }));
    expect(onReady).toHaveBeenCalledWith(10);
  });

  it('warns about dropped frames above 5 %', async () => {
    renderWarnings(true, Promise.resolve(frames(61, 10, 10)));
    expect(await screen.findByText('Пропущено кадров: 10 % (норма — до 5 %).')).toBeTruthy();
  });

  it('a failed measurement warns and continues with 60 Hz', async () => {
    const { onReady } = renderWarnings(true, Promise.resolve([1, 2, 3]));
    expect(await screen.findByText('Не удалось измерить частоту экрана.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить всё равно' }));
    expect(onReady).toHaveBeenCalledWith(1000 / 60);
  });

  it('Escape goes back', async () => {
    const { onBack } = renderWarnings(false, Promise.resolve(frames(61, 10)));
    await screen.findByRole('button', { name: 'Назад' });
    await waitFor(() => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
      expect(onBack).toHaveBeenCalled();
    });
  });
});
