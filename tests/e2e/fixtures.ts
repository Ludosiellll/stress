import { existsSync, statSync } from 'node:fs';
import { test as base, expect, type Browser, type Page } from '@playwright/test';
import { openApp } from './bot';

/** Collects the page's console errors and uncaught errors into `errors`. */
function watchErrors(page: Page, errors: string[]): void {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    errors.push(`pageerror: ${e.message}`);
  });
}

const VIEWPORT = { width: 1280, height: 800 };

/**
 * Every e2e test fails if the page logs a console error or throws an uncaught error: a broken screen
 * often shows nothing else.
 */
export const test = base.extend<{ consoleGuard: string[] }>({
  viewport: VIEWPORT,
  consoleGuard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      watchErrors(page, errors);
      await use(errors);
      expect(errors, 'console errors and uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The app in e2e mode with shrunk sessions. */
export const E2E_URL = '/?e2e=1&scale=0.02';

/**
 * The app in e2e mode in its own browser context (its own empty memory), on Home. Its console errors are
 * collected like `page`'s: check `errors` after `close`.
 */
export async function freshPage(browser: Browser): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const errors: string[] = [];
  watchErrors(page, errors);
  await openApp(page, E2E_URL);
  return { page, errors, close: () => context.close() };
}

/** Where screenshots go for the visual check (CI uploads them as the e2e-screens artifact). */
const SCREENS_DIR = 'test-results/screens';

/** Saves a screenshot to test-results/screens/<name>.png and checks the file was written. */
export async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  const path = `${SCREENS_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage });
  expect(existsSync(path), path).toBe(true);
  expect(statSync(path).size, path).toBeGreaterThan(1000);
}
