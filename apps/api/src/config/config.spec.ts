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

/**
 * Email is required in production (docs/09 §5.8, task 0.6.5).
 *
 * With `SMTP_URL` unset `MailService` logs the message body instead of sending it — a development
 * convenience that in production means a password-reset link written to a log file, and a person who
 * never receives it. The schema refuses to boot without it there, which is the loud version of that
 * mistake; development keeps the Mailhog-or-log behaviour.
 */
describe('SMTP_URL is required in production', () => {
  const PROD = {
    ...BASE,
    NODE_ENV: 'production' as const,
    JWT_SECRET: 'a-production-secret-that-is-long-enough',
  };

  it('refuses to boot without it', () => {
    expect(() => loadConfig({ ...PROD })).toThrow(/SMTP_URL is required in production/);
  });

  it('accepts a relay URL', () => {
    expect(loadConfig({ ...PROD, SMTP_URL: 'smtp://relay.example.com:587' }).SMTP_URL).toBe(
      'smtp://relay.example.com:587',
    );
  });

  it('keeps it optional in development', () => {
    expect(() => loadConfig({ ...BASE })).not.toThrow();
  });

  it('reads MAIL_FROM, so a deployment can name a sender the provider has verified', () => {
    expect(loadConfig({ ...BASE, MAIL_FROM: 'FinMate <no-reply@example.com>' }).MAIL_FROM).toBe(
      'FinMate <no-reply@example.com>',
    );
  });
});

/**
 * `MFA_ENCRYPTION_KEY` (ADR-041).
 *
 * A present-but-wrong key is the dangerous state: absent means the authenticator factor is honestly
 * unavailable, while a malformed key would enrol an authenticator whose secret cannot be read back.
 * It must fail at boot, and a wrong-length key must never be stretched or padded into a valid one.
 */
describe('MFA_ENCRYPTION_KEY', () => {
  it('accepts a 32-byte base64 key', () => {
    expect(() =>
      loadConfig({ ...BASE, MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') }),
    ).not.toThrow();
  });

  it('accepts a 64-character hex key', () => {
    expect(() => loadConfig({ ...BASE, MFA_ENCRYPTION_KEY: 'a'.repeat(64) })).not.toThrow();
  });

  it('treats a blank key as unset, so the factor is simply unavailable', () => {
    expect(loadConfig({ ...BASE, MFA_ENCRYPTION_KEY: '' }).MFA_ENCRYPTION_KEY).toBeUndefined();
    expect(loadConfig({ ...BASE }).MFA_ENCRYPTION_KEY).toBeUndefined();
  });

  it('refuses a key of the wrong length rather than padding it', () => {
    expect(() =>
      loadConfig({ ...BASE, MFA_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }),
    ).toThrow(/MFA_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...BASE, MFA_ENCRYPTION_KEY: 'not-a-key' })).toThrow(
      /MFA_ENCRYPTION_KEY/,
    );
  });
});

/**
 * `PUBLIC_API_PREFIX` — the browser's path to this API (R-26, task 4.3.5).
 *
 * It scopes the refresh cookie, so a wrong value is not a cosmetic mistake: a prefix the browser never
 * requests means the cookie is never attached, `restore()` returns an empty token, and every hard reload
 * signs the user out. That is the failure these cases exist to keep expressible, and to keep *typed
 * correctly* — a value with a scheme or a trailing slash would be accepted by a looser check and then
 * produce exactly the same silently-unusable cookie.
 */
describe('PUBLIC_API_PREFIX', () => {
  it('defaults to the root when it is absent or blank', () => {
    expect(loadConfig({ ...BASE }).PUBLIC_API_PREFIX).toBe('');
    expect(loadConfig({ ...BASE, PUBLIC_API_PREFIX: '' }).PUBLIC_API_PREFIX).toBe('');
  });

  it('accepts a plain path prefix', () => {
    expect(loadConfig({ ...BASE, PUBLIC_API_PREFIX: '/api' }).PUBLIC_API_PREFIX).toBe('/api');
    expect(loadConfig({ ...BASE, PUBLIC_API_PREFIX: '/services/finmate' }).PUBLIC_API_PREFIX).toBe(
      '/services/finmate',
    );
  });

  it('refuses a value that is not a path prefix, rather than setting a cookie nobody sends', () => {
    // A scheme/host, a trailing slash, a relative segment, and a query string: each would produce a
    // `Path` no browser matches, which is R-26 all over again and silent every time.
    for (const bad of ['https://api.example.com/auth', '/api/', 'api', '/api?v=2', '/api auth']) {
      expect(() => loadConfig({ ...BASE, PUBLIC_API_PREFIX: bad }), bad).toThrow();
    }
  });
});
