import type { Page } from '@playwright/test';
import { chooseExportFile, exportedFile, openApp, playSession } from './bot';
import { E2E_URL, expect, freshPage, test } from './fixtures';

/**
 * Restore from an export file in the web build (Task 14): the file a page saved with «Экспорт данных» is loaded
 * into a fresh page, whose memory starts empty, through Settings.
 */

// Free trainings at scale 0.02 still take tens of seconds each.
test.describe.configure({ timeout: 240_000 });

const home = (page: Page) => page.getByRole('button', { name: 'Начать тренировку' });

/** Plays one free training of `module` to its end screen and goes back to Home. */
async function freeTraining(page: Page, module: string): Promise<void> {
  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: module, exact: true }).click();
  await playSession(page);
  await page.getByRole('button', { name: 'На главную' }).click();
  await expect(home(page)).toBeVisible();
}

/** The rows of «История сессий» as [date, type, blocks], or [] when there are none. */
async function sessionLines(page: Page): Promise<string[][]> {
  await page.getByRole('button', { name: 'Прогресс' }).click();
  await expect(page.getByRole('heading', { name: 'История сессий' })).toBeVisible();
  const rows = page.getByRole('table', { name: 'История сессий' }).locator('tbody tr');
  const lines: string[][] = [];
  for (const row of await rows.all()) {
    const cells = await row.locator('td').allInnerTexts();
    lines.push([cells[0] ?? '', cells[1] ?? '', cells[3] ?? '']);
  }
  await page.getByRole('button', { name: 'Назад' }).click();
  await expect(home(page)).toBeVisible();
  return lines;
}

/** Settings → file → preview → «Восстановить» → the result; back on Home afterwards. */
async function restore(page: Page, text: string, preview: RegExp, result: RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Настройки' }).click();
  await chooseExportFile(page, text);
  await expect(page.getByText(/^В файле:/)).toHaveText(preview);
  await page.getByRole('button', { name: 'Восстановить', exact: true }).click();
  await expect(page.getByText(/^Готово\./)).toHaveText(result);
  await page.getByRole('button', { name: 'Назад' }).click();
  await expect(home(page)).toBeVisible();
}

test('export in one page, restore in a fresh page, Progress shows the same sessions', async ({ page, browser }) => {
  await openApp(page, E2E_URL);
  await freeTraining(page, 'ПЗМР');
  await freeTraining(page, 'Струп');
  const expected = await sessionLines(page);
  expect(expected).toHaveLength(2);
  const text = await exportedFile(page);

  const b = await freshPage(browser);
  expect(await sessionLines(b.page)).toEqual([]);
  await restore(b.page, text, /^В файле: 2 сессии .* Новых: 2, уже есть: 0\./, /^Готово\. Добавлено сессий: 2, блоков: [1-9]\d*, /);
  expect(await sessionLines(b.page)).toEqual(expected);
  await b.close();
  expect(b.errors, 'console errors of the fresh page').toEqual([]);
});

test('restoring the same file twice adds nothing', async ({ page, browser }) => {
  await openApp(page, E2E_URL);
  await freeTraining(page, 'ПЗМР');
  const text = await exportedFile(page);

  const b = await freshPage(browser);
  await restore(b.page, text, /^В файле: 1 сессия .* Новых: 1, уже есть: 0\./, /^Готово\. Добавлено сессий: 1, /);
  const once = await sessionLines(b.page);
  await restore(
    b.page,
    text,
    /^В файле: 1 сессия .* Новых: 0, уже есть: 1\. Блоков: (\d+), новых 0\./,
    /^Готово\. Добавлено сессий: 0, блоков: 0, диагностик: 0, записей самочувствия: 0\. Пропущено \(уже были\): сессий 1, блоков [1-9]\d*\.$/,
  );
  expect(await sessionLines(b.page)).toEqual(once);
  await b.close();
  expect(b.errors, 'console errors of the fresh page').toEqual([]);
});

test('a damaged file shows the error and changes nothing', async ({ page }) => {
  await openApp(page, E2E_URL);
  await page.getByRole('button', { name: 'Настройки' }).click();
  await chooseExportFile(page, '{"appVersion": "0.2.0", "sessions": [');
  await expect(page.getByRole('alert')).toHaveText('Файл не читается как JSON.');
  await expect(page.getByRole('button', { name: 'Восстановить', exact: true })).toHaveCount(0);

  const badRow = {
    appVersion: '0.2.0',
    exportedAt: '2026-10-14T10:00:00.000Z',
    sessions: [{ id: 's1', startedAt: 'вчера', endedAt: null, kind: 'free', phase: 'none', appVersion: '0.2.0' }],
    blocks: [],
    trials: [],
    logicItems: [],
    diagnostics: [],
    wellbeing: [],
    settings: {},
  };
  await chooseExportFile(page, JSON.stringify(badRow));
  await expect(page.getByRole('alert')).toHaveText(
    'Запись sessions[0]: поле startedAt должно быть датой и временем ISO, например 2026-10-14T09:00:00.000Z.',
  );
  await expect(page.getByRole('button', { name: 'Восстановить', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Назад' }).click();
  expect(await sessionLines(page)).toEqual([]);
});
