import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { exportBundle } from '../../src/data/export';
import { MemoryRepository } from '../../src/data/memoryRepository';
import type { BlockRow } from '../../src/data/rows';
import { LETTER_KEY_CODES } from '../../src/modules/numseries/letters';
import type { StimulusEvent } from '../../src/testing/e2eHooks';

/**
 * A bot that plays the app perfectly in e2e mode (`?e2e=1`).
 *
 * - Reaction blocks are played inside the page: a `window.__trainer.onStimulus` subscriber dispatches the
 *   expected key (or mouse button) 280 ms after the onset, at onset + targetOffsetMs for timed (RDO) trials,
 *   and nothing on no-go trials. The runner stamps presses with `event.timeStamp`, so the synthetic events
 *   are timed like real ones.
 * - Tables are clicked in task order with real mouse clicks, number series and memory rows are answered from
 *   `data-e2e-answer`, and every other screen is driven through its visible buttons, like a user.
 */

interface BotState {
  delayMs: number;
  /**
   * Every stimulus seen; `answerAt` is when the bot's press is due (null: no press, a no-go trial), `cond` the
   * trial's condition (null: the module has none).
   */
  stimuli: { module: string; kind: string; onset: number; answerAt: number | null; cond: string | null }[];
  /** Presses scheduled but not yet sent. */
  pending: Set<number>;
}

declare global {
  interface Window {
    __bot?: BotState;
    /** Screen roots the driver has already acted on (a new screen is a new element). */
    __botSeen?: WeakSet<Element>;
  }
}

/** Subscribes the in-page reaction player (once per page load). */
export async function installReactionBot(page: Page, delayMs = 280): Promise<void> {
  await page.waitForFunction(() => window.__trainer !== undefined);
  await page.evaluate((delay) => {
    if (window.__bot !== undefined) {
      window.__bot.delayMs = delay;
      return;
    }
    const bot: BotState = { delayMs: delay, stimuli: [], pending: new Set() };
    window.__bot = bot;
    const keyName = (code: string): string => {
      if (code === 'Space') return ' ';
      if (code.startsWith('Key')) return code.slice(3).toLowerCase();
      if (code.startsWith('Digit')) return code.slice(5);
      return code;
    };
    const fire = (key: string): void => {
      if (key === 'MouseLeft' || key === 'MouseRight') {
        const button = key === 'MouseLeft' ? 0 : 2;
        const target = document.querySelector('.reaction canvas') ?? document.body;
        target.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true, cancelable: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true, cancelable: true }));
        return;
      }
      const target = document.activeElement ?? document.body;
      const init = { code: key, key: keyName(key), bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
    };
    const later = (key: string, ms: number): void => {
      const id = window.setTimeout(() => {
        bot.pending.delete(id);
        fire(key);
      }, ms);
      bot.pending.add(id);
    };
    window.__trainer?.onStimulus((e: StimulusEvent) => {
      const x = e.expected;
      const now = performance.now();
      const answerAt = x.kind === 'press' ? now + bot.delayMs : x.kind === 'timed' ? e.onset + x.targetOffsetMs : null;
      bot.stimuli.push({ module: e.module, kind: x.kind, onset: e.onset, answerAt, cond: e.cond ?? null });
      if (x.kind !== 'withhold' && answerAt !== null) later(x.key, Math.max(0, answerAt - now));
    });
  }, delayMs);
}

/** Changes the delay of later `press` answers (a longer one keeps a stimulus on screen for a screenshot). */
export async function setPressDelay(page: Page, delayMs: number): Promise<void> {
  await page.evaluate((ms) => {
    if (window.__bot !== undefined) window.__bot.delayMs = ms;
  }, delayMs);
}

/**
 * Drops the presses the bot has scheduled but not sent. Call it before interrupting a block: a press
 * left over from the interrupted block would land in the fresh one as a false start.
 */
export async function cancelPendingPresses(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bot = window.__bot;
    if (bot === undefined) return;
    for (const id of bot.pending) clearTimeout(id);
    bot.pending.clear();
  });
}

export type Screen =
  | 'none'
  | 'loading'
  | 'checking'
  | 'warn'
  | 'instruction'
  | 'reaction'
  | 'table'
  | 'series'
  /** A memory block (presentation and answers, every trial of the block). */
  | 'memory'
  /** The strategy lesson before the first 3×3 card (F13). */
  | 'lesson'
  | 'summary'
  | 'fatigue'
  | 'notice'
  /** A diagnostic reaction block with dropped frames is replayed once (headless Chromium can drop frames). */
  | 'replay'
  | 'pause'
  | 'save_error'
  | 'wellbeing'
  | 'done'
  | 'unknown';

/** Screens the driver acts on; the others it waits through. */
const ACTIONABLE: readonly Screen[] = [
  'warn',
  'instruction',
  'table',
  'series',
  'memory',
  'lesson',
  'summary',
  'fatigue',
  'replay',
  'wellbeing',
  'done',
];

/**
 * The current session screen. A screen that needs an action is returned once (`fresh`): the call marks
 * its root element, so the same screen is not acted on twice while the app is still busy with the first
 * action. `stopAt` is never marked.
 */
async function claimScreen(page: Page, stopAt: Screen): Promise<{ kind: Screen; fresh: boolean }> {
  return page.evaluate(({ actionable, stopAt }) => {
    const root = document.querySelector('.session')?.firstElementChild ?? null;
    if (root === null) return { kind: 'none' as const, fresh: false };
    const has = (c: string): boolean => root.classList.contains(c);
    const heading = root.querySelector('h2')?.textContent ?? '';
    const text = root.textContent;
    let kind: Screen;
    if (has('reaction')) kind = 'reaction';
    else if (has('table-screen')) kind = 'table';
    else if (has('series')) kind = 'series';
    else if (has('memory')) kind = 'memory';
    else if (has('lesson')) kind = 'lesson';
    else if (has('instruction')) kind = 'instruction';
    else if (has('summary')) kind = 'summary';
    else if (has('wellbeing')) kind = 'wellbeing';
    else if (has('done')) kind = 'done';
    else if (heading === 'Пауза') kind = 'pause';
    else if (heading === 'Усталость') kind = 'fatigue';
    else if (heading === 'Блок прерван') kind = 'notice';
    else if (heading === 'Повтор блока') kind = 'replay';
    else if (heading === 'Ошибка сохранения') kind = 'save_error';
    else if (text.includes('Проверка экрана')) kind = 'checking';
    else if (text.includes('Продолжить всё равно')) kind = 'warn';
    else if (text.includes('Загрузка')) kind = 'loading';
    else kind = 'unknown';
    if (!actionable.includes(kind)) return { kind, fresh: false };
    const seen = (window.__botSeen ??= new WeakSet());
    const fresh = !seen.has(root);
    // The screen the caller stops at is left unclaimed: the next playSession acts on it.
    if (kind !== stopAt) seen.add(root);
    return { kind, fresh };
  }, { actionable: ACTIONABLE, stopAt });
}

type TableTask = 'black_up' | 'red_down' | 'alternate' | 'schulte';
interface Cell {
  value: number;
  color: 'red' | 'black';
}

/** The click order of a table task (same rules as src/modules/tables/gorbov.ts taskSequence). */
export function tableOrder(task: TableTask, cellCount: number): Cell[] {
  switch (task) {
    case 'black_up':
      return Array.from({ length: 24 }, (_, i) => ({ value: i + 1, color: 'black' }));
    case 'red_down':
      return Array.from({ length: 25 }, (_, i) => ({ value: 25 - i, color: 'red' }));
    case 'alternate': {
      const seq: Cell[] = [];
      for (let i = 1; i <= 24; i++) seq.push({ value: i, color: 'black' }, { value: 26 - i, color: 'red' });
      seq.push({ value: 1, color: 'red' });
      return seq;
    }
    case 'schulte':
      return Array.from({ length: cellCount }, (_, i) => ({ value: i + 1, color: 'black' }));
  }
}

/** Clicks every cell of the table on screen in task order (the grid may reshuffle: each cell is looked up anew). */
export async function playTable(page: Page): Promise<void> {
  const grid = page.locator('.table-grid');
  const task = (await grid.getAttribute('data-task')) as TableTask | null;
  expect(task, 'table grid exposes data-task').not.toBeNull();
  const cellCount = await grid.locator('.table-cell').count();
  // The run starts at the first frame with the grid on screen; clicks before it are ignored.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => { requestAnimationFrame(() => { r(); }); })));
  for (const cell of tableOrder(task as TableTask, cellCount)) {
    await grid.locator(`.table-cell[data-value="${String(cell.value)}"][data-color="${cell.color}"]`).click();
  }
}

/**
 * Answers every item of the number-series block on screen with the exposed answer: a number typed, a letter item
 * (`data-answer-kind="letter"`) by the key event of the letter's ЙЦУКЕН key (F12).
 */
export async function playSeries(page: Page): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Ответ' });
  for (;;) {
    const item = await page.evaluate(() => {
      const el = document.querySelector('.series-item');
      if (el === null) return null;
      return {
        answer: el.getAttribute('data-e2e-answer'),
        kind: el.getAttribute('data-answer-kind'),
        counter: document.querySelector('.series .muted')?.textContent ?? '',
      };
    });
    if (item === null) return;
    expect(item.answer, 'number series exposes data-e2e-answer in e2e mode').not.toBeNull();
    const answer = item.answer ?? '';
    if (item.kind === 'letter') {
      await input.focus();
      await pressLetterKeys(page, [answer]);
      await expect(input).toHaveValue(answer);
    } else {
      await input.fill(answer);
    }
    await input.press('Enter');
    await page.waitForFunction(
      (counter) => document.querySelector('.series-item') === null || document.querySelector('.series .muted')?.textContent !== counter,
      item.counter,
    );
  }
}

/** What an English layout prints on the ЙЦУКЕН letter keys that are not letter keys there. */
const ENGLISH_PUNCTUATION: Readonly<Record<string, string>> = {
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
};

/**
 * The physical key of a letter on a ЙЦУКЕН keyboard (src/modules/numseries/letters.ts, the one letters source), with
 * what an English layout prints on it: the bot types like a user who never switched the layout (Review focus 1).
 */
function letterKey(letter: string): { code: string; key: string } | null {
  const code = LETTER_KEY_CODES[letter];
  if (code === undefined) return null;
  return { code, key: ENGLISH_PUNCTUATION[code] ?? code.replace(/^Key/, '').toLowerCase() };
}

/** Key events of the letters' keys on the focused element: `keyboard.type` sends no keydown for Cyrillic. */
async function pressLetterKeys(page: Page, letters: readonly string[]): Promise<void> {
  const keys = letters.flatMap((x) => letterKey(x) ?? []);
  expect(keys, `letters ${letters.join(',')} have keys`).toHaveLength(letters.length);
  await page.evaluate((events) => {
    for (const init of events) {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { ...init, bubbles: true, cancelable: true }));
    }
  }, keys);
}

/**
 * Plays the memory block on screen: waits for each response screen, reproduces the exposed row (digits and the 3×3
 * card, `data-mode="card3x3"`, typed; letters as key events of their ЙЦУКЕН keys — `keyboard.type` sends no keydown for
 * Cyrillic — cells clicked), sends it with Enter, and returns when the block's screen is gone.
 */
export async function playMemory(page: Page): Promise<void> {
  for (;;) {
    const next = await page.waitForFunction(() => {
      const root = document.querySelector('.session')?.firstElementChild ?? null;
      if (root === null || !root.classList.contains('memory')) return { done: true, answer: '', mode: '', counter: '' };
      const r = root.querySelector('.memory-response[data-e2e-answer]');
      if (r === null) return null;
      return {
        done: false,
        answer: r.getAttribute('data-e2e-answer') ?? '',
        mode: r.getAttribute('data-mode') ?? '',
        counter: r.querySelector('.muted')?.textContent ?? '',
      };
    });
    const trial = await next.jsonValue();
    // waitForFunction resolves on a truthy value only.
    if (trial === null || trial.done) return;
    const items = trial.answer.split(',');
    // Keys are listened to from the task after the response screen mounts.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => { requestAnimationFrame(() => { r(); }); })));
    if (trial.mode === 'positions') {
      for (const cell of items) await page.locator(`.memory-cell[data-cell="${cell}"]`).click();
    } else if (trial.mode === 'letters') {
      await pressLetterKeys(page, items);
    } else {
      await page.keyboard.type(items.join(''));
    }
    await page.keyboard.press('Enter');
    // This response leaves the screen: the next trial is shown, or (after the last one, once it is saved) the summary.
    await page.waitForFunction(
      (counter) => document.querySelector('.memory-response .muted')?.textContent !== counter,
      trial.counter,
    );
  }
}

/** «Экспорт данных» in Settings; returns the text of the trainer-export-*.json download (back on Home after). */
export async function exportedFile(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Настройки' }).click();
  const download = page.waitForEvent('download', { predicate: (d) => /^trainer-export-.*\.json$/.test(d.suggestedFilename()) });
  await page.getByRole('button', { name: 'Экспорт данных (JSON и CSV)' }).click();
  const path = await (await download).path();
  await page.getByRole('button', { name: 'Назад' }).click();
  return readFileSync(path, 'utf8');
}

/** On Settings: picks `text` as the export file through the restore button's file dialog. */
export async function chooseExportFile(page: Page, text: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Восстановить из файла экспорта' }).click();
  await (await chooser).setFiles({ name: 'trainer-export.json', mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
}

/**
 * An export file with a training history: each session at local noon `daysAgo` local calendar days before the page's
 * today, in the page's time zone (the app counts days there, whatever this process's zone is), ended 10 minutes
 * later, with its blocks a minute apart. A block takes the given fields over a ПЗМР block at level 0. Written by the
 * app's own exportBundle, so a restore reads it as a real file.
 */
export async function historyBundle(page: Page, o: { sessions: { daysAgo: number; blocks?: Partial<BlockRow>[] }[] }): Promise<string> {
  const noons = await page.evaluate(
    (days) =>
      days.map((n) => {
        const d = new Date();
        d.setDate(d.getDate() - n);
        d.setHours(12, 0, 0, 0);
        return d.getTime();
      }),
    o.sessions.map((s) => s.daysAgo),
  );
  const repo = new MemoryRepository();
  for (const [i, s] of o.sessions.entries()) {
    const start = noons[i] as number;
    const at = (minutes: number): string => new Date(start + minutes * 60_000).toISOString();
    const sessionId = `e2e-session-${String(i)}`;
    await repo.createSession({ id: sessionId, startedAt: at(0), endedAt: at(10), kind: 'training', phase: 'base', appVersion: '0.2.0' });
    for (const [k, over] of (s.blocks ?? []).entries()) {
      const row: BlockRow = {
        id: `${sessionId}-block-${String(k)}`,
        sessionId,
        module: 'pzmr',
        lBefore: 0,
        lAfter: 0,
        paramsJson: '{}',
        score: 1,
        flags: [],
        startedAt: at(k + 1),
        summaryJson: '{}',
        ...over,
      };
      await repo.addBlock(row, [], []);
    }
  }
  return exportBundle(repo, '0.2.0');
}

/** Settings → the file → «Восстановить» → «Готово.» → «Назад»: back on Home with the history of `text`. */
export async function restoreBundle(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Настройки' }).click();
  await chooseExportFile(page, text);
  await page.getByRole('button', { name: 'Восстановить', exact: true }).click();
  await expect(page.getByText(/^Готово\./)).toBeVisible();
  await page.getByRole('button', { name: 'Назад' }).click();
  await expect(page.getByRole('button', { name: 'Начать тренировку' })).toBeVisible();
}

/** The page's local date `days` from today, YYYY-MM-DD (the app counts days in the page's time zone). */
export async function pageDate(page: Page, days: number): Promise<string> {
  return page.evaluate((n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const two = (x: number): string => String(x).padStart(2, '0');
    return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  }, days);
}

export async function fillWellbeing(page: Page): Promise<void> {
  await page.getByRole('spinbutton', { name: 'Сон прошлой ночью, часов' }).fill('7.5');
  await page.getByRole('radio', { name: 'Нет', exact: true }).check();
  await page.getByRole('radio', { name: '4', exact: true }).check();
  await page.getByRole('button', { name: 'Сохранить' }).click();
}

export interface PlayOptions {
  /** Called once per screen before the bot acts on it (screenshots, checks). */
  onScreen?: (kind: Screen) => Promise<void>;
  /** Stop (without acting) when this screen comes up; default 'done'. */
  stopAt?: Screen;
  /** Wellbeing answers (default) or «Пропустить». */
  wellbeing?: 'fill' | 'skip';
  timeoutMs?: number;
}

/**
 * Plays the session on screen to the end (`done`, left on screen) or until `stopAt`. Fails on an
 * interruption notice, a save error, a pause or an unknown screen: a perfect player never sees them.
 */
export async function playSession(page: Page, o: PlayOptions = {}): Promise<Screen[]> {
  const stopAt = o.stopAt ?? 'done';
  const deadline = Date.now() + (o.timeoutMs ?? 150_000);
  const seen: Screen[] = [];
  let last: Screen = 'none';
  for (;;) {
    if (Date.now() > deadline) throw new Error(`playSession: timed out; screens so far: ${seen.join(' → ')}`);
    const { kind, fresh } = await claimScreen(page, stopAt);
    if (kind !== last) {
      seen.push(kind);
      last = kind;
    }
    if (kind === stopAt) {
      if (fresh && o.onScreen !== undefined) await o.onScreen(kind);
      return seen;
    }
    if (kind === 'notice' || kind === 'save_error' || kind === 'pause' || kind === 'unknown') {
      const text = await page.locator('.session').innerText();
      throw new Error(`playSession: unexpected ${kind} screen: ${text}`);
    }
    if (!fresh) {
      await page.waitForTimeout(20);
      continue;
    }
    if (o.onScreen !== undefined) await o.onScreen(kind);
    switch (kind) {
      case 'warn':
        await page.getByRole('button', { name: 'Продолжить всё равно' }).click();
        break;
      case 'instruction':
        await page.getByRole('button', { name: 'Начать (Enter)' }).click();
        break;
      case 'table':
        await playTable(page);
        break;
      case 'series':
        await playSeries(page);
        break;
      case 'memory':
        await playMemory(page);
        break;
      case 'lesson':
        await page.getByRole('button', { name: 'Понятно (Enter)' }).click();
        break;
      case 'summary':
        await page.getByRole('button', { name: 'Дальше' }).click();
        break;
      case 'fatigue':
        await page.getByRole('button', { name: 'Продолжить' }).click();
        break;
      case 'replay':
        await page.getByRole('button', { name: 'Дальше (Enter)' }).click();
        break;
      case 'wellbeing':
        if (o.wellbeing === 'skip') await page.getByRole('button', { name: 'Пропустить' }).click();
        else await fillWellbeing(page);
        break;
      case 'done':
        return seen;
      default:
        break;
    }
  }
}

/** Opens the app in e2e mode and waits for Home with the reaction bot installed. */
export async function openApp(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Начать тренировку' })).toBeVisible();
  await installReactionBot(page);
}
