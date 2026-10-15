import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportBundle } from '../../data/export';
import { MemoryRepository } from '../../data/memoryRepository';
import { block, session, trial } from '../../data/repository.contract';
import type { AudioOut, StressorHandle } from '../../runtime/audio/audioOut';
import { settleUntil } from '../../testing/domFakes';
import { createFakePlatform, type FakePlatformOptions } from '../../testing/fakePlatform';
import { renderWithApp } from '../testUtils';
import Settings, { SOUND_UNLOCK_WAIT_MS } from './Settings';

const NOTE =
  'Клавиатура ноутбука добавляет задержку по сравнению с кнопкой прибора. Сравнивай результаты со своими прошлыми, а нормы считай ориентировочными.';
const WARNING = 'Подключи зарядку и включи режим максимальной производительности';

function frames(count: number, step: number, hiccupEvery = 0): number[] {
  const out: number[] = [];
  let t = 1000;
  for (let i = 0; i < count; i++) {
    out.push(t);
    t += hiccupEvery > 0 && i % hiccupEvery === hiccupEvery - 1 ? step * 3 : step;
  }
  return out;
}

async function renderSettings(
  { audio, ...options }: FakePlatformOptions & { audio?: AudioOut } = {},
  measureFrames = vi.fn(() => Promise.resolve(frames(181, 1000 / 60))),
) {
  const repo = options.repo ?? new MemoryRepository();
  const platform = createFakePlatform({ ...options, repo });
  const onBack = vi.fn();
  const view = renderWithApp(<Settings onBack={onBack} measureFrames={measureFrames} />, platform, repo, audio);
  await screen.findByText(/Версия приложения/);
  return { repo, platform, onBack, measureFrames, view };
}

describe('Settings layout and date', () => {
  it('shows the saved layout and saves a new one', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ layout: 'pult' });
    await renderSettings({ repo });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Пульт (стрелки и цифры)' }).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Мышь' }));
    await waitFor(async () => {
      expect((await repo.getSettings()).layout).toBe('mouse');
    });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Мышь' }).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Клавиатура' }));
    await waitFor(async () => {
      expect((await repo.getSettings()).layout).toBe('keyboard');
    });
  });

  it('saves the test date and clears it', async () => {
    const { repo } = await renderSettings();
    const input = screen.getByLabelText<HTMLInputElement>('Дата теста');
    fireEvent.change(input, { target: { value: '2026-12-01' } });
    await waitFor(async () => {
      expect((await repo.getSettings()).testDate).toBe('2026-12-01');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Очистить' }));
    await waitFor(async () => {
      expect((await repo.getSettings()).testDate).toBeNull();
    });
    expect(input.value).toBe('');
  });

  it('goes back on the button and on Escape, and shows the version', async () => {
    const { onBack } = await renderSettings({ version: '1.2.3' });
    expect(screen.getByText('Версия приложения: 1.2.3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('tells in the web build that nothing is kept', async () => {
    await renderSettings({ kind: 'web' });
    expect(screen.getByText(/Веб-версия.*до закрытия страницы/)).toBeTruthy();
  });
});

describe('Settings timing self-check', () => {
  it('always shows the permanent note', async () => {
    await renderSettings();
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it('measures frames, shows the numbers and saves the result', async () => {
    const { repo, measureFrames } = await renderSettings({ charging: true });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить тайминги (3 с)' }));
    await screen.findByText('Частота: 60 Гц');
    expect(measureFrames).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Разброс кадров: 0[.,]0 мс/)).toBeTruthy();
    expect(screen.getByText('Пропущенные кадры: 0 %')).toBeTruthy();
    expect(screen.getByText('Питание: от сети')).toBeTruthy();
    expect(screen.getByText('Погрешность ≈ 1 кадр (16,7 мс)')).toBeTruthy();
    expect(screen.queryByText(WARNING)).toBeNull();
    const saved = JSON.parse((await repo.getSettings()).lastSelfCheckJson ?? 'null') as Record<string, unknown>;
    expect(saved).toMatchObject({ charging: true });
    expect(saved['hz']).toBeCloseTo(60, 5);
    expect(typeof saved['at']).toBe('string');
  });

  it('warns on battery power', async () => {
    await renderSettings({ charging: false });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить тайминги (3 с)' }));
    await screen.findByText('Питание: от батареи');
    expect(screen.getByText(WARNING)).toBeTruthy();
  });

  it('warns when more than 5 % of the frames are dropped', async () => {
    await renderSettings({ charging: true }, vi.fn(() => Promise.resolve(frames(101, 1000 / 60, 10))));
    fireEvent.click(screen.getByRole('button', { name: 'Проверить тайминги (3 с)' }));
    await screen.findByText('Пропущенные кадры: 10 %');
    expect(screen.getByText(WARNING)).toBeTruthy();
  });

  it('writes "неизвестно" for power and does not warn about it', async () => {
    await renderSettings({ charging: null });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить тайминги (3 с)' }));
    await screen.findByText('Питание: неизвестно');
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('shows the previous result after a restart', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({
      lastSelfCheckJson: JSON.stringify({ at: '2026-10-10T08:00:00.000Z', hz: 144, intervalMs: 6.94, jitterMs: 0.3, droppedRatio: 0.01, charging: true }),
    });
    await renderSettings({ repo });
    expect(screen.getByText('Частота: 144 Гц')).toBeTruthy();
    expect(screen.getByText('Погрешность ≈ 1 кадр (6,9 мс)')).toBeTruthy();
  });

  it('reports a failed measurement instead of crashing', async () => {
    const { repo } = await renderSettings({}, vi.fn(() => Promise.resolve([1, 2, 3])));
    fireEvent.click(screen.getByRole('button', { name: 'Проверить тайминги (3 с)' }));
    await screen.findByText(/Не удалось выполнить замер/);
    expect((await repo.getSettings()).lastSelfCheckJson).toBeNull();
  });
});

describe('Settings export and report', () => {
  async function seeded(): Promise<MemoryRepository> {
    const repo = new MemoryRepository();
    await repo.createSession(session('s1', '2026-10-01T08:00:00.000Z'));
    await repo.addBlock(block('b1', 's1', '2026-10-01T08:01:00.000Z'), [trial('t1', 'b1', 0)], []);
    return repo;
  }

  it('exports three files, CSV with BOM, and shows where they went', async () => {
    const repo = await seeded();
    const { platform } = await renderSettings({ repo, version: '1.2.3' });
    fireEvent.click(screen.getByRole('button', { name: 'Экспорт данных (JSON и CSV)' }));
    await screen.findByText(/Сохранено/);
    expect(platform.exports).toHaveLength(3);
    const [json, blocks, trials] = platform.exports;
    expect(json?.name).toMatch(/^trainer-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(blocks?.name).toMatch(/^blocks-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(trials?.name).toMatch(/^trials-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((JSON.parse(json?.contents ?? '') as { appVersion: string }).appVersion).toBe('1.2.3');
    for (const csv of [blocks, trials]) {
      expect(csv?.contents.startsWith('\uFEFF')).toBe(true);
      expect(csv?.contents.length).toBeGreaterThan(1);
    }
    expect(blocks?.contents.slice(1)).toMatch(/^id;sessionId;module;/);
    expect(trials?.contents.slice(1)).toMatch(/^id;blockId;idx;/);
    expect(screen.getByText(`C:\\Downloads\\${blocks?.name ?? ''}`)).toBeTruthy();
  });

  it('no timing check while an export runs (no concurrent measurement)', async () => {
    const repo = await seeded();
    const { platform, measureFrames } = await renderSettings({ repo });
    let release: () => void = () => undefined;
    platform.exportFile = () => new Promise((resolve) => { release = () => { resolve('C:\\Downloads\\x'); }; });
    fireEvent.click(screen.getByRole('button', { name: 'Экспорт данных (JSON и CSV)' }));
    const checkButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Проверить тайминги (3 с)' });
    await waitFor(() => { expect(checkButton.disabled).toBe(true); });
    fireEvent.click(checkButton);
    expect(measureFrames).not.toHaveBeenCalled();
    release();
  });

  it('shows an error and logs it when a file cannot be written', async () => {
    const repo = await seeded();
    const { platform } = await renderSettings({ repo });
    platform.exportFile = () => Promise.reject(new Error('нет места'));
    fireEvent.click(screen.getByRole('button', { name: 'Экспорт данных (JSON и CSV)' }));
    await screen.findByText(/Не удалось сохранить.*нет места/);
    const log = await repo.listLog(5);
    expect(log[0]).toMatchObject({ level: 'error' });
    expect(log[0]?.message).toContain('Экспорт');
  });

  it('saves the error report as report-YYYY-MM-DD-HHmm.json', async () => {
    const { platform } = await renderSettings({ version: '2.0.0', kind: 'tauri' });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить отчёт об ошибке' }));
    await screen.findByText(/Отчёт сохранён/);
    expect(platform.exports).toHaveLength(1);
    expect(platform.exports[0]?.name).toMatch(/^report-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(JSON.parse(platform.exports[0]?.contents ?? '')).toMatchObject({ appVersion: '2.0.0', platform: 'tauri' });
  });
});

describe('Settings failures and cancellation', () => {
  it('shows a load failure with «Назад» and logs it', async () => {
    const repo = new MemoryRepository();
    vi.spyOn(repo, 'getSettings').mockRejectedValue(new Error('база недоступна'));
    const onBack = vi.fn();
    renderWithApp(<Settings onBack={onBack} />, createFakePlatform({ repo }), repo);
    await screen.findByText(/Не удалось загрузить настройки: база недоступна/);
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await waitFor(async () => {
      expect((await repo.listLog(5)).some((r) => r.level === 'error' && r.message.includes('база недоступна'))).toBe(true);
    });
  });

  it('opens without the version when it cannot be read, and the report still saves', async () => {
    const repo = new MemoryRepository();
    const platform = createFakePlatform({ repo });
    platform.appVersion = () => Promise.reject(new Error('нет версии'));
    renderWithApp(<Settings onBack={vi.fn()} />, platform, repo);
    await screen.findByText('Версия приложения: неизвестна');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить отчёт об ошибке' }));
    await screen.findByText(/Отчёт сохранён/);
    expect(JSON.parse(platform.exports[0]?.contents ?? '')).toMatchObject({ appVersion: 'unknown' });
    fireEvent.click(screen.getByRole('button', { name: 'Экспорт данных (JSON и CSV)' }));
    await waitFor(() => { expect(platform.exports).toHaveLength(4); });
  });

  it('rolls the layout back, shows the failure and logs it when saving fails', async () => {
    const repo = new MemoryRepository();
    vi.spyOn(repo, 'saveSettings').mockRejectedValue(new Error('диск полон'));
    await renderSettings({ repo });
    fireEvent.click(screen.getByRole('radio', { name: 'Мышь' }));
    await screen.findByText(/Не удалось сохранить: раскладка. диск полон/);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Клавиатура' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Мышь' }).checked).toBe(false);
    expect((await repo.listLog(5))[0]).toMatchObject({ level: 'error' });
  });

  it('rolls the test date back when saving fails', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ testDate: '2026-11-01' });
    await renderSettings({ repo });
    vi.spyOn(repo, 'saveSettings').mockRejectedValue(new Error('диск полон'));
    fireEvent.click(screen.getByRole('button', { name: 'Очистить' }));
    await screen.findByText(/Не удалось сохранить: дата теста/);
    expect(screen.getByLabelText<HTMLInputElement>('Дата теста').value).toBe('2026-11-01');
  });

  it('stops the measurement and saves nothing when the screen is left', async () => {
    const repo = new MemoryRepository();
    let seen: AbortSignal | undefined;
    const measureFrames = vi.fn(
      (signal: AbortSignal) =>
        new Promise<number[]>((resolve) => {
          seen = signal;
          signal.addEventListener('abort', () => { resolve(frames(181, 1000 / 60)); });
        }),
    );
    const platform = createFakePlatform({ repo });
    const view = renderWithApp(<Settings onBack={vi.fn()} measureFrames={measureFrames} />, platform, repo);
    await screen.findByText(/Версия приложения/);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить тайминги (3 с)' }));
    await waitFor(() => { expect(seen).toBeDefined(); });
    view.unmount();
    expect(seen?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect((await repo.getSettings()).lastSelfCheckJson).toBeNull();
  });

  it('shows why the measurement failed when the window was hidden, and keeps the buttons usable', async () => {
    await renderSettings({}, vi.fn(() => Promise.reject(new Error('окно было скрыто во время замера'))));
    fireEvent.click(screen.getByRole('button', { name: 'Проверить тайминги (3 с)' }));
    await screen.findByText(/окно было скрыто/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Экспорт данных (JSON и CSV)' }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Проверить тайминги (3 с)' }).disabled).toBe(false);
  });

  it('ignores Escape during the measurement and honours it afterwards', async () => {
    let finish: (f: number[]) => void = () => undefined;
    const measureFrames = vi.fn(() => new Promise<number[]>((resolve) => { finish = resolve; }));
    const { onBack } = await renderSettings({}, measureFrames);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить тайминги (3 с)' }));
    // Not findByText: the screen must be idle, its Escape handling settled, before the key is pressed.
    await settleUntil(() => screen.queryByText(/Идёт замер/) !== null, 'the measurement');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onBack).not.toHaveBeenCalled();
    finish(frames(181, 1000 / 60));
    await settleUntil(() => screen.queryByText('Частота: 60 Гц') !== null, 'the measurement result');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('Settings dropped-frame warning', () => {
  it('judges the rounded percentage that is displayed (5 % is not above 5 %)', async () => {
    // 1 hiccup in 20 gaps = 5 %.
    await renderSettings({ charging: true }, vi.fn(() => Promise.resolve(frames(21, 1000 / 60, 20))));
    fireEvent.click(screen.getByRole('button', { name: 'Проверить тайминги (3 с)' }));
    await screen.findByText('Пропущенные кадры: 5 %');
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('uses an alert for a fresh warning and a status for a stored one', async () => {
    const { repo, view } = await renderSettings({ charging: false });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить тайминги (3 с)' }));
    await screen.findByText(WARNING);
    expect(screen.getByText(WARNING).getAttribute('role')).toBe('alert');
    view.unmount();
    renderWithApp(<Settings onBack={vi.fn()} />, createFakePlatform({ repo }), repo);
    await screen.findByText(WARNING);
    expect(screen.getByText(WARNING).getAttribute('role')).toBe('status');
  });
});

/** An AudioOut double whose loop handle records what the screen does with it. */
function spyAudio(started = true) {
  const handle = {
    playing: false,
    start: vi.fn<StressorHandle['start']>(() => started),
    setActive: vi.fn<StressorHandle['setActive']>(),
    stop: vi.fn<StressorHandle['stop']>(),
  };
  const audio = {
    unlock: vi.fn<AudioOut['unlock']>(() => Promise.resolve()),
    setVolume: vi.fn<AudioOut['setVolume']>(),
    prepare: vi.fn<AudioOut['prepare']>(() => handle),
    /** Settings never holds the sound: after «Проверить звук» it may sleep again (W2-R39). */
    hold: vi.fn<AudioOut['hold']>(() => {
      throw new Error('Settings must not hold the sound');
    }),
    available: true,
  };
  return { audio, handle };
}

async function clickCheckSound(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Проверить звук' }));
    await Promise.resolve();
  });
}

describe('Settings sound', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the default volume of 60 % and the hint', async () => {
    await renderSettings();
    expect(screen.getByRole<HTMLInputElement>('slider', { name: 'Громкость помех' }).value).toBe('60');
    expect(screen.getByText('60 %')).toBeTruthy();
    expect(
      screen.getByText(
        'Звуковые помехи включаются в «Помехоустойчивости» на высоких уровнях, а также в финишере и в блоках перегрузки ' +
          'модулей реакции. Лучше слушать в наушниках.',
      ),
    ).toBeTruthy();
  });

  it('the slider saves stressVolume in steps of 5 and sets the output volume', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ stressVolume: 40 });
    const { audio } = spyAudio();
    await renderSettings({ repo, audio });
    const slider = screen.getByRole<HTMLInputElement>('slider', { name: 'Громкость помех' });
    expect(slider.value).toBe('40');
    expect(slider.min).toBe('0');
    expect(slider.max).toBe('100');
    expect(slider.step).toBe('5');
    expect(audio.setVolume).toHaveBeenLastCalledWith(0.4);
    fireEvent.change(slider, { target: { value: '75' } });
    await waitFor(async () => {
      expect((await repo.getSettings()).stressVolume).toBe(75);
    });
    expect(screen.getByText('75 %')).toBeTruthy();
    expect(audio.setVolume).toHaveBeenLastCalledWith(0.75);
  });

  it('«Проверить звук» plays hum and beeps at the set volume and stops after 2 s', async () => {
    const { audio, handle } = spyAudio();
    await renderSettings({ audio });
    vi.useFakeTimers();
    await clickCheckSound();
    expect(audio.unlock).toHaveBeenCalledTimes(1);
    expect(audio.setVolume).toHaveBeenLastCalledWith(0.6);
    expect(audio.prepare).toHaveBeenCalledWith({ layers: ['hum', 'beeps'], gain: 1 }, expect.any(Number));
    expect(handle.start).toHaveBeenCalledTimes(1);
    expect(handle.setActive).toHaveBeenCalledWith(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Проверить звук' }).disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(handle.stop).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Проверить звук' }).disabled).toBe(false);
  });

  it('stops the check sound when the screen closes', async () => {
    const { audio, handle } = spyAudio();
    const { view } = await renderSettings({ audio });
    await clickCheckSound();
    expect(handle.start).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it('without Web Audio says the sound is unavailable at once, before any click (B4)', async () => {
    await renderSettings();
    expect(screen.getByText('Звук недоступен на этом компьютере')).toBeTruthy();
    await clickCheckSound();
    expect(screen.getByText('Звук недоступен на этом компьютере')).toBeTruthy();
  });

  it('with Web Audio says nothing until the check', async () => {
    const { audio } = spyAudio();
    await renderSettings({ audio });
    expect(screen.queryByText('Звук недоступен на этом компьютере')).toBeNull();
  });

  it('a resume that never settles does not hold the check: the button comes back (B4)', async () => {
    const { audio, handle } = spyAudio(false);
    audio.unlock.mockImplementation(() => new Promise<void>(() => undefined));
    await renderSettings({ audio });
    vi.useFakeTimers();
    await clickCheckSound();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Проверить звук' }).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOUND_UNLOCK_WAIT_MS);
    });
    expect(handle.start).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Звук не воспроизводился')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Проверить звук' }).disabled).toBe(false);
  });

  it('at volume 0 the check says the sound is off, not that it failed (B4)', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ stressVolume: 0 });
    const { audio, handle } = spyAudio();
    await renderSettings({ repo, audio });
    await clickCheckSound();
    expect(screen.getByText('Громкость помех — 0: звук выключен.')).toBeTruthy();
    expect(screen.queryByText('Звук не воспроизводился')).toBeNull();
    expect(handle.start).not.toHaveBeenCalled();
    // Turning the volume up takes the note away.
    fireEvent.change(screen.getByRole('slider', { name: 'Громкость помех' }), { target: { value: '50' } });
    expect(screen.queryByText('Громкость помех — 0: звук выключен.')).toBeNull();
  });

  it('says so when the sound could not start', async () => {
    const { audio, handle } = spyAudio(false);
    await renderSettings({ audio });
    await clickCheckSound();
    expect(screen.getByText('Звук не воспроизводился')).toBeTruthy();
    expect(handle.setActive).not.toHaveBeenCalled();
    expect(handle.stop).toHaveBeenCalled();
  });
});

describe('Settings restore', () => {
  async function chooseExportFile(): Promise<void> {
    const source = new MemoryRepository();
    await source.createSession(session('s1', '2026-10-01T08:00:00.000Z'));
    await source.addBlock(block('b1', 's1', '2026-10-01T08:01:00.000Z'), [trial('t1', 'b1', 0)], []);
    const text = await exportBundle(source, '0.2.0');
    fireEvent.change(screen.getByLabelText('Файл экспорта'), { target: { files: [new File([text], 'trainer-export.json')] } });
    await settleUntil(() => screen.queryByRole('button', { name: 'Восстановить' }) !== null, 'the preview');
  }

  const disabled = (name: string): boolean | undefined => screen.queryByRole<HTMLButtonElement>('button', { name })?.disabled;

  it('while a restore runs, every other control is locked and Escape does not leave', async () => {
    const { platform, onBack, repo } = await renderSettings();
    let release: () => void = () => undefined;
    platform.backupNow = () =>
      new Promise((resolve) => {
        release = () => { resolve(null); };
      });
    await chooseExportFile();
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
    await settleUntil(() => screen.queryByText('Резервная копия…') !== null, 'the restore');

    for (const name of ['Проверить тайминги (3 с)', 'Экспорт данных (JSON и CSV)', 'Сохранить отчёт об ошибке', 'Назад', 'Очистить', 'Проверить звук']) {
      expect(disabled(name), name).toBe(true);
    }
    for (const radio of screen.getAllByRole<HTMLInputElement>('radio')) expect(radio.disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Дата теста').disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('slider', { name: 'Громкость помех' }).disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onBack).not.toHaveBeenCalled();

    release();
    await settleUntil(() => screen.queryByText(/^Готово\./) !== null, 'the result');
    expect(await repo.listIds('blocks')).toEqual(new Set(['b1']));
    for (const name of ['Проверить тайминги (3 с)', 'Экспорт данных (JSON и CSV)', 'Сохранить отчёт об ошибке', 'Назад', 'Очистить', 'Проверить звук']) {
      expect(disabled(name), name).toBe(false);
    }
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('the restore is locked while an export runs', async () => {
    const { platform } = await renderSettings();
    let release: () => void = () => undefined;
    platform.exportFile = () =>
      new Promise((resolve) => {
        release = () => { resolve('C:\\Downloads\\x'); };
      });
    expect(disabled('Восстановить из файла экспорта')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Экспорт данных (JSON и CSV)' }));
    await waitFor(() => { expect(disabled('Восстановить из файла экспорта')).toBe(true); });
    release();
  });
});

describe('Settings after a restore', () => {
  it('shows the test date and layout the restore took from the file', async () => {
    await renderSettings();
    const source = new MemoryRepository();
    await source.createSession(session('s1', '2026-10-01T08:00:00.000Z'));
    await source.saveSettings({ layout: 'pult', testDate: '2026-12-01' });
    const text = await exportBundle(source, '0.2.0');
    fireEvent.change(screen.getByLabelText('Файл экспорта'), { target: { files: [new File([text], 'trainer-export.json')] } });
    await settleUntil(() => screen.queryByRole('button', { name: 'Восстановить' }) !== null, 'the preview');
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
    await settleUntil(() => screen.queryByText(/Из файла взяты: дата теста, раскладка\.$/) !== null, 'the result');
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Пульт (стрелки и цифры)' }).checked).toBe(true);
    });
    expect(screen.getByLabelText<HTMLInputElement>('Дата теста').value).toBe('2026-12-01');
  });
});
