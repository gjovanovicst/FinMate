import { z } from 'zod';

/**
 * Typed, validated configuration (docs/11-devops-and-observability.md §4).
 *
 * The process refuses to boot on invalid configuration. That is deliberate: a missing
 * DATABASE_URL should fail loudly at startup, not as a mysterious error on the first request
 * three hours later. The same principle applies to the JWT secret and the AI residency settings.
 */

const DEV_JWT_PLACEHOLDER = 'dev-only-not-a-real-secret-change-me';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

    /** Access-token lifetime. Short, because revocation is checked per request from the database. */
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900), // 15 min
    /** Refresh-token lifetime. Long, because it is rotated on every use. */
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000), // 30 days
    /** Email verification / password reset token lifetime. */
    EMAIL_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3_600), // 1 hour

    /** Base URL used to build links in outbound email. */
    APP_BASE_URL: z.string().default('http://localhost:4200'),
    SMTP_URL: z.string().optional(),

    /** Login throttling (docs/08 §3 — credential stuffing is threat T-02). */
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(900), // 15 min

    /** Set false to require email verification before the app is usable. */
    REQUIRE_EMAIL_VERIFICATION: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    // ADR-007: PARSE/CLASSIFY/NARRATE/OCR may only target a LOCAL model or an EEA endpoint.
    // Anything else is a GDPR Chapter V transfer requiring recorded Household consent.
    AI_PARSE_PRIMARY: z.string().default('LOCAL'),
    AI_CLASSIFY_PRIMARY: z.string().default('LOCAL'),
    AI_NARRATE_PRIMARY: z.string().default('ANTHROPIC_EU'),
    AI_OCR_PRIMARY: z.string().default('LOCAL'),

    S3_ENDPOINT: z.string().optional(),
    S3_BUCKET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // A development placeholder must never reach production. Failing at boot is far cheaper than
    // discovering it when tokens can be forged.
    if (env.NODE_ENV === 'production' && env.JWT_SECRET === DEV_JWT_PLACEHOLDER) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'Refusing to boot in production with the development JWT_SECRET placeholder.',
      });
    }

    // Residency guard: reject a routing target that is neither LOCAL nor EEA-suffixed.
    for (const key of [
      'AI_PARSE_PRIMARY',
      'AI_CLASSIFY_PRIMARY',
      'AI_NARRATE_PRIMARY',
      'AI_OCR_PRIMARY',
    ] as const) {
      const value = env[key];
      if (value !== 'LOCAL' && !value.endsWith('_EU')) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            `${key}="${value}" is not an EEA endpoint. AI tasks carrying Household free text or ` +
            `images may only target LOCAL or an explicit *_EU endpoint (ADR-007). ` +
            `A non-EEA endpoint requires recorded Household consent and is not configurable here.`,
        });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

/** Parse and validate the environment, throwing a readable error listing every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return result.data;
}

export const CONFIG = Symbol('APP_CONFIG');
