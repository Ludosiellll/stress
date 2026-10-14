import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const domTests = [
  'src/ui/**/*.test.{ts,tsx}',
  'src/platform/**/*.test.{ts,tsx}',
  'src/runtime/input.test.ts',
  'src/runtime/focusGuard.test.ts',
];

export default defineConfig({
  plugins: [react()],
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
