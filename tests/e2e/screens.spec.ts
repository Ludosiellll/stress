import type { JSHandle, Page } from '@playwright/test';
import type { BlockRow } from '../../src/data/rows';
import type { ModuleId } from '../../src/engine/types';
import {
  cancelPendingPresses,
  chooseExportFile,
  exportedFile,
  historyBundle,
  openApp,
  pageDate,
  playSession,
  restoreBundle,
  setPressDelay,
  type Screen,
} from './bot';
import { NORM_HINTS } from '../../src/engine/norms';
import { E2E_URL, escapeUntil, expect, expectFitsWidth, freshPage, lineCount, pauseWithEscape, shot, test } from './fixtures';

/**
 * Screenshots of every screen at 1280×800 into test-results/screens/<name>.png for the visual check
 * (CI uploads them as the e2e-screens artifact). The test only checks that each file was written.
 */

test.describe.configure({ timeout: 240_000 });

/** Waits for the next stimulus of `module`, shoots it, and checks it was still on screen afterwards. */
async function shootStimulus(page: Page, module: string, name: string): Promise<void> {
  const seen = await page.evaluate((m) => window.__bot?.stimuli.filter((s) => s.module === m).length ?? 0, module);
  await page.waitForFunction(
    ({ m, n }) => (window.__bot?.stimuli.filter((s) => s.module === m).length ?? 0) > n,
    { m: module, n: seen },
    { polling: 'raf' },
  );
  await shot(page, name);
  const onScreen = await page.evaluate((m) => {
    const last = window.__bot?.stimuli.filter((s) => s.module === m).at(-1);
    return last?.answerAt != null && performance.now() < last.answerAt;
  }, module);
  expect(onScreen, `${name}: the stimulus was still shown when the screenshot was taken`).toBe(true);
}

/**
 * Starts blocks from their instructions until the instruction of `title` is on screen (and, with `text`,
 * its instruction contains `text`: memory blocks share the title and differ by mode).
 */
async function untilInstruction(page: Page, title: string, text?: string, onScreen?: (kind: Screen) => Promise<void>): Promise<void> {
  for (;;) {
    await playSession(page, { stopAt: 'instruction', ...(onScreen === undefined ? {} : { onScreen }) });
    const heading = await page.locator('.instruction h2').innerText();
    if (heading === title && (text === undefined || (await page.locator('.instruction').innerText()).includes(text))) return;
    await page.getByRole('button', { name: 'Начать (Enter)' }).click();
    await expect(page.locator('.instruction h2')).toHaveCount(0);
  }
}

/** Ends the session from the block summary on display (Escape → «Завершить сессию») and waits for Home. */
async function endSessionFromSummary(page: Page): Promise<void> {
  await pauseWithEscape(page);
  await page.getByRole('button', { name: 'Завершить сессию' }).click();
  await expect(page.getByRole('button', { name: 'Начать тренировку' })).toBeVisible();
}

/** Clicks «Начать (Enter)» on the instruction on screen. */
async function begin(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Начать (Enter)' }).click();
}

/** What a full-screen canvas shows, read from its pixels (colours as 0xRRGGBB; the tests run at device scale 1). */
interface Look {
  /** performance.now() of the read. */
  at: number;
  /** A hash of every pixel: the same picture gives the same hash. */
  hash: number;
  /** Pixels that differ from the corner pixel (the background). */
  ink: number;
  /** The pixel in the centre (the stimulus). */
  center: number;
  /**
   * A pixel inside the noise-free central zone (radius 0.2 of the shorter side) but outside the stimulus
   * (0.15 to the right of the centre): the background shade, never covered by a distractor.
   */
  zone: number;
  /** Near-white pixels where the task-switching rule word is drawn (0.22 of the shorter side above the centre). */
  ruleInk: number;
}

declare global {
  interface Window {
    __look?: (selector: string) => Look | null;
  }
}

/** Installs `window.__look` (once per page). */
async function installLook(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__look = (selector) => {
      const canvas = document.querySelector<HTMLCanvasElement>(selector);
      const ctx = canvas?.getContext('2d') ?? null;
      if (canvas === null || ctx === null || canvas.width === 0 || canvas.height === 0) return null;
      const { width: w, height: h } = canvas;
      const data = ctx.getImageData(0, 0, w, h).data;
      const rgb = (i: number): number => ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
      const at = (x: number, y: number): number => rgb((Math.round(y) * w + Math.round(x)) * 4);
      const side = Math.min(w, h);
      const corner = rgb(0);
      let hash = 0;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        const v = rgb(i);
        hash = (Math.imul(hash, 31) + v) | 0;
        if (v !== corner) ink++;
      }
      let ruleInk = 0;
      const ry = h / 2 - 0.22 * side;
      for (let y = Math.round(ry - 0.04 * side); y <= ry + 0.04 * side; y++) {
        for (let x = Math.round(w / 2 - 0.25 * side); x <= w / 2 + 0.25 * side; x++) {
          const i = (y * w + x) * 4;
          if ((data[i] ?? 0) > 230 && (data[i + 1] ?? 0) > 230 && (data[i + 2] ?? 0) > 230) ruleInk++;
        }
      }
      return { at: performance.now(), hash, ink, center: at(w / 2, h / 2), zone: at(w / 2 + 0.15 * side, h / 2), ruleInk };
    };
  });
}

/** The lighter flicker shade: FLICKER_BACKGROUND (#3a3a3a) of src/runtime/canvasRenderer.ts. */
const FLICKER_SHADE = 0x3a3a3a;

/** Polls `fn(arg)` in the page every frame until it returns a value (not null) and returns that value. */
async function waitValue<T, A>(page: Page, fn: (arg: A) => T | null, arg: A, timeout: number): Promise<T> {
  // Playwright types the page function's argument as Unboxed<A>, which equals A for the plain values passed here.
  const poll = page.waitForFunction.bind(page) as (f: typeof fn, a: A, o: { polling: 'raf'; timeout: number }) => Promise<JSHandle<T | null>>;
  const value = await (await poll(fn, arg, { polling: 'raf', timeout })).jsonValue();
  // waitForFunction resolves on a truthy value only.
  if (value === null) throw new Error('waitValue: resolved without a value');
  return value;
}

/**
 * Shoots a noisy Помехоустойчивость trial with the stimulus and the lighter flicker shade on screen. The shot
 * counts when the trial's stimulus and the shade are there before and after it, less than one flicker phase
 * (250 ms) apart, so the shade cannot have changed in between; otherwise the next noisy trial is tried.
 */
async function shootNoisy(page: Page, name: string): Promise<void> {
  const ok = (l: Look | null): l is Look => l !== null && l.zone === FLICKER_SHADE && l.center !== FLICKER_SHADE;
  for (let attempt = 0; attempt < 8; attempt++) {
    const seen = await page.evaluate(() => window.__bot?.stimuli.length ?? 0);
    // The page function cannot see FLICKER_SHADE: it is passed in with the stimulus count.
    const before = await waitValue(
      page,
      ({ n, shade }) => {
        const s = window.__bot?.stimuli ?? [];
        const last = s.at(-1);
        if (s.length <= n || last === undefined || last.cond !== 'noisy' || last.answerAt === null) return null;
        if (performance.now() >= last.answerAt) return null;
        const l = window.__look?.('.reaction canvas') ?? null;
        return l !== null && l.zone === shade && l.center !== shade ? { look: l, index: s.length } : null;
      },
      { n: seen, shade: FLICKER_SHADE },
      60_000,
    );
    await shot(page, name);
    const after = await page.evaluate((i) => {
      const last = window.__bot?.stimuli.at(-1);
      const onScreen = window.__bot?.stimuli.length === i && last?.answerAt != null && performance.now() < last.answerAt;
      return { look: window.__look?.('.reaction canvas') ?? null, onScreen };
    }, before.index);
    if (after.onScreen && ok(after.look) && after.look.at - before.look.at < 250) return;
  }
  throw new Error(`${name}: no noisy trial held the flicker shade through the screenshot`);
}

/**
 * Shoots the task-switching cue alone: the rule word on screen, no figure yet. The shot counts when the canvas
 * shows the cue alone before and after it, less than the shortest gap between two cues apart (the figure stays
 * until the press, then the next cue comes no sooner than 500 ms later); otherwise the next cue is tried.
 */
async function shootCue(page: Page, name: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = await waitValue(
      page,
      () => {
        const l = window.__look?.('.reaction canvas') ?? null;
        return l !== null && l.ruleInk > 100 && l.center === l.zone ? l : null;
      },
      null,
      60_000,
    );
    await shot(page, name);
    const after = await page.evaluate(() => window.__look?.('.reaction canvas') ?? null);
    if (after !== null && after.hash === before.hash && after.at - before.at < 400) return;
  }
  throw new Error(`${name}: no cue stayed alone on screen through the screenshot`);
}

/** Trials a memory shot may use: the e2e blocks have 3 (max(3, round(n·scale))). */
const MEMORY_SHOT_ATTEMPTS = 3;

/**
 * Shoots a memory trial's pictures: with `fixation`, the cross (500 ms on screen), and the first row picture (a
 * digit, the grid with a lit cell, or the card) as `row`. A shot counts when the canvas shows the same picture
 * after the screenshot as before it; otherwise the trial is answered and the picture still missing is shot in the
 * next trial, at most MEMORY_SHOT_ATTEMPTS trials (as shootNoisy and shootCue retry). The cross is the first
 * picture of every trial and the same picture each time, so a row picture is any non-blank one that differs from
 * it. Returns with the trial of the last shot still to be answered.
 */
async function shootMemoryTrial(page: Page, names: { fixation?: string; row: string }): Promise<void> {
  const look = (): Promise<Look | null> => page.evaluate(() => window.__look?.('.memory canvas') ?? null);
  const held = async (name: string, before: Look): Promise<boolean> => {
    await shot(page, name);
    return (await look())?.hash === before.hash;
  };
  let cross: number | null = null;
  let crossShot = names.fixation === undefined;
  for (let attempt = 0; attempt < MEMORY_SHOT_ATTEMPTS; attempt++) {
    const first: Look = await waitValue(
      page,
      (known: number | null) => {
        const l = window.__look?.('.memory canvas') ?? null;
        return l !== null && l.ink > 0 && (known === null || l.hash === known) ? l : null;
      },
      cross,
      30_000,
    );
    cross = first.hash;
    if (!crossShot && names.fixation !== undefined) {
      crossShot = await held(names.fixation, first);
      if (!crossShot) {
        await answerMemoryTrial(page, null);
        continue;
      }
    }
    const row: Look = await waitValue(
      page,
      (c: number) => {
        const l = window.__look?.('.memory canvas') ?? null;
        return l !== null && l.ink > 0 && l.hash !== c ? l : null;
      },
      cross,
      30_000,
    );
    if (await held(names.row, row)) return;
    await answerMemoryTrial(page, null);
  }
  throw new Error(`${names.row}: the memory picture changed during the screenshot in ${String(MEMORY_SHOT_ATTEMPTS)} trials`);
}

/**
 * Answers the memory trial now shown or waiting for its answer with the exposed row (digits typed, cells
 * clicked); with a `name`, shoots the filled answer screen before sending it. Then waits for the screen to move on.
 */
async function answerMemoryTrial(page: Page, name: string | null): Promise<void> {
  const response = page.locator('.memory-response[data-e2e-answer]');
  // A row of up to 4 items at 1000 + 250 ms each after the 500 ms cross may still be on screen.
  await expect(response).toBeVisible({ timeout: 30_000 });
  const items = ((await response.getAttribute('data-e2e-answer')) ?? '').split(',');
  const mode = await response.getAttribute('data-mode');
  const counter = await response.locator('.muted').innerText();
  // Keys are listened to from the task after the response screen mounts.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => { requestAnimationFrame(() => { r(); }); })));
  if (mode === 'positions') {
    for (const cell of items) await page.locator(`.memory-cell[data-cell="${cell}"]`).click();
    await expect(page.locator('.memory-cell.chosen')).toHaveCount(items.length);
    // Answer cells stay at least 48 px (W2 readability rule) on the 1280×800 laptop screen.
    for (const cell of await page.locator('.memory-cell').all()) {
      const box = await cell.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
    }
  } else {
    await page.keyboard.type(items.join(''));
    await expect(page.getByLabel('Ответ')).toHaveText(items.join(''));
  }
  if (name !== null) await shot(page, name);
  await page.keyboard.press('Enter');
  await page.waitForFunction((c) => document.querySelector('.memory-response .muted')?.textContent !== c, counter);
}

test('screens: home, settings, free, a diagnostic with every block view, progress, restore preview', async ({ page, browser }) => {
  // A whole diagnostic of ten segments with waits for the shots, then an export and a fresh page.
  test.setTimeout(360_000);
  await openApp(page, E2E_URL);
  await installLook(page);
  await expect(page.getByText('Фаза: база')).toBeVisible();
  await shot(page, 'home');

  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Проверить тайминги (3 с)' }).click();
  await expect(page.getByText(/^Частота: \d+ Гц$/)).toBeVisible({ timeout: 10_000 });
  await shot(page, 'settings');
  // The whole «Звук» section in the middle of the screen (it starts at the bottom edge of the first screen).
  const sound = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Звук' }) });
  await sound.evaluate((el) => { el.scrollIntoView({ block: 'center' }); });
  await expect(sound).toBeInViewport({ ratio: 1 });
  await shot(page, 'settings-sound');
  await page.getByRole('button', { name: 'Назад' }).click();

  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await expect(page.getByRole('heading', { name: 'Свободная тренировка' })).toBeVisible();
  await shot(page, 'free');
  await page.getByRole('button', { name: 'Назад' }).click();

  await page.getByRole('button', { name: 'Контрольная диагностика' }).click();
  await untilInstruction(page, 'ПЗМР');
  await shot(page, 'instruction');
  // A long press delay keeps the first circle on screen for the shot (window 1000 ms at level 0).
  await setPressDelay(page, 800);
  await page.getByRole('button', { name: 'Начать (Enter)' }).click();
  await shootStimulus(page, 'pzmr', 'reaction-pzmr');
  // Escape restarts the task once (F11): the notice, then a second Escape shows the hint at the top of the running block.
  await cancelPendingPresses(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Повтор блока' })).toBeVisible();
  await shot(page, 'notice-diagnostic-restart');
  await page.getByRole('button', { name: 'Дальше (Enter)' }).click();
  await expect(page.locator('.reaction canvas')).toBeVisible();
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => { requestAnimationFrame(() => { r(); }); })));
  const hint = page.getByText('Перезапуск уже использован — доведи задание до конца.');
  await escapeUntil(page, hint);
  await shootStimulus(page, 'pzmr', 'reaction-restart-used-hint');
  await setPressDelay(page, 280);

  let summaryShot = false;
  await playSession(page, {
    stopAt: 'instruction',
    onScreen: async (kind) => {
      if (kind === 'summary' && !summaryShot) {
        summaryShot = true;
        await shot(page, 'summary');
      }
    },
  });
  expect(summaryShot).toBe(true);
  await untilInstruction(page, 'Реакция на движущийся объект');
  await page.getByRole('button', { name: 'Начать (Enter)' }).click();
  await shootStimulus(page, 'rdo', 'reaction-rdo');

  await playSession(page, { stopAt: 'table' });
  await expect(page.locator('.table-grid')).toHaveAttribute('data-task', 'black_up');
  await shot(page, 'table-gorbov');

  await playSession(page, { stopAt: 'series' });
  await shot(page, 'numseries');

  // The W2 segments at their diagnostic levels: Помехоустойчивость L 8 (7 figures, flicker; window 456 ms),
  // Струп L 8 (3 colours, key legend; 1099 ms), Переключение правил L 5 (cue 475 ms ahead; 1369 ms).
  // Presses at 350 ms keep a 106 ms margin to the 456 ms window under a loaded runner; shootNoisy retries a
  // trial whose stimulus went before the shot was done.
  await untilInstruction(page, 'Помехоустойчивость');
  await setPressDelay(page, 350);
  await begin(page);
  await shootNoisy(page, 'reaction-pomeh-noisy');
  await setPressDelay(page, 280);

  await untilInstruction(page, 'Струп');
  await setPressDelay(page, 800);
  await begin(page);
  await shootStimulus(page, 'stroop', 'reaction-stroop');
  await expect(page.locator('.reaction-legend')).toBeVisible();
  await setPressDelay(page, 280);

  await untilInstruction(page, 'Переключение правил');
  await setPressDelay(page, 800);
  await begin(page);
  await shootCue(page, 'reaction-taskswitch-cue');
  await shootStimulus(page, 'taskswitch', 'reaction-taskswitch');
  await setPressDelay(page, 280);

  // The span protocol: digits only.
  await untilInstruction(page, 'Память');
  await begin(page);
  await shootMemoryTrial(page, { fixation: 'memory-fixation', row: 'memory-digit' });
  await answerMemoryTrial(page, 'memory-answer-digits');

  await playSession(page, {
    onScreen: async (kind) => {
      if (kind !== 'done') return;
      const results = page.getByRole('table', { name: 'Результаты диагностики' });
      await expect(results.locator('tbody tr')).toHaveCount(12);
      // The restart by Escape is in its row; the details lines under the table; the table fits without a scroll.
      await expect(results.locator('tbody tr').first().locator('td').last()).toHaveText('да');
      await expectFitsWidth(page.locator('.screen-center.done'), '«Сессия завершена»');
      await shot(page, 'done-diagnostic');
      await results.evaluate((el) => { el.scrollIntoView({ block: 'start' }); });
      await shot(page, 'done-diagnostic-table');
      const details = page.getByRole('list', { name: 'Подробности диагностики' });
      await expect(details.getByRole('listitem')).toHaveCount(4);
      await details.evaluate((el) => { el.scrollIntoView({ block: 'center' }); });
      await shot(page, 'done-diagnostic-details');
    },
  });
  await expect(page.getByRole('table', { name: 'Результаты диагностики' })).toBeVisible();
  await page.getByRole('button', { name: 'На главную' }).click();
  await expect(page.locator('.readiness')).toBeVisible();
  await shot(page, 'home-with-data');

  await page.getByRole('button', { name: 'Прогресс' }).click();
  await expect(page.locator('.chart-point').first()).toBeVisible();
  await shot(page, 'progress');
  await shot(page, 'progress-full', true);
  // The W2 diagnostic charts: Помехоустойчивость, Струп, Переключение правил, Память.
  const pomehChart = page.locator('.chart-card').filter({ hasText: 'Помехоустойчивость: разница, мс' });
  await pomehChart.scrollIntoViewIfNeeded();
  for (const title of ['Помехоустойчивость: разница, мс', 'Струп: интерференция, мс', 'Переключение правил: цена переключения, мс', 'Память: объём']) {
    await expect(page.locator('.chart-card').filter({ hasText: title }).locator('.chart-point'), title).not.toHaveCount(0);
  }
  await shot(page, 'progress-new-charts');
  await page.getByRole('button', { name: 'Назад' }).click();

  // The restore preview: this page's export, chosen in a fresh page with no history.
  const text = await exportedFile(page);
  const fresh = await freshPage(browser);
  await fresh.page.getByRole('button', { name: 'Настройки' }).click();
  await chooseExportFile(fresh.page, text);
  await expect(fresh.page.getByText(/^В файле:/)).toHaveText(/Новых: 1, уже есть: 0\./);
  await fresh.page.getByRole('heading', { name: 'Восстановление из файла экспорта' }).scrollIntoViewIfNeeded();
  await expect(fresh.page.getByRole('button', { name: 'Восстановить', exact: true })).toBeInViewport();
  await shot(fresh.page, 'settings-restore-preview');
  await fresh.close();
  expect(fresh.errors, 'console errors of the fresh page').toEqual([]);
});

test('screens: a training session with pause, wellbeing and done; schulte', async ({ page }) => {
  await openApp(page, E2E_URL);
  await page.getByRole('button', { name: 'Начать тренировку' }).click();
  await playSession(page, { stopAt: 'instruction' });
  await pauseWithEscape(page);
  await shot(page, 'pause');
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();

  // The first summary of the day is ПЗМР's, the longest one: six metric lines and the «Оценка» of a first block
  // (step, goal, two norm lines, history). On a 720 px high window «Дальше» is reached by scrolling the session.
  let summaryShot = false;
  await playSession(page, {
    stopAt: 'wellbeing',
    onScreen: async (kind) => {
      if (kind !== 'summary' || summaryShot) return;
      summaryShot = true;
      await expect(page.locator('.summary h2')).toHaveText('ПЗМР');
      await shot(page, 'summary-training');
      await page.setViewportSize({ width: 1280, height: 720 });
      await shot(page, 'summary-training-720');
      const next = page.getByRole('button', { name: 'Дальше' });
      await next.scrollIntoViewIfNeeded();
      await expect(next).toBeInViewport({ ratio: 1 });
      await expect(page.getByText('Enter — дальше')).toBeInViewport({ ratio: 1 });
      await shot(page, 'summary-training-720-scrolled');
      await page.setViewportSize({ width: 1280, height: 800 });
    },
  });
  expect(summaryShot).toBe(true);
  await shot(page, 'wellbeing');
  await playSession(page, { onScreen: async (kind) => { if (kind === 'done') await shot(page, 'done-training'); } });
  await expect(page.getByRole('heading', { name: 'Сессия завершена' })).toBeVisible();
  await page.getByRole('button', { name: 'На главную' }).click();

  /** The grid size of every Шульте table played; the bot finishes each one. */
  const grids: number[] = [];
  const recordGrid = async (kind: Screen): Promise<void> => {
    if (kind === 'table') grids.push(Math.round(Math.sqrt(await page.locator('.table-grid .table-cell').count())));
  };
  // The first days' plan has no Шульте (W2-R11): the table is opened from free training.
  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: 'Таблицы Шульте' }).click();
  await untilInstruction(page, 'Таблицы Шульте');
  await page.getByRole('button', { name: 'Начать (Enter)' }).click();
  await expect(page.locator('.table-grid')).toHaveAttribute('data-task', 'schulte');
  await shot(page, 'table-schulte');
  // The first Шульте session ends after its first summary, so exactly one 5×5 block is stored before the second (A-R4).
  await playSession(page, { stopAt: 'summary', onScreen: recordGrid });
  await endSessionFromSummary(page);

  // The second session's first block is compared with the first one and gets the paper norm.
  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: 'Таблицы Шульте' }).click();
  await playSession(page, { stopAt: 'summary', onScreen: recordGrid });
  const assessment = page.getByRole('list', { name: 'Оценка' }).getByRole('listitem');
  await expect(assessment.filter({ hasText: 'Раньше в этом блоке: прошлый раз' })).toHaveCount(1);
  await expect(assessment.filter({ hasText: NORM_HINTS.schulte5 })).toHaveCount(1);
  await shot(page, 'summary-assessment');
  // The rest of the session is played through to «Сессия завершена» (FW12). The bot is fast, so the level may pass 8
  // and the grid grow to 6×6.
  await playSession(page, { onScreen: recordGrid });
  await expect(page.getByRole('heading', { name: 'Сессия завершена' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Итог по модулям' }).getByRole('listitem')).toHaveText([/^Таблицы Шульте: блоков \d+, уровень /]);
  await page.getByRole('button', { name: 'На главную' }).click();

  // «Прогресс» shows the largest finished grid.
  expect(grids[0]).toBe(5);
  const n = String(Math.max(...grids));
  await page.getByRole('button', { name: 'Прогресс' }).click();
  const schulte = page.getByRole('table', { name: 'Оценка по модулям' }).getByRole('row', { name: new RegExp(`^Таблицы Шульте — ${n}×${n} `) });
  await expect(schulte.getByRole('cell').filter({ hasText: /^\d+,\d\sс \/ \d+,\d\sс$/ })).toHaveCount(1);
  // Trained and untrained modules side by side: the right-aligned column («282 мс / 282 мс», «ещё не
  // тренировался») keeps each cell on one line.
  const cells = page.getByRole('table', { name: 'Оценка по модулям' }).locator('tbody td.num');
  await expect(cells.filter({ hasText: 'ещё не тренировался' })).not.toHaveCount(0);
  for (const cell of await cells.all()) {
    expect(await lineCount(cell), await cell.innerText()).toBe(1);
  }
  // Trained rows too: the table fits its section at 1280×800, the page does not scroll sideways (A-R24).
  await expectFitsWidth(page.getByRole('region', { name: 'Оценка по модулям' }), '«Оценка по модулям»');
  await expectFitsWidth(page.locator('html'), 'the page');
  await shot(page, 'progress-assessment', true);
});

declare global {
  interface Window {
    __markInk?: () => { at: number; ink: number } | null;
  }
}

/**
 * Installs `window.__markInk` (once per page): the pixels of the mark's colour (MARK_COLOR #bdbdbd of
 * src/runtime/canvasRenderer.ts) in the rows around 5/6 of the reaction canvas's height, where the mark after a trial
 * is drawn (F15, Р23), with the time of the read; null without a canvas.
 */
async function installMarkInk(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__markInk = () => {
      const canvas = document.querySelector<HTMLCanvasElement>('.reaction canvas');
      const ctx = canvas?.getContext('2d') ?? null;
      if (canvas === null || ctx === null || canvas.width === 0 || canvas.height === 0) return null;
      const { width: w, height: h } = canvas;
      const side = Math.min(w, h);
      const data = ctx.getImageData(0, Math.round((5 * h) / 6 - 0.04 * side), w, Math.round(0.08 * side)).data;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === 0xbd && data[i + 1] === 0xbd && data[i + 2] === 0xbd) ink++;
      }
      return { at: performance.now(), ink };
    };
  });
}

/**
 * Shoots the mark after a trial (F15): it is on screen 150 ms. The shot counts when the mark is there before and after
 * it, less than its 150 ms apart, so it was on screen throughout; otherwise the next trial's mark is tried.
 */
async function shootMark(page: Page, name: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = await waitValue(
      page,
      () => {
        const m = window.__markInk?.() ?? null;
        return m !== null && m.ink > 50 ? m : null;
      },
      null,
      30_000,
    );
    await shot(page, name);
    const after = await page.evaluate(() => window.__markInk?.() ?? null);
    if (after !== null && after.ink > 50 && after.at - before.at < 150) return;
  }
  throw new Error(`${name}: no mark stayed on screen through the screenshot`);
}

/**
 * Shoots the next stimulus of `module` that stays on screen through the shot (the bot answers it `delay` ms after its
 * onset); otherwise the next one is tried.
 */
async function shootStimulusRetry(page: Page, module: string, name: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const seen = await page.evaluate((m) => window.__bot?.stimuli.filter((s) => s.module === m).length ?? 0, module);
    await page.waitForFunction(
      ({ m, n }) => (window.__bot?.stimuli.filter((s) => s.module === m).length ?? 0) > n,
      { m: module, n: seen },
      { polling: 'raf' },
    );
    await shot(page, name);
    const onScreen = await page.evaluate((m) => {
      const last = window.__bot?.stimuli.filter((s) => s.module === m).at(-1);
      return last?.answerAt != null && performance.now() < last.answerAt;
    }, module);
    if (onScreen) return;
  }
  throw new Error(`${name}: no stimulus stayed on screen through the screenshot`);
}

/** 20 clean hit RTs around `median` (±30 ms), as a stored block keeps them. */
const hitsAround = (median: number): number[] => Array.from({ length: 20 }, (_, i) => median - 30 + 3 * i + (i % 2));

/**
 * The history of a user on day 23 of the course (eight training days, so today plays the primary layout): ПЗМР at level
 * 14 on load band 3 since the first day of 0.3.0 (the day before had a 0.2.0 block without a band, so the level chart
 * has its break), a warm-up on every day (the form of the day and the window floor of band 3, about 1.2 × 440 ms), five
 * test-format runs (today's is СЗМР), РДО at each speed, a block counted as 0 and two restarts, one overload block.
 */
function trainingHistory(): { daysAgo: number; blocks: Partial<BlockRow>[] }[] {
  const band3 = JSON.stringify({ band: 3, bandLabel: 'интервал 0,3–3 с, помехи', layout: 'keyboard' });
  const warmup = (median: number): Partial<BlockRow> => ({
    module: 'pzmr',
    lBefore: 13,
    lAfter: 13,
    flags: ['warmup'],
    paramsJson: band3,
    summaryJson: JSON.stringify({ cleanHitRts: hitsAround(median) }),
  });
  const pzmrBlock = (median: number, summary: Record<string, unknown> = {}): Partial<BlockRow> => ({
    module: 'pzmr',
    lBefore: 13,
    lAfter: 14,
    paramsJson: band3,
    summaryJson: JSON.stringify({ cleanHitRts: hitsAround(median), ...summary }),
  });
  const run = (module: ModuleId, mean: number): Partial<BlockRow> => ({
    module,
    flags: ['test_format'],
    summaryJson: JSON.stringify({ testFormat: { mean, sd: 30 + (mean % 7), errors: 1, falseStarts: 0, thirds: [mean, mean, mean] } }),
  });
  const rdo = (periodMs: number, bias: number): Partial<BlockRow> => ({
    module: 'rdo',
    lBefore: 5,
    lAfter: 5,
    paramsJson: JSON.stringify({ periodMs, layout: 'keyboard' }),
    summaryJson: JSON.stringify({ meanSignedErrorMs: bias, meanAbsErrorMs: Math.abs(bias) + 20 }),
  });
  const counts = { hit: 14, wrong: 2, miss: 2, late: 1, false_start: 1, commission: 0, correct_reject: 0, early: 0, timing_late: 0 };
  return [
    { daysAgo: 22, blocks: [{ module: 'pzmr', lBefore: 10, lAfter: 12 }] },
    { daysAgo: 20, blocks: [run('pzmr', 262), warmup(450), pzmrBlock(445)] },
    { daysAgo: 16, blocks: [run('szmr', 400), warmup(440), pzmrBlock(440)] },
    { daysAgo: 12, blocks: [run('pzmr', 255), warmup(430), pzmrBlock(435), rdo(1500, -14)] },
    { daysAgo: 10, blocks: [warmup(445), pzmrBlock(440), rdo(2000, -6)] },
    {
      daysAgo: 8,
      blocks: [run('gonogo', 330), warmup(425), { module: 'gonogo', lBefore: 3, lAfter: 1, flags: ['discarded'], summaryJson: JSON.stringify({ discarded: { reason: 'user', progress: 0.45 } }) }, pzmrBlock(430), rdo(3000, 3)],
    },
    {
      daysAgo: 4,
      blocks: [
        run('pzmr', 248),
        warmup(435),
        { module: 'szmr', lBefore: 6, lAfter: 6, flags: ['overload'], paramsJson: JSON.stringify({ band: 1, loadBand: 2 }), summaryJson: JSON.stringify({ counts }) },
        pzmrBlock(430, { restarts: [{ reason: 'user', progress: 0.1 }, { reason: 'focus_lost', progress: 0.5 }] }),
        rdo(4000, 11),
      ],
    },
    { daysAgo: 2, blocks: [warmup(440), pzmrBlock(435)] },
  ];
}

test('screens: the 0.3.0 training screens: run, warm-up, errors and floor, marks, counted Esc, Progress', async ({ page }) => {
  // A run, a warm-up, two free sessions and «Прогресс» at scale 0.3 (ПЗМР blocks of 5 signals).
  test.setTimeout(360_000);
  await openApp(page, '/?e2e=1&scale=0.3');
  await installMarkInk(page);
  await restoreBundle(page, await historyBundle(page, { sessions: trainingHistory() }));
  const plan = page.getByRole('list', { name: 'План на сегодня' }).getByRole('listitem');
  await expect(plan.first()).toHaveText(/^Прогон в формате теста: СЗМР, \d+\sсигналов \(около 3\sмин\)$/);
  await shot(page, 'home-test-format-day');

  // The run opens the session: its instruction, its block, its summary with the bests of the one earlier СЗМР run.
  await page.getByRole('button', { name: 'Начать тренировку' }).click();
  await playSession(page, { stopAt: 'instruction' });
  await expect(page.locator('.instruction')).toContainText('Прогон в формате теста:');
  await shot(page, 'instruction-test-format');
  await playSession(page, { stopAt: 'summary' });
  const summary = page.locator('.summary');
  await expect(summary.locator('h2')).toHaveText('Прогон в формате теста · СЗМР');
  await expect(summary.getByRole('list', { name: 'Показатели' }).getByRole('listitem').first()).toContainText('(лучшее 400)');
  await shot(page, 'summary-test-format');
  await page.getByRole('button', { name: 'Дальше' }).click();

  // The warm-up at L_saved − 1 = 13 (band 3): the form of the day against the usual one, the window on its floor.
  await playSession(page, { stopAt: 'summary' });
  await expect(summary.locator('h2')).toHaveText('ПЗМР');
  const lines = summary.getByRole('list', { name: 'Показатели' });
  await expect(lines).toContainText(/Форма дня: медиана \d+\sмс \(обычно \d+\) · разброс \d+\sмс \(обычно \d+\) — /);
  await expect(lines).toContainText(/Окно ответа: \d+\sмс — твой минимум для этой нагрузки \(по уровню — 219\sмс\)\./);
  await shot(page, 'summary-warmup');
  await endSessionFromSummary(page);

  // Free ПЗМР at L 13: far distractors and the jittered circle; one false start («рано»), then hits on the floor.
  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: 'ПЗМР', exact: true }).click();
  await playSession(page, { stopAt: 'instruction' });
  await setPressDelay(page, 40);
  await begin(page);
  await shootMark(page, 'reaction-mark-early');
  // The circle answered 450 ms after onset, inside the floor window: on screen long enough for the shot.
  await setPressDelay(page, 450);
  await shootStimulusRetry(page, 'pzmr', 'reaction-pzmr-jitter-noise');
  await setPressDelay(page, 280);
  await playSession(page, { stopAt: 'summary' });
  await expect(lines.getByRole('listitem').first()).toHaveText(/^Ошибки: фальстарты — [1-9]\. Штраф −\d+ из \d+, балл \d,\d\d\.$/);
  await expect(lines).toContainText('твой минимум для этой нагрузки');
  await shot(page, 'summary-errors-floor');

  // The next block, stopped after 2 of its 5 signals: counted as 0, the level drops.
  const shown = await page.evaluate(() => window.__bot?.stimuli.length ?? 0);
  await page.getByRole('button', { name: 'Дальше' }).click();
  await playSession(page, { stopAt: 'reaction' });
  await page.waitForFunction((n) => (window.__bot?.stimuli.length ?? 0) >= n, shown + 2);
  await cancelPendingPresses(page);
  await pauseWithEscape(page);
  await expect(page.getByText(/^Блок прерван на \d+\s% — засчитан как 0, уровень [\d,]+\s→\s[\d,]+\.$/)).toBeVisible();
  await shot(page, 'pause-counted');
  await page.getByRole('button', { name: 'Завершить сессию' }).click();
  await expect(page.getByRole('button', { name: 'Начать тренировку' })).toBeVisible();

  // Free Струп at L 0, with the key legend: every press 40 ms after the word is early, and «рано» clears the legend.
  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: 'Струп' }).click();
  await playSession(page, { stopAt: 'instruction' });
  await setPressDelay(page, 40);
  await begin(page);
  await expect(page.locator('.reaction-legend')).toBeVisible();
  await shootMark(page, 'reaction-mark-legend');
  const legendTop = await page.locator('.reaction-legend').evaluate((el) => el.getBoundingClientRect().top);
  // The mark: bold text 0.06 of the shorter side high, centred at 5/6 of the height.
  expect((5 * 800) / 6 + 0.03 * 800, 'the mark ends above the key legend').toBeLessThan(legendTop);
  await cancelPendingPresses(page);
  await setPressDelay(page, 280);
  await pauseWithEscape(page);
  await page.getByRole('button', { name: 'Завершить сессию' }).click();
  await expect(page.getByRole('button', { name: 'Начать тренировку' })).toBeVisible();

  // «Прогресс»: each new section on its own, then the page; nothing sticks out sideways.
  await page.getByRole('button', { name: 'Прогресс' }).click();
  await expect(page.locator('.chart-point').first()).toBeVisible();
  await expectFitsWidth(page.locator('html'), 'the page');
  const section = (heading: string) => page.locator('section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) }).last();
  await expect(section('Форма дня').locator('.chart-band')).not.toHaveCount(0);
  await section('Форма дня').screenshot({ path: 'test-results/screens/progress-form-of-day.png' });
  await expect(section('Прогоны в формате теста').locator('.chart-band')).not.toHaveCount(0);
  await section('Прогоны в формате теста').screenshot({ path: 'test-results/screens/progress-test-format.png' });
  const levels = section('Уровни по модулям');
  await expect(levels.getByText(/^1,5\sс: −14\sмс \(1\sблок\) · 2\sс: −6\sмс \(1\sблок\) · 3\sс: \+3\sмс \(1\sблок\) · 4\sс: \+11\sмс \(1\sблок\)$/)).toBeVisible();
  await expect(levels.locator('.chart-marker')).not.toHaveCount(0);
  await levels.screenshot({ path: 'test-results/screens/progress-levels.png' });
  const discards = section('Прерванные блоки по неделям');
  await discards.screenshot({ path: 'test-results/screens/progress-discards.png' });
  await shot(page, 'progress-0.3.0-full', true);
});

test('screens: the overload phase on Home; memory grid, card and grid answer', async ({ page }) => {
  // Scale 0.3: a 90 s memory budget reaches the third block (digits → positions → card).
  await openApp(page, '/?e2e=1&scale=0.3');
  await installLook(page);
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByLabel('Дата теста').fill(await pageDate(page, 20));
  await page.getByRole('button', { name: 'Назад' }).click();
  await expect(page.getByText('Фаза: перегрузка')).toBeVisible();
  await shot(page, 'home-phase-overload');

  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: 'Память' }).click();
  await untilInstruction(page, 'Память', 'Клетки загораются');
  await begin(page);
  await shootMemoryTrial(page, { row: 'memory-grid' });
  await answerMemoryTrial(page, 'memory-answer-grid');

  // The lesson comes once, before the first 3×3 card (F13).
  let lessonShot = false;
  await untilInstruction(page, 'Память', 'На карточке', async (kind) => {
    if (kind !== 'lesson') return;
    lessonShot = true;
    await shot(page, 'memory-lesson');
  });
  expect(lessonShot).toBe(true);
  await shot(page, 'instruction-memory-card');
  await begin(page);
  await shootMemoryTrial(page, { row: 'memory-card' });
  await pauseWithEscape(page);
  await page.getByRole('button', { name: 'Завершить сессию' }).click();
  await expect(page.getByRole('button', { name: 'Начать тренировку' })).toBeVisible();
});
