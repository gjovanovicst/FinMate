import { describe, expect, it } from 'vitest';

import { loadConfig } from './config';

/**
 * Blank environment variables — the `KEY=` trap.
 *
 * Every inert-seam check in this codebase is `=== undefined`: `makeWebPushSender`,
 * `makeObjectStorage`, `makeAiSeams`. But `node --env-file` (like `dotenv`, like Compose) turns
 * `KEY=` into a **present** variable holding `''`, so `cp .env.example .env` did not mean "leave
 * these unset" — it meant "configure them with nothing":
 *
 * - `VAPID_PUBLIC_KEY=''`/`VAPID_PRIVATE_KEY=''` produced a `RfcWebPushSender` that throws on the
 *   first send, instead of the inert sender the header promises;
 * - `DEEPSEEK_EU_BASE_URL=''` failed `z.string().url()` at boot with a message about a URL, when the
 *   real state was "not configured";
 * - and it would have produced a `LOCAL` provider pointed at `''`, i.e. a base URL that is not a URL.
 *
 * So the schema normalises a blank value to `undefined` once, for every optional setting. The point
 * of these cases is that **"not configured" has exactly one representation**, whatever the file says.
 */
const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'a-development-secret-long-enough-to-pass',
  NODE_ENV: 'development',
} as const;

describe('a blank env var means "unset"', () => {
  it('accepts an empty *_EU_BASE_URL when no task names that endpoint', () => {
    // The literal `cp .env.example .env` case: four empty base-URL lines and LOCAL routing.
    expect(() =>
      loadConfig({
        ...BASE,
        DEEPSEEK_EU_BASE_URL: '',
        OPENAI_EU_BASE_URL: '',
        ANTHROPIC_EU_BASE_URL: '',
        GEMINI_EU_BASE_URL: '',
      }),
    ).not.toThrow();
  });

  it('still refuses an `_EU` primary whose host is blank, as *unset* rather than as a bad URL', () => {
    // The message matters: "DEEPSEEK_EU_BASE_URL is not set" tells an operator what to do; "Invalid
    // url" on a variable they can see is empty sends them looking for a typo.
    expect(() =>
      loadConfig({ ...BASE, AI_CLASSIFY_PRIMARY: 'DEEPSEEK_EU', DEEPSEEK_EU_BASE_URL: '' }),
    ).toThrow(/DEEPSEEK_EU_BASE_URL is not set/);
  });

  it('treats a blank local-model URL as no local model, not as a URL', () => {
    expect(loadConfig({ ...BASE, LOCAL_AI_BASE_URL: '' }).LOCAL_AI_BASE_URL).toBeUndefined();
    expect(loadConfig({ ...BASE }).LOCAL_AI_BASE_URL).toBeUndefined();
  });

  it('treats blank VAPID keys as no VAPID keys, so the push seam stays inert', () => {
    const config = loadConfig({ ...BASE, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' });
    expect(config.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(config.VAPID_PRIVATE_KEY).toBeUndefined();
  });

  it('treats the whole set of blank seam settings as unset', () => {
    const config = loadConfig({
      ...BASE,
      SMTP_URL: '',
      S3_ENDPOINT: '',
      S3_BUCKET: '',
      S3_ACCESS_KEY_ID: '',
      S3_SECRET_ACCESS_KEY: '',
      DEEPSEEK_API_KEY: '',
      OPENAI_API_KEY: '',
    });

    for (const value of Object.values({
      SMTP_URL: config.SMTP_URL,
      S3_ENDPOINT: config.S3_ENDPOINT,
      S3_BUCKET: config.S3_BUCKET,
      S3_ACCESS_KEY_ID: config.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: config.S3_SECRET_ACCESS_KEY,
      DEEPSEEK_API_KEY: config.DEEPSEEK_API_KEY,
      OPENAI_API_KEY: config.OPENAI_API_KEY,
    })) {
      expect(value).toBeUndefined();
    }
  });

  it('still refuses a non-empty value that is not a URL', () => {
    // Normalising blanks must not turn the type check off.
    expect(() => loadConfig({ ...BASE, LOCAL_AI_BASE_URL: 'not-a-url' })).toThrow();
    expect(() => loadConfig({ ...BASE, GEMINI_EU_BASE_URL: 'api.example.com' })).toThrow();
  });
});
