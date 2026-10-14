import { existsSync, statSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { chooseExportFile, exportedFile, openApp, pageDate, playSession, setPressDelay } from './bot';
import { E2E_URL, expect, freshPage, test } from './fixtures';

/**
 * Screenshots of every screen at 1280×800 into test-results/screens/<name>.png for the visual check
 * (CI uploads them as the e2e-screens artifact). The test only checks that each file was written.
 */

test.describe.configure({ timeout: 240_000 });

const DIR = 'test-results/screens';

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  const path = `${DIR}/${name}.png`;
  await page.screenshot({ path, fullPage });
  expect(existsSync(path), path).toBe(true);
  expect(statSync(path).size, path).toBeGreaterThan(1000);
}

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
async function untilInstruction(page: Page, title: string, text?: string): Promise<void> {
  for (;;) {
    await playSession(page, { stopAt: 'instruction' });
    const heading = await page.locator('.instruction h2').innerText();
    if (heading === title && (text === undefined || (await page.locator('.instruction').innerText()).includes(text))) return;
    await page.getByRole('button', { name: 'Начать (Enter)' }).click();
    await expect(page.locator('.instruction h2')).toHaveCount(0);
  }
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

const FLICKER_SHADE = 0x3a3a3a;

/** Polls `fn(arg)` in the page every frame until it returns a value (not null) and returns that value. */
async function waitValue<T>(page: Page, fn: (arg: number | null) => T | null, arg: number | null, timeout: number): Promise<T> {
  const value = await (await page.waitForFunction(fn, arg, { polling: 'raf', timeout })).jsonValue();
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
    const before = await waitValue(
      page,
      (n) => {
        const s = window.__bot?.stimuli ?? [];
        const last = s.at(-1);
        if (n === null || s.length <= n || last === undefined || last.cond !== 'noisy' || last.answerAt === null) return null;
        if (performance.now() >= last.answerAt) return null;
        const l = window.__look?.('.reaction canvas') ?? null;
        return l !== null && l.zone === 0x3a3a3a && l.center !== 0x3a3a3a ? { look: l, index: s.length } : null;
      },
      seen,
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

/**
 * Waits for the next memory canvas picture that is not blank and differs from `previous` (null: any picture);
 * with a `name`, shoots it and checks it was still on screen afterwards. Returns its hash.
 */
async function shootMemoryFrame(page: Page, name: string | null, previous: number | null): Promise<number> {
  const before = await waitValue(
    page,
    (prev) => {
      const l = window.__look?.('.memory canvas') ?? null;
      return l !== null && l.ink > 0 && l.hash !== prev ? l : null;
    },
    previous,
    30_000,
  );
  if (name === null) return before.hash;
  await shot(page, name);
  const after = await page.evaluate(() => window.__look?.('.memory canvas') ?? null);
  expect(after?.hash, `${name}: the picture was still on screen when the screenshot was taken`).toBe(before.hash);
  return before.hash;
}

/**
 * Answers the memory trial now waiting for its answer with the exposed row (digits typed, cells clicked),
 * shoots the filled answer screen before sending it, then waits for the screen to move on.
 */
async function answerMemoryTrial(page: Page, name: string): Promise<void> {
  const response = page.locator('.memory-response[data-e2e-answer]');
  await expect(response).toBeVisible();
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
  await shot(page, name);
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
  await untilInstruction(page, 'Помехоустойчивость');
  await setPressDelay(page, 400);
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
  const fixation = await shootMemoryFrame(page, 'memory-fixation', null);
  await shootMemoryFrame(page, 'memory-digit', fixation);
  await answerMemoryTrial(page, 'memory-answer-digits');

  await playSession(page, {
    onScreen: async (kind) => {
      if (kind !== 'done') return;
      await expect(page.getByRole('table', { name: 'Результаты диагностики' }).locator('tbody tr')).toHaveCount(12);
      await shot(page, 'done-diagnostic');
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
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Пауза' })).toBeVisible();
  await shot(page, 'pause');
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();

  await playSession(page, { stopAt: 'wellbeing' });
  await shot(page, 'wellbeing');
  await playSession(page, { onScreen: async (kind) => { if (kind === 'done') await shot(page, 'done-training'); } });
  await expect(page.getByRole('heading', { name: 'Сессия завершена' })).toBeVisible();
  await page.getByRole('button', { name: 'На главную' }).click();

  // The first days' plan has no Шульте (W2-R11): the table is opened from free training.
  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: 'Таблицы Шульте' }).click();
  await untilInstruction(page, 'Таблицы Шульте');
  await page.getByRole('button', { name: 'Начать (Enter)' }).click();
  await expect(page.locator('.table-grid')).toHaveAttribute('data-task', 'schulte');
  await shot(page, 'table-schulte');
  await playSession(page);
  await expect(page.getByRole('heading', { name: 'Сессия завершена' })).toBeVisible();
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
  const fixation = await shootMemoryFrame(page, null, null);
  await shootMemoryFrame(page, 'memory-grid', fixation);
  await answerMemoryTrial(page, 'memory-answer-grid');

  await untilInstruction(page, 'Память', 'На карточке');
  await begin(page);
  const cardFixation = await shootMemoryFrame(page, null, null);
  await shootMemoryFrame(page, 'memory-card', cardFixation);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Завершить сессию' }).click();
  await expect(page.getByRole('button', { name: 'Начать тренировку' })).toBeVisible();
});
