import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist', 'coverage', 'test-results', 'playwright-report', 'src-tauri/target', 'src-tauri/gen', '.superpowers'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['*.config.ts', 'tests/**/*.ts', 'scripts/**'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'react/*', 'react-dom/*'], message: 'src/engine не зависит от React.' },
            { group: ['**/runtime/**'], message: 'src/engine не импортирует src/runtime.' },
            { group: ['**/ui/**'], message: 'src/engine не импортирует src/ui.' },
            { group: ['**/data/**'], message: 'src/engine не импортирует src/data.' },
            { group: ['**/platform/**'], message: 'src/engine не импортирует src/platform.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/engine/**/*.ts', 'src/modules/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Случайность только через Rng с зерном.' },
      ],
    },
  },
);
