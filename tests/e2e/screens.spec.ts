import { existsSync, statSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { openApp, playSession, setPressDelay } from './bot';
import { E2E_URL, expect, test } from './fixtures';

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

/** Starts blocks from their instructions until the instruction of `title` is on screen. */
async function untilInstruction(page: Page, title: string): Promise<void> {
  for (;;) {
    await playSession(page, { stopAt: 'instruction' });
    const heading = await page.locator('.instruction h2').innerText();
    if (heading === title) return;
    await page.getByRole('button', { name: 'Начать (Enter)' }).click();
    await expect(page.locator('.instruction h2')).toHaveCount(0);
  }
}

test('screens: home, settings, free, a diagnostic with every block view, progress', async ({ page }) => {
  await openApp(page, E2E_URL);
  await shot(page, 'home');

  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Проверить тайминги (3 с)' }).click();
  await expect(page.getByText(/^Частота: \d+ Гц$/)).toBeVisible({ timeout: 10_000 });
  await shot(page, 'settings');
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

  await playSession(page, { onScreen: async (kind) => { if (kind === 'done') await shot(page, 'done-diagnostic'); } });
  await expect(page.getByRole('table', { name: 'Результаты диагностики' })).toBeVisible();
  await page.getByRole('button', { name: 'На главную' }).click();
  await expect(page.locator('.readiness')).toBeVisible();
  await shot(page, 'home-with-data');

  await page.getByRole('button', { name: 'Прогресс' }).click();
  await expect(page.locator('.chart-point').first()).toBeVisible();
  await shot(page, 'progress');
  await shot(page, 'progress-full', true);
});

test('screens: a training session with pause, schulte, wellbeing and done', async ({ page }) => {
  await openApp(page, E2E_URL);
  await page.getByRole('button', { name: 'Начать тренировку' }).click();
  await playSession(page, { stopAt: 'instruction' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Пауза' })).toBeVisible();
  await shot(page, 'pause');
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();

  await untilInstruction(page, 'Таблицы Шульте');
  await page.getByRole('button', { name: 'Начать (Enter)' }).click();
  await expect(page.locator('.table-grid')).toHaveAttribute('data-task', 'schulte');
  await shot(page, 'table-schulte');

  await playSession(page, { stopAt: 'wellbeing' });
  await shot(page, 'wellbeing');
  await playSession(page, { onScreen: async (kind) => { if (kind === 'done') await shot(page, 'done-training'); } });
  await expect(page.getByRole('heading', { name: 'Сессия завершена' })).toBeVisible();
});
