// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.jscpd-report/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'scripts/kern-vorbereiten.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Browser-Skripte (COPI-26, Chat COPI-56): reines JavaScript ohne Build, nicht Teil des
    // TypeScript-Projekts — also ohne typgestützte Regeln, aber mit Browser-Globals.
    ...tseslint.configs.disableTypeChecked,
    files: ['assets/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { projectService: false },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        EventSource: 'readonly',
        Notification: 'readonly',
        FileReader: 'readonly',
      },
    },
  },
  {
    // Der Service Worker (COPI-58) läuft nicht im Fenster, sondern im Worker: dort heißt der globale Kontext `self`.
    files: ['assets/js/sw.js'],
    languageOptions: {
      globals: { self: 'readonly', URL: 'readonly' },
    },
  },
);
