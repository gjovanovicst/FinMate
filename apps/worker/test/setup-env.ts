import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

/**
 * Load the repository-root `.env` inside each test worker.
 *
 * The same file the API's tests use: the worker's specs boot the real module graph against the dev
 * database, so `DATABASE_URL` has to be present before Nest builds a provider.
 */
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
