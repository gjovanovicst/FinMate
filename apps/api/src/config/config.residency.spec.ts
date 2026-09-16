import { describe, expect, it } from 'vitest';

import { loadConfig } from './config';

/**
 * The residency guard on AI routing (ADR-007, ADR-031).
 *
 * This is the check that used to certify something it could not see. It refused a bare
 * `DEEPSEEK` and accepted `DEEPSEEK_EU` — and `DEEPSEEK_EU` resolved to `api.deepseek.com`, which is
 * in China. So a one-word environment variable was enough to send household free text out of the EEA
 * while the boot log said the configuration was valid.
 *
 * The rule now: an `*_EU` endpoint must **name its EEA host**. There is no default host to fall back
 * on, because the default *was* the non-EEA one.
 */
const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'a-development-secret-long-enough-to-pass',
  NODE_ENV: 'development',
} as const;

describe('AI routing residency', () => {
  it('accepts the defaults, which are LOCAL', () => {
    const config = loadConfig({ ...BASE });

    expect(config.AI_PARSE_PRIMARY).toBe('LOCAL');
    expect(config.AI_CLASSIFY_PRIMARY).toBe('LOCAL');
  });

  it('refuses a provider spelling that is not an endpoint at all', () => {
    // The guard's original purpose: a bare `DEEPSEEK` is not a member of the endpoint union.
    expect(() => loadConfig({ ...BASE, AI_CLASSIFY_PRIMARY: 'DEEPSEEK' })).toThrow(/not an EEA endpoint/);
  });

  it('refuses an `_EU` endpoint that does not say which EEA host it means', () => {
    // The ADR-031 fix: the suffix alone is a claim. Without this, `DEEPSEEK_EU` passed and the
    // adapter's default base URL did the rest.
    expect(() => loadConfig({ ...BASE, AI_CLASSIFY_PRIMARY: 'DEEPSEEK_EU' })).toThrow(
      /DEEPSEEK_EU_BASE_URL is not set/,
    );
    expect(() => loadConfig({ ...BASE, AI_NARRATE_PRIMARY: 'ANTHROPIC_EU' })).toThrow(
      /ANTHROPIC_EU_BASE_URL is not set/,
    );
  });

  it('accepts an `_EU` endpoint once its host is configured', () => {
    const config = loadConfig({
      ...BASE,
      AI_CLASSIFY_PRIMARY: 'DEEPSEEK_EU',
      DEEPSEEK_EU_BASE_URL: 'https://eu.example.invalid/v1',
    });

    expect(config.AI_CLASSIFY_PRIMARY).toBe('DEEPSEEK_EU');
    expect(config.DEEPSEEK_EU_BASE_URL).toBe('https://eu.example.invalid/v1');
  });

  it('accepts the one non-EEA endpoint this build knows, because consent is enforced per Household', () => {
    // `DEEPSEEK_GLOBAL` is admissible as a *target*; whether a given Household may be sent to it is
    // ADR-007's consent gate, which is a runtime decision and not a boot-time one.
    const config = loadConfig({ ...BASE, AI_CLASSIFY_PRIMARY: 'DEEPSEEK_GLOBAL' });

    expect(config.AI_CLASSIFY_PRIMARY).toBe('DEEPSEEK_GLOBAL');
  });

  it('refuses a non-EEA spelling that is not the known endpoint', () => {
    expect(() => loadConfig({ ...BASE, AI_CLASSIFY_PRIMARY: 'OPENAI_GLOBAL' })).toThrow(
      /not an EEA endpoint/,
    );
  });
});
