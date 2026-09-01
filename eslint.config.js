// @ts-check
import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';

/**
 * Deliberately small.
 *
 * TypeScript in strict mode with noUncheckedIndexedAccess already catches most
 * of what a large rule set would, and it catches it at compile time. The rules
 * here are the ones the compiler cannot express — mostly "you probably meant to
 * await that", which is the bug class this codebase is actually exposed to.
 */
export default ts.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'tests/fixtures/**',
      '.out/**',
      '.work/**',
      'infra/**/.terraform/**',
      // A CloudFront Function: a bespoke runtime with its own globals and an
      // import of 'cloudfront' that exists nowhere else. It has its own test
      // suite (tests/unit/router.test.ts) which asserts its constraints.
      'infra/stacks/edge/router.js',
    ],
  },

  js.configs.recommended,
  ...ts.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A dropped promise in the dispatcher means a build that silently never
      // happens, so these are errors rather than warnings.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Interop with AWS event shapes involves genuine `any`. Worth seeing, not
      // worth failing a build over.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // Tests reach into internals and assert on loosely typed responses on
    // purpose; holding them to the same shape rules adds noise, not safety.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  {
    // Build and utility scripts: plain Node, no type information.
    files: ['**/*.mjs', 'eslint.config.js'],
    ...ts.configs.disableTypeChecked,
    languageOptions: {
      // Merged, not replaced: disableTypeChecked lives in languageOptions too,
      // and overwriting the whole object leaves type-aware parsing on for files
      // that are not in any tsconfig — which reports every one as a parse error.
      ...ts.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
);
