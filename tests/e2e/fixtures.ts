import { test as base, expect } from '@playwright/test';

/**
 * Every e2e test fails if the page logs a console error or throws an uncaught error: a broken screen
 * often shows nothing else.
 */
export const test = base.extend<{ consoleGuard: string[] }>({
  viewport: { width: 1280, height: 800 },
  consoleGuard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text()}`);
      });
      page.on('pageerror', (e) => {
        errors.push(`pageerror: ${e.message}`);
      });
      await use(errors);
      expect(errors, 'console errors and uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The app in e2e mode with shrunk sessions. */
export const E2E_URL = '/?e2e=1&scale=0.02';
