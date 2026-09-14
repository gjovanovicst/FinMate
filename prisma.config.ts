import 'dotenv/config';

import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 moved the connection URL out of `schema.prisma` and into this file for CLI commands
 * (migrate, db pull, studio). The runtime client gets its connection from a driver adapter —
 * see apps/api/src/prisma/prisma.service.ts.
 *
 * Migrations live with the API app, because Prisma (and therefore the database) is owned by
 * scope:api and must not be importable from packages/ai or any other library (docs/05 §2).
 */
export default defineConfig({
  schema: 'apps/api/prisma/schema.prisma',
  migrations: {
    path: 'apps/api/prisma/migrations',
    // Explicit path: pnpm's isolated linker does not put workspace binaries on PATH for
    // commands spawned by the Prisma CLI.
    seed: './node_modules/.bin/tsx apps/api/prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
