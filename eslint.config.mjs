/**
 * ESLint flat config for the whole monorepo.
 *
 * Enforces AGENTS.md conventions:
 * - TypeScript strict quality (typescript-eslint strictTypeChecked),
 * - no `any` without a written justification comment,
 * - eslint-plugin-security on every package (NFR-2).
 */
import eslint from '@eslint/js';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/dev-dist/**',
      'e2e/**',
    ],
  },
  eslint.configs.recommended,
  security.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `any` is banned; a rare exception needs an explanation comment.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
);
