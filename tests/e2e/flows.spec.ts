import type { Page } from '@playwright/test';
import { cancelPendingPresses, openApp, playSession, type Screen } from './bot';
import { E2E_URL, expect, test } from './fixtures';

// Whole sessions at scale 0.02 still take tens of seconds each.
test.describe.configure({ timeout: 240_000 });

const home = (page: Page) => page.getByRole('button', { name: 'Начать тренировку' });

/** Every block summary the bot reaches says 100 %: the bot plays perfectly, so anything less is a bug. */
function checkSummaries(page: Page, titles: string[]): (kind: Screen) => Promise<void> {
  return async (kind) => {
    if (kind !== 'summary') return;
    const summary = page.locator('.summary');
    titles.push(await summary.locator('h2').innerText());
    await expect(summary.getByText(/^Успешно: \d+ %$/)).toHaveText('Успешно: 100 %');
  };
}

async function runDiagnostic(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Контрольная диагностика' }).click();
  const titles: string[] = [];
  await playSession(page, { onScreen: checkSummaries(page, titles) });
  await expect(page.getByRole('heading', { name: 'Сессия завершена' })).toBeVisible();
  const results = page.getByRole('table', { name: 'Результаты диагностики' });
  await expect(results.locator('tbody tr')).toHaveCount(8);
  // Every indicator has a value: the diagnostic covered all six modules.
  await expect(results).not.toContainText('нет данных');
  expect(titles.length).toBeGreaterThanOrEqual(6);
}

/** Waits until the reaction bot has seen at least `n` stimuli. */
async function waitForStimuli(page: Page, n: number): Promise<void> {
  await page.waitForFunction((count) => (window.__bot?.stimuli.length ?? 0) >= count, n);
}

test('full training session at scale 0.02 reaches done and wellbeing', async ({ page }) => {
  await openApp(page, E2E_URL);
  await expect(page.getByText('Серия: 0 дн.')).toBeVisible();
  await home(page).click();
  const titles: string[] = [];
  const screens = await playSession(page, { onScreen: checkSummaries(page, titles) });
  expect(screens).toContain('wellbeing');
  expect(screens.indexOf('wellbeing')).toBeLessThan(screens.lastIndexOf('done'));
  await expect(page.getByRole('heading', { name: 'Сессия завершена' })).toBeVisible();
  // Planned segments: ПЗМР, two of СЗМР / Go/No-Go / РДО, Горбов, Шульте, ряды.
  const lines = page.getByRole('list', { name: 'Итог по модулям' }).getByRole('listitem');
  await expect(lines).toHaveCount(6);
  await expect(lines.first()).toContainText('ПЗМР: блоков');
  for (const module of ['ПЗМР', 'Красно-чёрные таблицы Горбова', 'Таблицы Шульте', 'Числовые ряды']) {
    expect(titles.some((t) => t.includes(module)), `a ${module} block was played`).toBe(true);
  }
  await page.getByRole('button', { name: 'На главную' }).click();
  await expect(page.getByText('Серия: 1 дн.')).toBeVisible();
});

test('diagnostic run writes results and home shows readiness', async ({ page }) => {
  await openApp(page, E2E_URL);
  await expect(page.getByText('Пройди диагностику, чтобы увидеть индекс')).toBeVisible();
  // First diagnostic = the baseline; the second is scored against it.
  await runDiagnostic(page);
  await page.getByRole('button', { name: 'На главную' }).click();
  await expect(home(page)).toBeVisible();
  await runDiagnostic(page);
  await page.getByRole('button', { name: 'На главную' }).click();

  const readiness = page.locator('.readiness');
  await expect(readiness).toBeVisible();
  for (const ability of ['Реакция', 'Внимание', 'Переключение', 'Логика']) {
    const value = readiness.locator('div').filter({ has: page.getByText(ability, { exact: true }) }).locator('dd');
    await expect(value, ability).toHaveText(/^\d+$/);
  }
  await expect(readiness.locator('div').filter({ hasText: 'Память' }).locator('dd')).toHaveText('появится позже');
  await expect(page.getByText(/^Общий индекс: \d+$/)).toBeVisible();
  await expect(page.getByText('Пора пройти контрольную диагностику')).toHaveCount(0);
});

test('free training of rdo', async ({ page }) => {
  await openApp(page, E2E_URL);
  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: 'Реакция на движущийся объект' }).click();
  const titles: string[] = [];
  const screens = await playSession(page, { onScreen: checkSummaries(page, titles) });
  expect(screens).not.toContain('wellbeing');
  expect(titles.length).toBeGreaterThan(0);
  expect(new Set(titles)).toEqual(new Set(['Реакция на движущийся объект']));
  const kinds = await page.evaluate(() => [...new Set(window.__bot?.stimuli.map((s) => `${s.module}:${s.kind}`))]);
  expect(kinds).toEqual(['rdo:timed']);
  await expect(page.getByRole('list', { name: 'Итог по модулям' })).toContainText('Реакция на движущийся объект: блоков');
  await page.getByRole('button', { name: 'На главную' }).click();
  await expect(home(page)).toBeVisible();
});

test('free training of Струп reaches a summary with 100 %', async ({ page }) => {
  await openApp(page, E2E_URL);
  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: 'Струп' }).click();
  const titles: string[] = [];
  const screens = await playSession(page, { onScreen: checkSummaries(page, titles) });
  expect(screens).toContain('summary');
  expect(new Set(titles)).toEqual(new Set(['Струп']));
  const kinds = await page.evaluate(() => [...new Set(window.__bot?.stimuli.map((s) => `${s.module}:${s.kind}`))]);
  expect(kinds).toEqual(['stroop:press']);
  await expect(page.getByRole('list', { name: 'Итог по модулям' })).toContainText('Струп: блоков');
});

test('settings layout pult changes key hints to arrows', async ({ page }) => {
  await openApp(page, E2E_URL);
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('radio', { name: 'Пульт (стрелки и цифры)' }).check();
  await page.getByRole('button', { name: 'Назад' }).click();
  await home(page).click();
  await playSession(page, { stopAt: 'instruction' });
  await expect(page.locator('.instruction')).toContainText('Управление: ↓');
  await expect(page.locator('.instruction')).not.toContainText('Пробел');
  // The bot presses the block's expected key: ArrowDown.
  const titles: string[] = [];
  await playSession(page, { stopAt: 'summary', onScreen: checkSummaries(page, titles) });
  expect(titles).toEqual(['ПЗМР']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Завершить сессию' }).click();
  await expect(home(page)).toBeVisible();
});

test('focus loss mid-block shows repeat message', async ({ page }) => {
  await openApp(page, E2E_URL);
  await home(page).click();
  await playSession(page, { stopAt: 'reaction' });
  await waitForStimuli(page, 1);
  await cancelPendingPresses(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByRole('heading', { name: 'Блок прерван' })).toBeVisible();
  await expect(page.getByText('Окно потеряло фокус. Блок будет повторён.')).toBeVisible();
  await page.getByRole('button', { name: 'Дальше (Enter)' }).click();
  // A fresh block is played to the end.
  const titles: string[] = [];
  await playSession(page, { stopAt: 'summary', onScreen: checkSummaries(page, titles) });
  expect(titles).toEqual(['ПЗМР']);
});

test('escape pauses and the pause menu resumes or ends the session', async ({ page }) => {
  await openApp(page, E2E_URL);
  await home(page).click();
  await playSession(page, { stopAt: 'instruction' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Пауза' })).toBeVisible();
  await expect(page.getByText('Уже сохранённые блоки не пропадут.')).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(page.locator('.instruction')).toBeVisible();

  // Escape inside a running block throws the block away.
  await page.getByRole('button', { name: 'Начать (Enter)' }).click();
  await waitForStimuli(page, 1);
  await cancelPendingPresses(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Пауза' })).toBeVisible();
  await expect(page.getByText('Блок начнётся заново. Уже сохранённые блоки не пропадут.')).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить блок заново' }).click();
  const titles: string[] = [];
  await playSession(page, { stopAt: 'summary', onScreen: checkSummaries(page, titles) });
  expect(titles).toEqual(['ПЗМР']);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Пауза' })).toBeVisible();
  await page.getByRole('button', { name: 'Завершить сессию' }).click();
  await expect(home(page)).toBeVisible();
});

test('progress shows charts after a diagnostic', async ({ page }) => {
  await openApp(page, E2E_URL);
  await page.getByRole('button', { name: 'Прогресс' }).click();
  await expect(page.getByText('Сессий пока нет')).toBeVisible();
  await page.getByRole('button', { name: 'Назад' }).click();

  await runDiagnostic(page);
  await page.getByRole('button', { name: 'На главную' }).click();
  await page.getByRole('button', { name: 'Прогресс' }).click();
  const diagnostics = page.getByRole('region', { name: 'Контрольные диагностики' });
  await expect(diagnostics.locator('.chart-card').first()).toBeVisible();
  const cards = await diagnostics.locator('.chart-card').all();
  expect(cards.length).toBeGreaterThan(0);
  // Every chart has the diagnostic's point(s): no indicator is missing.
  for (const card of cards) {
    await expect(card.locator('.chart-empty')).toHaveCount(0);
    expect(await card.locator('.chart-point').count()).toBeGreaterThan(0);
  }
  await expect(page.getByRole('table', { name: 'История сессий' }).locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('.readiness')).toBeVisible();
});
