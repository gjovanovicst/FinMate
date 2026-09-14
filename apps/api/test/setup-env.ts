import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

/**
 * Load the repository-root `.env` inside each test worker.
 *
 * `setupFiles` run in the worker process, which does not inherit a cwd-based dotenv load — so
 * `DATABASE_URL` would otherwise be undefined for integration tests. The path is resolved from this
 * file rather than from cwd, which Nx sets to the workspace root.
 */
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
