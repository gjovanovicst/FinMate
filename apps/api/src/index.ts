/**
 * apps/api — NestJS HTTP + GraphQL API. Owns the database (scope:api).
 *
 * The process entry point is `src/main.ts`; this module exists so the workspace has a stable
 * package entry for tooling. Feature modules live under `src/modules/` as they land.
 */
export { AppModule } from './app.module';
