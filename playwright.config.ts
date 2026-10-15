import { defineConfig, devices } from '@playwright/test';

// Браузеры берутся из PLAYWRIGHT_BROWSERS_PATH (в облачном окружении — /opt/pw-browsers).
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  // No retries, on CI too: a test that fails on its first attempt fails the run, so flaky tests stay visible (M8).
  retries: 0,
  // The e2e sessions mostly wait on real ISIs and timers, not the CPU: two workers halve the CI time
  // (one worker took 5.6 min). The timing probe passed under three parallel workers locally.
  ...(process.env['CI'] ? { workers: 2 } : {}),
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
