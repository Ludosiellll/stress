import type { Page } from '@playwright/test';
import { cancelPendingPresses, openApp, pageDate, playSession, type Screen } from './bot';
import { E2E_URL, expect, expectFitsWidth, lineCount, pauseWithEscape, shot, test } from './fixtures';

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

/** A whole diagnostic: the six 0.1.0 segments, then Помехоустойчивость, Струп, Переключение правил and the span protocol. */
async function runDiagnostic(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Контрольная диагностика' }).click();
  const titles: string[] = [];
  await playSession(page, { onScreen: checkSummaries(page, titles), timeoutMs: 300_000 });
  await expect(page.getByRole('heading', { name: 'Сессия завершена' })).toBeVisible();
  const results = page.getByRole('table', { name: 'Результаты диагностики' });
  await expect(results.locator('tbody tr')).toHaveCount(12);
  // Every indicator has a value: the diagnostic covered all ten modules, each condition with enough RTs.
  await expect(results).not.toContainText('нет данных');
  await expect(page.getByText(/^Индекс: \d+/)).toBeVisible();
  expect(titles.length).toBeGreaterThanOrEqual(10);
  for (const module of ['Помехоустойчивость', 'Струп', 'Переключение правил', 'Память']) {
    expect(titles, `a ${module} block was played`).toContain(module);
  }
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
  // The first day's plan («База», no history): ПЗМР, СЗМР, Go/No-Go, Горбов, Память, ряды; no finisher.
  const lines = page.getByRole('list', { name: 'Итог по модулям' }).getByRole('listitem');
  await expect(lines).toHaveCount(6);
  await expect(lines.first()).toContainText('ПЗМР: блоков');
  for (const module of ['ПЗМР', 'Сложная реакция (СЗМР)', 'Go/No-Go', 'Красно-чёрные таблицы Горбова', 'Память', 'Числовые ряды']) {
    expect(titles.some((t) => t.includes(module)), `a ${module} block was played`).toBe(true);
  }
  await page.getByRole('button', { name: 'На главную' }).click();
  await expect(page.getByText('Серия: 1 дн.')).toBeVisible();
});

test('a test date in 20 days shows the overload phase on Home', async ({ page }) => {
  await openApp(page, E2E_URL);
  await expect(page.getByText('Фаза: база')).toBeVisible();
  await expect(page.getByText('День 1 из 14: калибровка уровней и стартовая диагностика.')).toBeVisible();

  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByLabel('Дата теста').fill(await pageDate(page, 20));
  await page.getByRole('button', { name: 'Назад' }).click();
  await expect(page.getByText('Фаза: перегрузка')).toBeVisible();
  await expect(page.getByText('До теста 20 дн.: модули реакции по 6 мин.')).toBeVisible();
  // The reason counts the days, so there is no second countdown under the plan.
  await expect(page.getByText(/До теста/)).toHaveCount(1);
  // No module has 3 blocks yet, so there is no finisher; the reaction segments are 6 minutes long.
  await expect(page.getByRole('list', { name: 'План на сегодня' }).getByRole('listitem')).toHaveText([
    'ПЗМР — 2 мин',
    'Сложная реакция (СЗМР) — 6 мин',
    'Go/No-Go — 6 мин',
    'Красно-чёрные таблицы Горбова — 5 мин',
    'Память — 5 мин',
    'Числовые ряды — 10 мин',
  ]);

  // Clearing the date brings the first days' phase back at once.
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Очистить' }).click();
  await page.getByRole('button', { name: 'Назад' }).click();
  await expect(page.getByText('Фаза: база')).toBeVisible();
  await expect(page.getByText(/До теста/)).toHaveCount(0);
});

test('diagnostic run writes results and home shows readiness', async ({ page }) => {
  // Two whole diagnostics of ten segments each.
  test.setTimeout(480_000);
  await openApp(page, E2E_URL);
  await expect(page.getByText('Пройди диагностику, чтобы увидеть индекс')).toBeVisible();
  // First diagnostic = the baseline; the second is scored against it.
  await runDiagnostic(page);
  await expect(page.getByText('Первая диагностика — сравнивать пока не с чем')).toBeVisible();
  await page.getByRole('button', { name: 'На главную' }).click();
  await expect(home(page)).toBeVisible();
  await runDiagnostic(page);
  // The second one is compared with the first.
  await expect(page.getByRole('columnheader', { name: /^Прошлая \(№1, \d\d\.\d\d\.\d{4}\)$/ })).toBeVisible();
  // Columns: Показатель, Результат, Прошлая, Изменение, Ориентир. Both diagnostics have every value, so every
  // row has a change (Δ = 0 in the shown rounding reads «без изменений», A-R3).
  const rows = page.getByRole('table', { name: 'Результаты диагностики' }).locator('tbody tr');
  await expect(rows).toHaveCount(12);
  for (const row of await rows.all()) {
    const change = row.locator('td').nth(3);
    // A unit follows its number after a no-break space (A-R22): \s matches it.
    await expect(change).toHaveText(/^(без изменений|[+−][\d,]+(\s(мс|с|%))?, (лучше|хуже))$/);
    // A change reads at a glance: never broken over two lines.
    expect(await lineCount(change), await change.innerText()).toBe(1);
  }
  await expect(page.getByText(/^Индекс: \d+ \(прошлый — \d+\)$/)).toBeVisible();
  // At 1280×800 the five columns fit the screen: neither the results nor the session scroll sideways (A-R24), and
  // no header or cell wraps past two lines (in a 760 px column the labels, «Прошлая (№…)» and the norms take three).
  await expectFitsWidth(page.locator('.screen-center.done'), '«Сессия завершена»');
  await expectFitsWidth(page.locator('.session'), '.session');
  for (const cell of await page.getByRole('table', { name: 'Результаты диагностики' }).locator('th, td').all()) {
    expect(await lineCount(cell), await cell.innerText()).toBeLessThanOrEqual(2);
  }
  // The table from its header row: «На главную» has the focus, which scrolls the screen to the bottom.
  await page.getByRole('table', { name: 'Результаты диагностики' }).evaluate((el) => { el.scrollIntoView({ block: 'start' }); });
  await shot(page, 'done-diagnostic-compare');
  await page.getByRole('button', { name: 'На главную' }).click();

  const readiness = page.locator('.readiness');
  await expect(readiness).toBeVisible();
  for (const ability of ['Реакция', 'Внимание', 'Переключение', 'Память', 'Логика']) {
    const value = readiness.locator('div').filter({ has: page.getByText(ability, { exact: true }) }).locator('dd');
    await expect(value, ability).toHaveText(/^\d+$/);
  }
  await expect(page.getByText(/^Общий индекс: \d+$/)).toBeVisible();
  await expect(page.getByText('Пора пройти контрольную диагностику')).toHaveCount(0);
});

test('free training of rdo shows the assessment and compares with the previous session', async ({ page }) => {
  // Two whole free sessions of РДО.
  test.setTimeout(360_000);
  await openApp(page, E2E_URL);
  /**
   * Every block summary of both sessions in order: its «Оценка» lines and whether it was marked «Замер ненадёжен»
   * (headless Chromium can drop frames; such a block stays out of the history).
   */
  const blocks: { session: number; lines: string[]; unreliable: boolean }[] = [];
  for (let session = 0; session < 2; session++) {
    await page.getByRole('button', { name: 'Свободная тренировка' }).click();
    await page.getByRole('button', { name: 'Реакция на движущийся объект' }).click();
    const titles: string[] = [];
    const summaries = checkSummaries(page, titles);
    const screens = await playSession(page, {
      onScreen: async (kind) => {
        await summaries(kind);
        if (kind !== 'summary') return;
        const lines = await page.getByRole('list', { name: 'Оценка' }).getByRole('listitem').allInnerTexts();
        const unreliable = (await page.locator('.summary .warning').filter({ hasText: /^Замер ненадёжен/ }).count()) > 0;
        blocks.push({ session, lines, unreliable });
      },
    });
    expect(blocks.filter((b) => b.session === session).length, `session ${String(session + 1)}: block summaries`).toBeGreaterThan(0);
    expect(screens).not.toContain('wellbeing');
    expect(titles.length).toBeGreaterThan(0);
    expect(new Set(titles)).toEqual(new Set(['Реакция на движущийся объект']));
    const kinds = await page.evaluate(() => [...new Set(window.__bot?.stimuli.map((s) => `${s.module}:${s.kind}`))]);
    expect(kinds).toEqual(['rdo:timed']);
    await expect(page.getByRole('list', { name: 'Итог по модулям' })).toContainText('Реакция на движущийся объект: блоков');
    await page.getByRole('button', { name: 'На главную' }).click();
    await expect(home(page)).toBeVisible();
  }
  // The very first РДО block: step 1 at the start level, no history yet. Only a block that enters the history
  // promises a comparison (FW4).
  const [first] = blocks;
  expect(first?.lines[0]).toMatch(/^Ступень 1 из 5\+ — начальная \(уровень [\d,]+; формат теста — 10\)$/);
  expect(first?.lines.at(-1)).toBe(first?.unreliable === true ? 'Первый такой блок' : 'Первый такой блок — будет с чем сравнивать');
  // Every later block, the second session's included, is compared with the reliable blocks before it.
  blocks.forEach((b, i) => {
    const kept = blocks.slice(0, i).some((x) => !x.unreliable);
    const history = kept ? /^Раньше в этом блоке: прошлый раз \d+\sмс \(ур\. [\d,]+\) · лучший \d+\sмс/ : /^Первый такой блок/;
    expect(b.lines.at(-1), `block ${String(i + 1)} (session ${String(b.session + 1)})`).toMatch(history);
  });
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

test('free training of Переключение правил reaches 100 %', async ({ page }) => {
  await openApp(page, E2E_URL);
  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: 'Переключение правил' }).click();
  const titles: string[] = [];
  const screens = await playSession(page, { onScreen: checkSummaries(page, titles) });
  expect(screens).toContain('summary');
  expect(new Set(titles)).toEqual(new Set(['Переключение правил']));
  const kinds = await page.evaluate(() => [...new Set(window.__bot?.stimuli.map((s) => `${s.module}:${s.kind}`))]);
  expect(kinds).toEqual(['taskswitch:press']);
  await expect(page.getByRole('list', { name: 'Итог по модулям' })).toContainText('Переключение правил: блоков');
});

test('free training of Помехоустойчивость reaches 100 %', async ({ page }) => {
  await openApp(page, E2E_URL);
  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: 'Помехоустойчивость' }).click();
  const titles: string[] = [];
  const screens = await playSession(page, { onScreen: checkSummaries(page, titles) });
  expect(screens).toContain('summary');
  expect(new Set(titles)).toEqual(new Set(['Помехоустойчивость']));
  const kinds = await page.evaluate(() => [...new Set(window.__bot?.stimuli.map((s) => `${s.module}:${s.kind}`))]);
  expect(kinds).toEqual(['pomeh:press']);
  await expect(page.getByRole('list', { name: 'Итог по модулям' })).toContainText('Помехоустойчивость: блоков');
});

test('free training of Память reaches 100 %', async ({ page }) => {
  // Scale 0.3: a 90 s budget, enough for the four modes (digits, positions, card, letters) at 3 trials each.
  await openApp(page, '/?e2e=1&scale=0.3');
  await page.getByRole('button', { name: 'Свободная тренировка' }).click();
  await page.getByRole('button', { name: 'Память' }).click();
  const titles: string[] = [];
  const instructions: string[] = [];
  const summaries = checkSummaries(page, titles);
  const screens = await playSession(page, {
    timeoutMs: 200_000,
    onScreen: async (kind) => {
      if (kind === 'instruction') instructions.push(await page.locator('.instruction').innerText());
      await summaries(kind);
    },
  });
  expect(screens).toContain('memory');
  expect(new Set(titles)).toEqual(new Set(['Память']));
  // Every block starts with its instruction and ends in a 100 % summary: each mode was reproduced exactly.
  expect(titles.length).toBeGreaterThanOrEqual(4);
  for (const mode of ['Запомни цифры', 'Клетки загораются', 'На карточке', 'Запомни буквы']) {
    expect(instructions.some((t) => t.includes(mode)), mode).toBe(true);
  }
  await expect(page.getByRole('list', { name: 'Итог по модулям' })).toContainText('Память: блоков');
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
  await pauseWithEscape(page);
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
  await pauseWithEscape(page);
  await expect(page.getByText('Уже сохранённые блоки не пропадут.')).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(page.locator('.instruction')).toBeVisible();

  // Escape inside a running block throws the block away.
  await page.getByRole('button', { name: 'Начать (Enter)' }).click();
  await waitForStimuli(page, 1);
  await cancelPendingPresses(page);
  await pauseWithEscape(page);
  await expect(page.getByText('Блок начнётся заново. Уже сохранённые блоки не пропадут.')).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить блок заново' }).click();
  const titles: string[] = [];
  await playSession(page, { stopAt: 'summary', onScreen: checkSummaries(page, titles) });
  expect(titles).toEqual(['ПЗМР']);

  await pauseWithEscape(page);
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
  // A diagnostic trains nothing: every module of «Оценка по модулям» is still untrained.
  const assessment = page.getByRole('table', { name: 'Оценка по модулям' });
  await expect(assessment.locator('tbody tr')).toHaveCount(11);
  await expect(assessment.getByText('ещё не тренировался')).toHaveCount(11);
  // The right-aligned column keeps each cell on one line, text ones too.
  for (const cell of await assessment.locator('tbody td.num').all()) {
    expect(await lineCount(cell), await cell.innerText()).toBe(1);
  }
  // …and the table fits its section at 1280×800 (A-R24).
  await expectFitsWidth(page.getByRole('region', { name: 'Оценка по модулям' }), '«Оценка по модулям»');
});
