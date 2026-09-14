// Flat ESLint config.
//
// The important rule here is `@nx/enforce-module-boundaries`, which mechanically encodes the
// dependency rule in docs/05-architecture.md §2. Prose in AGENTS.md is a suggestion; this is the
// constraint — importing across a forbidden edge fails lint, and therefore fails CI.
//
// Each project carries exactly ONE scope tag (see each project.json). Using a single tag per
// project is deliberate: with multiple tags, Nx allows a dependency if it satisfies ANY matching
// constraint, so a permissive `type:lib` constraint would silently defeat every scope restriction.
import nxPlugin from '@nx/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.pnpm-store/**',
      '**/coverage/**',
      '**/generated/**',
      // Angular's build cache holds bundled dependency output, not source. Linting it produces
      // hundreds of errors about generated code (verified: it flagged @angular/forms' own bundle).
      '**/.angular/**',
      '**/*.d.ts',
    ],
  },

  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          // Nx 23 renamed this from `enforceBuildableLibs`.
          enforceBuildableLibDependency: false,
          allow: [],
          depConstraints: [
            // --- pure packages: no application, no I/O, no other scope ---
            // packages/domain imports nothing (docs/05 §2). This is what keeps it
            // unit-testable without a database and reusable on client and server.
            { sourceTag: 'scope:domain', onlyDependOnLibsWithTags: ['scope:domain'] },
            { sourceTag: 'scope:tooling', onlyDependOnLibsWithTags: ['scope:tooling'] },

            // contracts: shared DTOs only.
            {
              sourceTag: 'scope:contracts',
              onlyDependOnLibsWithTags: ['scope:contracts', 'scope:domain'],
            },

            // nlp / rules-engine / ai must NOT depend on each other.
            // `nlp` must not import `ai` and `rules-engine` must not import `ai`
            // (docs/05 §2) — the model is the last resort, not a dependency of the
            // deterministic layers.
            {
              sourceTag: 'scope:nlp',
              onlyDependOnLibsWithTags: ['scope:nlp', 'scope:domain', 'scope:contracts'],
            },
            {
              sourceTag: 'scope:rules',
              onlyDependOnLibsWithTags: ['scope:rules', 'scope:domain', 'scope:contracts'],
            },
            // `ai` must not import the database. Prisma lives in scope:api, which is
            // absent from this list, so the edge cannot be created.
            {
              sourceTag: 'scope:ai',
              onlyDependOnLibsWithTags: ['scope:ai', 'scope:domain', 'scope:contracts'],
            },

            // --- applications ---
            // The API and worker may use every package.
            {
              sourceTag: 'scope:api',
              onlyDependOnLibsWithTags: [
                'scope:api',
                'scope:domain',
                'scope:contracts',
                'scope:nlp',
                'scope:rules',
                'scope:ai',
                'scope:tooling',
              ],
            },
            {
              sourceTag: 'scope:worker',
              onlyDependOnLibsWithTags: [
                'scope:worker',
                'scope:api',
                'scope:domain',
                'scope:contracts',
                'scope:nlp',
                'scope:rules',
                'scope:ai',
                'scope:tooling',
              ],
            },
            // The web client may reuse the parser (docs/05 §5.3 runs packages/nlp in the
            // browser for an instant capture preview) but must NOT reach the AI or rules
            // packages — those are server-side, and ADR-007 keeps model calls off the client.
            {
              sourceTag: 'scope:web',
              onlyDependOnLibsWithTags: [
                'scope:web',
                'scope:domain',
                'scope:contracts',
                'scope:nlp',
                'scope:tooling',
              ],
            },
          ],
        },
      ],

      // Discourage `any` creeping into money paths. Warn, not error, so a genuinely
      // untyped third-party boundary can still be handled with an explicit cast.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Match TypeScript's own `noUnusedParameters` behaviour: a leading underscore is the
      // conventional way to say "required by the signature, deliberately unused".
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    // NestJS resolves constructor dependencies from emitted decorator metadata, which requires the
    // parameter type to exist at RUNTIME. Rewriting `import { PrismaService }` to
    // `import type { PrismaService }` deletes the runtime reference and DI fails at boot with
    // "Nest can't resolve dependencies". The rule is therefore wrong for this app.
    files: ['apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
