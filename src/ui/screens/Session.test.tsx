import { act, cleanup, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MemoryRepository } from '../../data/memoryRepository';
import { EMPTY_RESULTS, type DiagnosticResults } from '../../engine/diagnostic';
import { planFree, type SessionPlan } from '../../engine/planner';
import type { TimedSeriesItem } from '../../modules/numseries/generate';
import { NO_STRESSORS } from '../../modules/reaction/common';
import { moduleTitles } from '../../modules/registry';
import type { BlockTimeline, TrialSpec } from '../../engine/reaction/types';
import type { DiscardOutcome, SessionStartOptions } from '../../session/controller';
import type { BlockSummaryView, Step, StepOf } from '../../session/steps';
import { frameStamps, manualFrames, mockCanvas, nextTask, settleUntil, stamped, type ManualFrames } from '../../testing/domFakes';
import { createAudioOut, type AudioOut } from '../../runtime/audio/audioOut';
import { FakeAudioContext } from '../../testing/fakeAudio';
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
  legend: null,
  layers: { ...NO_STRESSORS, seed: 1 },
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
  levelNote: null,
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

const MEMORY: StepOf<'memory_block'> = {
  kind: 'memory_block',
  L: 0,
  mode: 'digits',
  params: { length: 2, itemMs: 100, gapMs: 100 },
  trials: [{ mode: 'digits', items: ['4', '7'], gridSide: 0, itemMs: 100, gapMs: 100, cardMs: 200 }],
  protocol: 'fixed',
};

const SERIES: StepOf<'numseries_block'> = {
  kind: 'numseries_block',
  items: [{ id: 'arith:1', family: 'arith', seed: 1, shown: [1, 3, 5, 7, 9], answer: 11, difficulty: 800, timeLimitMs: 40_000 }],
  totalLimitMs: null,
};

/** A controller double: each test scripts what the calls do to `step`. */
type FakeDriver = { step: Step; escAllowed: boolean } & {
  [K in Exclude<keyof SessionDriver, 'step' | 'escAllowed'>]: Mock<SessionDriver[K]>;
};

const RESTARTED: DiscardOutcome = { kind: 'restarted' };

function fakeDriver(first: Step): FakeDriver {
  return {
    step: first,
    escAllowed: true,
    ackInstruction: vi.fn(),
    submitReaction: vi.fn(() => Promise.resolve()),
    submitTable: vi.fn(() => Promise.resolve()),
    submitNumSeries: vi.fn(() => Promise.resolve()),
    submitMemory: vi.fn(() => Promise.resolve()),
    discardBlock: vi.fn(() => Promise.resolve(RESTARTED)),
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
  driver: SessionDriver | (() => SessionDriver | Promise<SessionDriver>),
  o: { charging?: boolean | null; repo?: MemoryRepository; plan?: SessionPlan; audio?: AudioOut } = {},
): Promise<Rendered> {
  const repo = o.repo ?? new MemoryRepository();
  const platform = createFakePlatform({ repo, charging: o.charging ?? true });
  const onExit = vi.fn<() => void>();
  let started = false;
  const startSession = vi.fn<(o: SessionStartOptions) => Promise<SessionDriver>>(async () => {
    const d = await (typeof driver === 'function' ? driver() : driver);
    started = true;
    return d;
  });
  const { unmount } = renderWithApp(
    <Session
      plan={o.plan ?? PLAN}
      onExit={onExit}
      measureFrames={() => Promise.resolve(frameStamps(61, 1000 / 60))}
      startSession={startSession}
    />,
    platform,
    repo,
    o.audio,
  );
  // Not waitFor/findBy: the first step must be on screen with its key listeners attached before a test presses a key.
  if (o.charging === false) {
    await settleUntil(() => screen.queryByRole('button', { name: 'Назад' }) !== null, 'the power warning');
  } else {
    // The controller has started and its first step (or the error screen of a broken one) replaced «Загрузка…».
    await settleUntil(() => started && screen.queryByText('Загрузка…') === null, 'the first step on screen');
  }
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

  it('a slow controller start: «Загрузка…» until the first step is on screen', async () => {
    let loadingSeen = false;
    await renderSession(async () => {
      // Plain timers, not nextTask: this runs inside the act() of renderSession's own wait.
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      loadingSeen = screen.queryByText('Загрузка…') !== null;
      return fakeDriver(INSTRUCTION);
    });
    expect(loadingSeen).toBe(true);
    // renderSession returns once the first step has replaced «Загрузка…».
    expect(screen.queryByText('Загрузка…')).toBeNull();
    expect(screen.getByText(INSTRUCTION.text)).toBeTruthy();
  });

  it('the key that starts a block with sound applies the saved volume and unlocks the audio in that key press (M4)', async () => {
    const repo = new MemoryRepository();
    await repo.saveSettings({ stressVolume: 35 });
    const order: string[] = [];
    const audio = {
      unlock: vi.fn<AudioOut['unlock']>(() => {
        order.push('unlock');
        return Promise.resolve();
      }),
      setVolume: vi.fn<AudioOut['setVolume']>((v) => {
        order.push(`volume ${String(v)}`);
      }),
      prepare: vi.fn<AudioOut['prepare']>(() => null),
      hold: vi.fn<AudioOut['hold']>(() => () => undefined),
      available: true,
    };
    const c = fakeDriver(INSTRUCTION);
    c.ackInstruction.mockImplementation(() => {
      order.push('ack');
      c.step = { ...REACTION, layers: { noise: null, audio: { layers: ['hum'], gain: 0.5 }, gate: 'all', noiseGate: 'noisy', seed: 1 } };
    });
    await renderSession(c, { repo, audio });
    expect(audio.unlock).not.toHaveBeenCalled();
    let inKeyPress: string[] = [];
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
      // Read before any await: the unlock must happen inside the key press, the user gesture the browser needs.
      inKeyPress = [...order];
      await Promise.resolve();
    });
    await nextTask();
    expect(inKeyPress).toEqual(['volume 0.35', 'ack', 'unlock']);
  });

  it('a step without sound never unlocks: a session without sound never creates an audio context (M4)', async () => {
    const make = vi.fn(() => new FakeAudioContext());
    const audio = createAudioOut(make);
    for (const next of [REACTION, TABLE, { kind: 'summary', view: SUMMARY } as const]) {
      const c = fakeDriver(INSTRUCTION);
      c.ackInstruction.mockImplementation(() => {
        c.step = next;
      });
      const { unmount } = await renderSession(c, { audio });
      await press('Enter');
      expect(c.ackInstruction).toHaveBeenCalledTimes(1);
      unmount();
    }
    expect(make).not.toHaveBeenCalled();
  });

  it('holds the sound awake for the whole session screen and releases it on unmount (W2-R39)', async () => {
    const release = vi.fn<() => void>();
    const hold = vi.fn<AudioOut['hold']>(() => release);
    const audio: AudioOut = {
      available: true,
      unlock: vi.fn<AudioOut['unlock']>(() => Promise.resolve()),
      setVolume: vi.fn<AudioOut['setVolume']>(),
      prepare: vi.fn<AudioOut['prepare']>(() => null),
      hold,
    };
    const { unmount } = await renderSession(fakeDriver(INSTRUCTION), { audio });
    expect(hold).toHaveBeenCalledTimes(1);
    await press('Enter');
    expect(release).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledTimes(1);
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
      [{ kind: 'done', sessionId: 's', diagnostic: null, seriesTotal: null, indexDeferred: false, comparison: null }, () => screen.getByText('Сессия завершена')],
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
      c.step = { kind: 'done', sessionId: 's', diagnostic: null, seriesTotal: null, indexDeferred: false, comparison: null };
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
      ...EMPTY_RESULTS,
      pzmrMedianRt: 251.4,
      pzmrMeanRt: 262.4,
      szmrMedianRt: 402,
      gonogoScore: 93.3,
      rdoMeanAbsErrorMs: 18.6,
      gorbov: { V: 41.25, P: 70.5, Pi: -12 },
      numseriesCorrect: 14,
      unreliable: [],
    };
    const comparison = { previous: null, readiness: 61.6, readinessPrevious: null, earlierUnreadable: false };
    await renderSession(fakeDriver({ kind: 'done', sessionId: 's', diagnostic, seriesTotal: 20, indexDeferred: true, comparison }), {
      plan: { ...PLAN, kind: 'diagnostic' },
    });
    expect(screen.getByText('Новые показатели войдут в индекс со следующей диагностики.')).toBeTruthy();
    expect(screen.getByText('Индекс: 62')).toBeTruthy();
    expect(screen.getByText('Первая диагностика — сравнивать пока не с чем')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Результаты диагностики' });
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell').map((td) => td.textContent.replaceAll('\u00a0', ' ')));
    expect(rows).toEqual([
      ['ПЗМР — медиана времени реакции', '251 мс', 'по среднему 262 мс: средний', '—'],
      ['Сложная реакция (СЗМР) — медиана времени реакции', '402 мс', '—', '—'],
      ['Go/No-Go — верные ответы', '93 %', '—', '—'],
      ['Реакция на движущийся объект — средняя ошибка по модулю', '19 мс', '—', '—'],
      ['Горбов — V, среднее время 1-й и 2-й таблиц', '41,3 с', 'средний', '—'],
      ['Горбов — P, время 3-й таблицы', '70,5 с', 'высокий', '—'],
      ['Горбов — Π, переключение внимания', '−12,0 с', '—', '—'],
      ['Числовые ряды — решено верно', '14 из 20', '—', '—'],
      ['Помехоустойчивость — разница с помехами и без', 'нет данных', '—', '—'],
      ['Струп — интерференция', 'нет данных', '—', '—'],
      ['Переключение правил — цена переключения', 'нет данных', '—', '—'],
      ['Память — объём', 'нет данных', '—', '—'],
    ]);
  });

  it('marks missing diagnostic metrics', async () => {
    const diagnostic: DiagnosticResults = EMPTY_RESULTS;
    await renderSession(fakeDriver({ kind: 'done', sessionId: 's', diagnostic, seriesTotal: null, indexDeferred: false, comparison: null }));
    expect(screen.getAllByText('нет данных')).toHaveLength(12);
    expect(screen.queryByText(/войдут в индекс/)).toBeNull();
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
      return Promise.resolve(RESTARTED);
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
      return Promise.resolve(RESTARTED);
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
      return Promise.resolve(RESTARTED);
    });
    await renderSession(c);
    frames.run(1000);
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      await Promise.resolve();
    });
    expect(c.discardBlock).toHaveBeenCalledWith('focus_lost', 0);
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
      expect(c.discardBlock).toHaveBeenCalledWith('error', 1);
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
      return Promise.resolve(RESTARTED);
    });
    const { onExit, platform } = await renderSession(c);
    frames.run(1000);
    await press('Escape');
    expect(c.discardBlock).toHaveBeenCalledWith('user', 0);
    expect(screen.getByRole('heading', { name: 'Пауза' })).toBeTruthy();
    expect(screen.getByText('Блок прерван в начале — не засчитан.')).toBeTruthy();
    expect(screen.getByText('Уже сохранённые блоки не пропадут.')).toBeTruthy();
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

  it('memory_block renders MemoryView and Escape pauses with a discard', async () => {
    const c = fakeDriver(MEMORY);
    c.discardBlock.mockImplementation(() => {
      c.step = { ...MEMORY };
      return Promise.resolve(RESTARTED);
    });
    await renderSession(c);
    expect(document.querySelector('.memory canvas')).toBeTruthy();
    frames.run(1000);
    await press('Escape');
    expect(c.discardBlock).toHaveBeenCalledWith('user', 0);
    expect(screen.getByRole('heading', { name: 'Пауза' })).toBeTruthy();
    expect(screen.getByText('Блок прерван в начале — не засчитан.')).toBeTruthy();
    expect(document.querySelector('.memory')).toBeNull();
    await click('Продолжить блок заново');
    expect(document.querySelector('.memory canvas')).toBeTruthy();
  });

  it('memory answers go to submitMemory; focus loss discards the memory block', async () => {
    const c = fakeDriver(MEMORY);
    await renderSession(c);
    for (let ts = 0; ts <= 1200; ts += 50) {
      frames.run(ts);
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(document.querySelector('.memory-response')).toBeTruthy();
    // Not in e2e mode: the answer is not exposed.
    expect(document.querySelector('.memory-response')?.hasAttribute('data-e2e-answer')).toBe(false);
    await nextTask();
    await press('4');
    await press('7');
    await press('Enter');
    await waitFor(() => {
      expect(c.submitMemory).toHaveBeenCalledTimes(1);
    });
    expect(c.submitMemory.mock.calls[0]?.[0].map((a) => a.given)).toEqual([['4', '7']]);

    cleanup();
    const lost = fakeDriver(MEMORY);
    await renderSession(lost);
    frames.run(0);
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      await Promise.resolve();
    });
    expect(lost.discardBlock).toHaveBeenCalledWith('focus_lost', 0);
    expect(screen.getByText('Окно потеряло фокус. Блок будет повторён.')).toBeTruthy();
  });

  it('Escape on a table discards it too; on other steps it only pauses', async () => {
    const c = fakeDriver(TABLE);
    await renderSession(c);
    await press('Escape');
    expect(c.discardBlock).toHaveBeenCalledWith('user', 0);
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

describe('Session: Esc after 30 % and the diagnostic restart (F11)', () => {
  const DIAGNOSTIC: SessionPlan = { ...PLAN, kind: 'diagnostic' };
  const HINT = 'Перезапуск уже использован — доведи задание до конца.';

  it('Esc in a table at 50 % in training: the pause says it counts as 0, «Продолжить» goes on to the next block', async () => {
    const c = fakeDriver(TABLE);
    const next = { ...TABLE, seed: 2 };
    // The outcome carries the share the view reported (T-R57).
    c.discardBlock.mockImplementation((_reason, progress) => {
      c.step = next;
      return Promise.resolve({ kind: 'counted', progress, lBefore: 12.5, lAfter: 10.5, levelMoves: true, series: false });
    });
    await renderSession(c);
    frames.run(5000);
    // Two of the four cells found: the share the controller gets.
    const grid = screen.getByRole('group', { name: 'Таблица' });
    for (const value of ['1', '2']) {
      const cell = within(grid).getByText(value);
      fireEvent(cell, stamped(createEvent.mouseDown(cell, { button: 0 }), 6000));
    }
    await press('Escape');
    expect(c.discardBlock).toHaveBeenCalledWith('user', 0.5);
    expect(screen.getByRole('heading', { name: 'Пауза' })).toBeTruthy();
    expect(screen.getByText('Блок прерван на 50 % — засчитан как 0, уровень 12,5 → 10,5.')).toBeTruthy();
    expect(screen.getByText('Уже сохранённые блоки не пропадут.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Продолжить блок заново' })).toBeNull();
    await click('Продолжить');
    expect(screen.getByRole('group', { name: 'Таблица' })).toBeTruthy();
    expect(c.discardBlock).toHaveBeenCalledTimes(1);
  });

  it('a counted Esc whose save fails shows the save error, not the level change that may never happen (T-R57)', async () => {
    const c = fakeDriver(TABLE);
    c.discardBlock.mockImplementation((_reason, progress) => {
      c.step = { kind: 'save_error', message: 'Не удалось сохранить результаты.', canAbandon: true, what: 'block' };
      return Promise.resolve({ kind: 'counted', progress, lBefore: 5, lAfter: 3, levelMoves: true, series: false });
    });
    await renderSession(c);
    frames.run(5000);
    const grid = screen.getByRole('group', { name: 'Таблица' });
    for (const value of ['1', '2']) {
      const cell = within(grid).getByText(value);
      fireEvent(cell, stamped(createEvent.mouseDown(cell, { button: 0 }), 6000));
    }
    await press('Escape');
    expect(c.discardBlock).toHaveBeenCalledWith('user', 0.5);
    expect(screen.getByText('Не удалось сохранить результаты.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Пауза' })).toBeNull();
    expect(screen.queryByText(/засчитан как 0/)).toBeNull();
  });

  it('Escape while a controller call runs leaves a reaction block running: it is never stopped without a restart (T-R57)', async () => {
    const c = fakeDriver({ kind: 'summary', view: SUMMARY });
    let finish: () => void = () => undefined;
    // The next block is on screen while «Дальше» is still being handled.
    c.continueAfterSummary.mockImplementation(() => {
      c.step = REACTION;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await renderSession(c);
    await click('Дальше');
    expect(document.querySelector('canvas')).toBeTruthy();
    frames.run(1000);
    await press('Escape');
    expect(c.discardBlock).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Пауза' })).toBeNull();
    // The block runs on and ends as usual.
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    frames.run(1100);
    fireEvent(window, stamped(createEvent.keyDown(window, { code: 'Space', key: ' ' }), 1300));
    frames.run(1316);
    frames.run(1650);
    await waitFor(() => {
      expect(c.submitReaction).toHaveBeenCalledTimes(1);
    });
  });

  it('Esc in number series sends the answers given so far', async () => {
    const two: StepOf<'numseries_block'> = { ...SERIES, items: [SERIES.items[0] as TimedSeriesItem, { ...(SERIES.items[0] as TimedSeriesItem), id: 'arith:2' }] };
    const c = fakeDriver(two);
    c.discardBlock.mockImplementation(() => Promise.resolve({ kind: 'counted', progress: 0.5, lBefore: 0, lAfter: 0, levelMoves: false, series: true }));
    await renderSession(c);
    const input = screen.getByRole('textbox', { name: 'Ответ' });
    fireEvent.change(input, { target: { value: '11' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await press('Escape');
    expect(c.discardBlock).toHaveBeenCalledWith('user', 0.5, [expect.objectContaining({ itemId: 'arith:1', given: 11 })]);
    expect(screen.getByText('Блок прерван на 50 % — отвеченные задачи засчитаны, остальные — как пропущенные.')).toBeTruthy();
  });

  it('the first Esc of a diagnostic task goes straight to the restart notice, without the pause', async () => {
    const c = fakeDriver(REACTION);
    c.discardBlock.mockImplementation(() => {
      c.step = { kind: 'notice', module: 'pzmr', text: 'Блок перезапущен. В диагностике это можно сделать один раз за задание.' };
      c.escAllowed = false;
      return Promise.resolve(RESTARTED);
    });
    await renderSession(c, { plan: DIAGNOSTIC });
    frames.run(1000);
    await press('Escape');
    expect(c.discardBlock).toHaveBeenCalledWith('user', 0);
    expect(screen.getByRole('heading', { name: 'Повтор блока' })).toBeTruthy();
    expect(screen.getByText('Блок перезапущен. В диагностике это можно сделать один раз за задание.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Пауза' })).toBeNull();
  });

  it('in a diagnostic after the restart was used: the hint, no pause, the block goes on (tables, memory, series)', async () => {
    for (const step of [TABLE, MEMORY, SERIES]) {
      const c = fakeDriver(step);
      c.escAllowed = false;
      await renderSession(c, { plan: DIAGNOSTIC });
      await press('Escape');
      expect(screen.getByText(HINT)).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Пауза' })).toBeNull();
      expect(c.discardBlock).not.toHaveBeenCalled();
      // The block view stays on screen; the hint comes after it.
      expect(document.querySelector('.session')?.firstElementChild?.classList.contains('session-hint')).toBe(false);
      cleanup();
    }
  });

  it('in a diagnostic reaction block after the restart was used: the hint over the running block', async () => {
    const c = fakeDriver(REACTION);
    c.escAllowed = false;
    await renderSession(c, { plan: DIAGNOSTIC });
    frames.run(1000);
    await press('Escape');
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(c.discardBlock).not.toHaveBeenCalled();
    expect(document.querySelector('canvas')).toBeTruthy();
    frames.run(1100);
    fireEvent(window, stamped(createEvent.keyDown(window, { code: 'Space', key: ' ' }), 1300));
    frames.run(1316);
    frames.run(1650);
    await waitFor(() => {
      expect(c.submitReaction).toHaveBeenCalledTimes(1);
    });
  });

  it('a refused Esc (the controller had the last word) shows the hint too', async () => {
    const c = fakeDriver(TABLE);
    c.discardBlock.mockImplementation(() => Promise.resolve({ kind: 'refused' }));
    await renderSession(c, { plan: DIAGNOSTIC });
    await press('Escape');
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Пауза' })).toBeNull();
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
