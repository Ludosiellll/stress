import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const domTests = [
  'src/ui/**/*.test.{ts,tsx}',
  'src/platform/**/*.test.{ts,tsx}',
  'src/testing/**/*.test.{ts,tsx}',
  'src/runtime/input.test.ts',
  'src/runtime/focusGuard.test.ts',
];

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/engine/**', 'src/modules/**'],
      exclude: ['**/*.test.ts', '**/*.test.tsx'],
      reporter: ['text', 'html'],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/engine/**/*.test.ts',
            'src/modules/**/*.test.ts',
            'src/session/**/*.test.ts',
            'src/data/**/*.test.ts',
            'src/runtime/**/*.test.ts',
            'tests/sim/**/*.test.ts',
          ],
          exclude: domTests,
        },
      },
      {
        extends: true,
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: domTests,
          setupFiles: ['src/testing/setupDom.ts'],
        },
      },
    ],
  },
});
