import { act, cleanup, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MemoryRepository } from '../../data/memoryRepository';
import type { DiagnosticResults } from '../../engine/diagnostic';
import { planFree, type SessionPlan } from '../../engine/planner';
import { moduleTitles } from '../../modules/registry';
import type { BlockTimeline, TrialSpec } from '../../engine/reaction/types';
import type { SessionStartOptions } from '../../session/controller';
import type { BlockSummaryView, Step, StepOf } from '../../session/steps';
import { frameStamps, manualFrames, mockCanvas, nextTask, stamped, type ManualFrames } from '../../testing/domFakes';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { renderWithApp } from '../testUtils';
import Session, { type SessionDriver } from './Session';

const PLAN: SessionPlan = planFree('pzmr', 7);

const TRIAL: TrialSpec = {
  isiMs: 100,
  windowMs: 500,
  stimulus: { kind: 'shape', shape: 'circle', color: 'red' },
  expected: { kind: 'press', key: 'Space' },
};

const REACTION: StepOf<'reaction_block'> = {
  kind: 'reaction_block',
  module: 'pzmr',
  L: 0,
  specs: [TRIAL],
  keys: ['Space'],
  layout: 'keyboard',
};

const INSTRUCTION: StepOf<'instruction'> = {
  kind: 'instruction',
  module: 'pzmr',
  text: 'Как только появится красный круг, жми пробел.',
  keysHint: 'Пробел',
};

const SUMMARY: BlockSummaryView = {
  module: 'pzmr',
  title: 'ПЗМР',
  lBefore: 2,
  lAfter: 3.5,
  changes: [],
  score: 0.9,
  lines: ['Медиана: 280 мс'],
  flags: [],
  showLevel: true,
};

const TABLE: StepOf<'table_block'> = {
  kind: 'table_block',
  module: 'schulte',
  L: 0,
  task: 'schulte',
  cells: [1, 2, 3, 4].map((value) => ({ value, color: 'black' as const })),
  params: { timeLimitMs: 60_000, reshuffleEvery: null, size: 2 },
  seed: 1,
};

const SERIES: StepOf<'numseries_block'> = {
  kind: 'numseries_block',
  items: [{ id: 'arith:1', family: 'arith', seed: 1, shown: [1, 3, 5, 7, 9], answer: 11, difficulty: 800 }],
  perItemLimitMs: 40_000,
  totalLimitMs: null,
};

/** A controller double: each test scripts what the calls do to `step`. */
type FakeDriver = { step: Step } & { [K in Exclude<keyof SessionDriver, 'step'>]: Mock<SessionDriver[K]> };

function fakeDriver(first: Step): FakeDriver {
  return {
    step: first,
    ackInstruction: vi.fn(),
    submitReaction: vi.fn(() => Promise.resolve()),
    submitTable: vi.fn(() => Promise.resolve()),
    submitNumSeries: vi.fn(() => Promise.resolve()),
    discardBlock: vi.fn(),
    continueAfterSummary: vi.fn(() => Promise.resolve()),
    answerFatigue: vi.fn(() => Promise.resolve()),
    retrySave: vi.fn(() => Promise.resolve()),
    abandonPending: vi.fn(() => Promise.resolve()),
    submitWellbeing: vi.fn(() => Promise.resolve()),
    ackNotice: vi.fn(),
  };
}

let frames: ManualFrames;

beforeEach(() => {
  frames = manualFrames();
  mockCanvas();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Rendered {
  platform: FakePlatform;
  repo: MemoryRepository;
  onExit: Mock<() => void>;
  startSession: Mock<(o: SessionStartOptions) => Promise<SessionDriver>>;
  unmount: () => void;
}

async function renderSession(
  driver: SessionDriver | (() => SessionDriver),
  o: { charging?: boolean | null; repo?: MemoryRepository; plan?: SessionPlan } = {},
): Promise<Rendered> {
  const repo = o.repo ?? new MemoryRepository();
  const platform = createFakePlatform({ repo, charging: o.charging ?? true });
  const onExit = vi.fn<() => void>();
  const startSession = vi.fn<(o: SessionStartOptions) => Promise<SessionDriver>>(() =>
    Promise.resolve(typeof driver === 'function' ? driver() : driver),
  );
  const { unmount } = renderWithApp(
    <Session
      plan={o.plan ?? PLAN}
      onExit={onExit}
      measureFrames={() => Promise.resolve(frameStamps(61, 1000 / 60))}
      startSession={startSession}
    />,
    platform,
    repo,
  );
  if (o.charging === false) {
    await screen.findByRole('button', { name: 'Назад' });
  } else {
    await waitFor(() => {
      expect(startSession).toHaveBeenCalled();
    });
  }
  await nextTask();
  return { platform, repo, onExit, startSession, unmount };
}

async function press(key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(window, { key, code: key });
    await Promise.resolve();
  });
  await nextTask();
}

async function click(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
    await Promise.resolve();
  });
  await nextTask();
}

describe('Session start', () => {
  it('measures, goes fullscreen and starts the controller with the saved layout and the app version', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ layout: 'pult' });
    const { platform, startSession } = await renderSession(fakeDriver(INSTRUCTION), { repo });
    expect(platform.fullscreen).toEqual([true]);
    const options = startSession.mock.calls[0]?.[0] as SessionStartOptions;
    expect(options).toMatchObject({ repo, plan: PLAN, layout: 'pult', appVersion: '9.9.9', scale: 1 });
    expect(options.now()).toBeInstanceOf(Date);
    expect(screen.getByRole('region', { name: 'Сессия' })).toBeTruthy();
    expect(screen.getByText(INSTRUCTION.text)).toBeTruthy();
  });

  it('on battery asks first; «Назад» leaves without starting', async () => {
    const { onExit, startSession, platform } = await renderSession(fakeDriver(INSTRUCTION), { charging: false });
    await click('Назад');
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(startSession).not.toHaveBeenCalled();
    expect(platform.fullscreen).not.toContain(true);
  });

  it('on battery «Продолжить всё равно» starts the session', async () => {
    const { startSession } = await renderSession(fakeDriver(INSTRUCTION), { charging: false });
    await click('Продолжить всё равно');
    await waitFor(() => {
      expect(startSession).toHaveBeenCalledTimes(1);
    });
  });

  it('shows why the session could not start', async () => {
    const repo = new MemoryRepository();
    const platform = createFakePlatform({ repo, charging: true });
    const onExit = vi.fn();
    renderWithApp(
      <Session
        plan={PLAN}
        onExit={onExit}
        measureFrames={() => Promise.resolve(frameStamps(61, 1000 / 60))}
        startSession={() => Promise.reject(new Error('диск недоступен'))}
      />,
      platform,
      repo,
    );
    expect(await screen.findByText('Не удалось начать сессию: диск недоступен')).toBeTruthy();
    await click('На главную');
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(platform.fullscreen[0]).toBe(true);
    expect(platform.fullscreen.at(-1)).toBe(false);
  });
});

describe('Session steps', () => {
  it('renders the view of each step kind', async () => {
    const cases: Array<[Step, () => HTMLElement]> = [
      [INSTRUCTION, () => screen.getByText('Нажми Enter, чтобы начать. Esc — пауза.')],
      [REACTION, () => document.querySelector('canvas') as HTMLElement],
      [TABLE, () => screen.getByRole('group', { name: 'Таблица' })],
      [SERIES, () => screen.getByRole('textbox', { name: 'Ответ' })],
      [{ kind: 'summary', view: SUMMARY }, () => screen.getByText('Уровень: 2,0 → 3,5')],
      [{ kind: 'fatigue_prompt', module: 'szmr' }, () => screen.getByText(/Похоже на усталость/)],
      [{ kind: 'save_error', message: 'Не удалось сохранить результаты.', canAbandon: true, what: 'block' }, () => screen.getByText('Не удалось сохранить результаты.')],
      [{ kind: 'wellbeing' }, () => screen.getByRole('button', { name: 'Пропустить' })],
      [{ kind: 'done', sessionId: 's', diagnostic: null, seriesTotal: null }, () => screen.getByText('Сессия завершена')],
    ];
    for (const [step, find] of cases) {
      const r = await renderSession(fakeDriver(step));
      expect(find()).toBeTruthy();
      r.platform.fullscreen.length = 0;
      cleanup();
    }
  });

  it('walks instruction → summary → fatigue → wellbeing → done and back home', async () => {
    const c = fakeDriver(INSTRUCTION);
    c.ackInstruction.mockImplementation(() => {
      c.step = { kind: 'summary', view: SUMMARY };
    });
    c.continueAfterSummary.mockImplementation(() => {
      c.step = { kind: 'fatigue_prompt', module: 'pzmr' };
      return Promise.resolve();
    });
    c.answerFatigue.mockImplementation(() => {
      c.step = { kind: 'wellbeing' };
      return Promise.resolve();
    });
    c.submitWellbeing.mockImplementation(() => {
      c.step = { kind: 'done', sessionId: 's', diagnostic: null, seriesTotal: null };
      return Promise.resolve();
    });
    const { onExit, platform } = await renderSession(c);
    await press('Enter');
    expect(c.ackInstruction).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Медиана: 280 мс')).toBeTruthy();
    await press('Enter');
    expect(c.continueAfterSummary).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Похоже на усталость: реакция замедлилась, ошибок больше. Закончить этот модуль?')).toBeTruthy();
    await click('Продолжить');
    expect(c.answerFatigue).toHaveBeenCalledWith(false);
    await click('Пропустить');
    expect(c.submitWellbeing).toHaveBeenCalledWith(null);
    expect(screen.getByText('Сессия завершена')).toBeTruthy();
    // The block summaries seen during the session.
    expect(screen.getByText('ПЗМР: блоков 1, уровень 2,0 → 3,5')).toBeTruthy();
    await waitFor(() => {
      expect(platform.fullscreen).toEqual([true, false]);
    });
    await click('На главную');
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the new screen heading unless something on it has focus', async () => {
    const c = fakeDriver({ kind: 'summary', view: SUMMARY });
    c.continueAfterSummary.mockImplementation(() => {
      c.step = INSTRUCTION;
      return Promise.resolve();
    });
    c.ackInstruction.mockImplementation(() => {
      c.step = SERIES;
    });
    await renderSession(c);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'ПЗМР' }));
    await press('Enter');
    expect(document.activeElement?.textContent).toBe(moduleTitles.pzmr);
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement).not.toBe(document.body);
    await click('Начать (Enter)');
    // The answer field has autofocus; the heading does not take it away.
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Ответ' }));
  });

  it('a diagnostic replay notice: Enter starts the replayed block (I1)', async () => {
    const c = fakeDriver({ kind: 'notice', module: 'pzmr', text: 'Замер ненадёжен (пропуски кадров). Блок будет повторён.' });
    c.ackNotice.mockImplementation(() => {
      c.step = REACTION;
    });
    await renderSession(c);
    expect(screen.getByRole('heading', { name: 'Повтор блока' })).toBeTruthy();
    expect(screen.getByText('Замер ненадёжен (пропуски кадров). Блок будет повторён.')).toBeTruthy();
    await press('Enter');
    expect(c.ackNotice).toHaveBeenCalledTimes(1);
    expect(document.querySelector('canvas')).not.toBeNull();
  });

  it('«Закончить модуль» answers the fatigue prompt with stop', async () => {
    const c = fakeDriver({ kind: 'fatigue_prompt', module: 'szmr' });
    await renderSession(c);
    await click('Закончить модуль');
    expect(c.answerFatigue).toHaveBeenCalledWith(true);
  });

  it('disables the controls while a call is in flight and does not call twice', async () => {
    const c = fakeDriver({ kind: 'summary', view: SUMMARY });
    let finish: () => void = () => undefined;
    c.continueAfterSummary.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            c.step = { kind: 'wellbeing' };
            resolve();
          };
        }),
    );
    await renderSession(c);
    await press('Enter');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Дальше' }).disabled).toBe(true);
    await press('Enter');
    fireEvent.click(screen.getByRole('button', { name: 'Дальше' }));
    expect(c.continueAfterSummary).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Пропустить' })).toBeTruthy();
  });

  it('routes table and series results to the controller', async () => {
    const c = fakeDriver(TABLE);
    await renderSession(c);
    frames.run(5000);
    const grid = screen.getByRole('group', { name: 'Таблица' });
    for (const b of within(grid).getAllByRole('button').sort((a, b) => Number(a.textContent) - Number(b.textContent))) {
      fireEvent(b, stamped(createEvent.mouseDown(b, { button: 0 }), 6000));
    }
    await waitFor(() => {
      expect(c.submitTable).toHaveBeenCalledTimes(1);
    });

    cleanup();
    const s = fakeDriver(SERIES);
    await renderSession(s);
    const input = screen.getByRole('textbox', { name: 'Ответ' });
    fireEvent.change(input, { target: { value: '11' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(s.submitNumSeries).toHaveBeenCalledWith([expect.objectContaining({ itemId: 'arith:1', given: 11 })]);
    });
  });

  it('shows the diagnostic results with units', async () => {
    const diagnostic: DiagnosticResults = {
      pzmrMedianRt: 251.4,
      szmrMedianRt: 402,
      gonogoScore: 93.3,
      rdoMeanAbsErrorMs: 18.6,
      gorbov: { V: 41.25, P: 70.5, Pi: -12 },
      numseriesCorrect: 14,
      unreliable: [],
    };
    await renderSession(fakeDriver({ kind: 'done', sessionId: 's', diagnostic, seriesTotal: 20 }), { plan: { ...PLAN, kind: 'diagnostic' } });
    const table = screen.getByRole('table', { name: 'Результаты диагностики' });
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell').map((td) => td.textContent));
    expect(rows).toEqual([
      ['ПЗМР — медиана времени реакции', '251 мс'],
      ['Сложная реакция (СЗМР) — медиана времени реакции', '402 мс'],
      ['Go/No-Go — верные ответы', '93 %'],
      ['Реакция на движущийся объект — средняя ошибка', '19 мс'],
      ['Горбов — V, среднее время 1-й и 2-й таблиц', '41,3 с'],
      ['Горбов — P, время 3-й таблицы', '70,5 с'],
      ['Горбов — Π, переключение внимания', '−12,0 с'],
      ['Числовые ряды — решено верно', '14 из 20'],
    ]);
  });

  it('marks missing diagnostic metrics', async () => {
    const diagnostic: DiagnosticResults = {
      pzmrMedianRt: null,
      szmrMedianRt: null,
      gonogoScore: null,
      rdoMeanAbsErrorMs: null,
      gorbov: null,
      numseriesCorrect: null,
      unreliable: [],
    };
    await renderSession(fakeDriver({ kind: 'done', sessionId: 's', diagnostic, seriesTotal: null }));
    expect(screen.getAllByText('нет данных')).toHaveLength(8);
  });
});

describe('Session reaction blocks', () => {
  async function finishBlock(): Promise<void> {
    frames.run(1000);
    frames.run(1100);
    fireEvent(window, stamped(createEvent.keyDown(window, { code: 'Space', key: ' ' }), 1300));
    frames.run(1316);
    frames.run(1650);
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('submits the timeline of a finished block', async () => {
    const c = fakeDriver(REACTION);
    await renderSession(c);
    await finishBlock();
    await waitFor(() => {
      expect(c.submitReaction).toHaveBeenCalledTimes(1);
    });
    expect((c.submitReaction.mock.calls[0]?.[0] as BlockTimeline).presses).toEqual([{ key: 'Space', ts: 1300 }]);
  });

  it('mounts one renderer per block: instruction → block → discard → fresh block', async () => {
    vi.restoreAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const canvas = mockCanvas();
    const c = fakeDriver(INSTRUCTION);
    c.ackInstruction.mockImplementation(() => {
      c.step = REACTION;
    });
    c.discardBlock.mockImplementation(() => {
      c.step = { ...REACTION, L: 1 };
    });
    await renderSession(c);
    await press('Enter');
    await nextTask();
    expect(canvas.contexts()).toBe(1);
    frames.run(1000);
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      await Promise.resolve();
    });
    await nextTask();
    await press('Enter');
    await nextTask();
    expect(canvas.contexts()).toBe(2);
  });

  it('after two drawing failures in a row the notice also offers to end the session', async () => {
    vi.restoreAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    mockCanvas({
      arc: () => {
        throw new Error('draw failed');
      },
    });
    const c = fakeDriver(REACTION);
    c.discardBlock.mockImplementation(() => {
      c.step = { ...REACTION };
    });
    const { onExit } = await renderSession(c);
    const fail = async (): Promise<void> => {
      frames.run(1000);
      frames.run(1100);
      await act(async () => {
        await Promise.resolve();
      });
      await screen.findByText('Ошибка отрисовки. Блок будет повторён.');
      await nextTask();
    };
    await fail();
    expect(screen.queryByRole('button', { name: 'Завершить сессию' })).toBeNull();
    await click('Дальше (Enter)');
    await fail();
    await click('Завершить сессию');
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('the Enter that starts the block is not a press', async () => {
    const enterBlock: StepOf<'reaction_block'> = {
      ...REACTION,
      keys: ['Enter'],
      specs: [{ ...TRIAL, expected: { kind: 'press', key: 'Enter' } }],
    };
    const c = fakeDriver(INSTRUCTION);
    c.ackInstruction.mockImplementation(() => {
      c.step = enterBlock;
    });
    await renderSession(c);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
      // The same key still bouncing before the block has started.
      fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
      await Promise.resolve();
    });
    await nextTask();
    frames.run(1000);
    frames.run(1100);
    frames.run(1600);
    frames.run(1950);
    await waitFor(() => {
      expect(c.submitReaction).toHaveBeenCalledTimes(1);
    });
    expect((c.submitReaction.mock.calls[0]?.[0] as BlockTimeline).presses).toEqual([]);
  });

  it('focus loss discards the block, explains, and Enter plays a fresh one', async () => {
    const c = fakeDriver(REACTION);
    const fresh = { ...REACTION, L: 1 };
    c.discardBlock.mockImplementation(() => {
      c.step = fresh;
    });
    await renderSession(c);
    frames.run(1000);
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      await Promise.resolve();
    });
    expect(c.discardBlock).toHaveBeenCalledWith('focus_lost');
    expect(screen.getByText('Окно потеряло фокус. Блок будет повторён.')).toBeTruthy();
    expect(document.querySelector('canvas')).toBeNull();
    await nextTask();
    await press('Enter');
    expect(screen.queryByText(/потеряло фокус/)).toBeNull();
    expect(document.querySelector('canvas')).toBeTruthy();
    await finishBlock();
    await waitFor(() => {
      expect(c.submitReaction).toHaveBeenCalledTimes(1);
    });
  });

  it('Escape on the notice opens the pause menu without discarding again', async () => {
    const c = fakeDriver(REACTION);
    await renderSession(c);
    frames.run(1000);
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      await Promise.resolve();
    });
    await nextTask();
    await press('Escape');
    expect(screen.getByRole('heading', { name: 'Пауза' })).toBeTruthy();
    expect(screen.queryByText(/Блок прерван/)).toBeNull();
    expect(c.discardBlock).toHaveBeenCalledTimes(1);
    await click('Продолжить');
    expect(document.querySelector('canvas')).toBeTruthy();
  });

  it('a renderer failure discards the block with error, logs it and explains', async () => {
    vi.restoreAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    mockCanvas({
      arc: () => {
        throw new Error('draw failed');
      },
    });
    const c = fakeDriver(REACTION);
    const { repo } = await renderSession(c);
    frames.run(1000);
    frames.run(1100);
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(c.discardBlock).toHaveBeenCalledWith('error');
    });
    expect(screen.getByText('Ошибка отрисовки. Блок будет повторён.')).toBeTruthy();
    await waitFor(async () => {
      expect((await repo.listLog(10)).map((l) => [l.level, l.message])).toContainEqual(['error', 'Ошибка отрисовки: draw failed']);
    });
  });

  it('Escape pauses: the block is discarded and the menu offers a restart or the end', async () => {
    const c = fakeDriver(REACTION);
    c.discardBlock.mockImplementation(() => {
      c.step = { ...REACTION, L: 1 };
    });
    const { onExit, platform } = await renderSession(c);
    frames.run(1000);
    await press('Escape');
    expect(c.discardBlock).toHaveBeenCalledWith('user');
    expect(screen.getByRole('heading', { name: 'Пауза' })).toBeTruthy();
    expect(screen.getByText('Блок начнётся заново. Уже сохранённые блоки не пропадут.')).toBeTruthy();
    // Escape in the menu does nothing: going on takes Enter or a click.
    await press('Escape');
    expect(screen.getByRole('heading', { name: 'Пауза' })).toBeTruthy();
    expect(c.discardBlock).toHaveBeenCalledTimes(1);
    await click('Продолжить блок заново');
    expect(document.querySelector('canvas')).toBeTruthy();
    frames.run(2000);
    await press('Escape');
    await click('Завершить сессию');
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(platform.fullscreen.at(-1)).toBe(false);
  });

  it('Escape on a table discards it too; on other steps it only pauses', async () => {
    const c = fakeDriver(TABLE);
    await renderSession(c);
    await press('Escape');
    expect(c.discardBlock).toHaveBeenCalledWith('user');
    await click('Продолжить блок заново');

    cleanup();
    const s = fakeDriver({ kind: 'summary', view: SUMMARY });
    await renderSession(s);
    await press('Escape');
    expect(screen.getByRole('heading', { name: 'Пауза' })).toBeTruthy();
    await click('Продолжить');
    expect(s.discardBlock).not.toHaveBeenCalled();
    expect(screen.getByText('Медиана: 280 мс')).toBeTruthy();
  });
});

describe('Session save errors and failures', () => {
  it('save_error that cannot be skipped offers «Повторить» and «Завершить сессию»', async () => {
    const c = fakeDriver({ kind: 'save_error', message: 'Не удалось сохранить результаты.', canAbandon: false, what: 'session_start' });
    c.retrySave.mockImplementation(() => {
      c.step = { kind: 'wellbeing' };
      return Promise.resolve();
    });
    await renderSession(c);
    expect(screen.queryByRole('button', { name: 'Пропустить этот блок' })).toBeNull();
    await press('Escape');
    expect(screen.queryByRole('heading', { name: 'Пауза' })).toBeNull();
    await click('Повторить');
    expect(c.retrySave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Пропустить' })).toBeTruthy();
  });

  it('«Завершить сессию» on an unskippable save error leaves the session', async () => {
    const c = fakeDriver({ kind: 'save_error', message: 'Не удалось сохранить результаты.', canAbandon: false, what: 'session_start' });
    const { onExit, platform } = await renderSession(c);
    await click('Завершить сессию');
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(c.abandonPending).not.toHaveBeenCalled();
    expect(platform.fullscreen.at(-1)).toBe(false);
  });

  it.each([
    ['block', 'Пропустить этот блок', null],
    ['block_cache', 'Продолжить без обновления уровня', /Блок сохранён/],
    ['session_end', 'Завершить без сохранения итога', null],
  ] as const)('save_error of a %s offers «%s»', async (what, label, note) => {
    const c = fakeDriver({ kind: 'save_error', message: 'Не удалось сохранить результаты.', canAbandon: true, what });
    await renderSession(c);
    if (note !== null) expect(screen.getByText(note)).toBeTruthy();
    else expect(screen.queryByText(/Блок сохранён/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Завершить сессию' })).toBeNull();
    await click(label);
    expect(c.abandonPending).toHaveBeenCalledTimes(1);
  });

  it('a render error shows the fallback, logs it and leaves fullscreen', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = {
      get step(): Step {
        throw new Error('нет такого шага');
      },
    } as SessionDriver;
    const { repo, platform, onExit } = await renderSession(broken);
    expect(await screen.findByText('Что-то пошло не так. Данные пройденных блоков сохранены.')).toBeTruthy();
    await waitFor(async () => {
      expect((await repo.listLog(10)).map((l) => l.message)).toContain('Сбой экрана сессии: нет такого шага');
    });
    expect(platform.fullscreen.at(-1)).toBe(false);
    await click('На главную');
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('a controller call that throws ends in the same fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = fakeDriver({ kind: 'summary', view: SUMMARY });
    c.continueAfterSummary.mockRejectedValue(new Error('шаг не тот'));
    const { repo } = await renderSession(c);
    await press('Enter');
    expect(await screen.findByText('Что-то пошло не так. Данные пройденных блоков сохранены.')).toBeTruthy();
    await waitFor(async () => {
      expect((await repo.listLog(10)).map((l) => l.message)).toContain('Сбой экрана сессии: шаг не тот');
    });
  });

  it('leaves fullscreen when closed mid-session and has no e2e hooks', async () => {
    const { platform, unmount } = await renderSession(fakeDriver(INSTRUCTION));
    expect(window.__trainer).toBeUndefined();
    unmount();
    expect(platform.fullscreen).toEqual([true, false]);
  });
});
