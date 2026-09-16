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
    /**
     * The product name, used in outbound copy (notifications, email).
     *
     * `FinMate` is a **working title that is already taken** (ADR-014) and the rule is that no brand
     * string is hardcoded — so it comes from here. ⚠️ The web has the same string as the `app.name` i18n
     * key, which makes this a second source of truth until a shared constant lands; when the name is
     * decided (Q-1), both places change in one commit.
     */
    APP_NAME: z.string().default('FinMate'),
    /**
     * The locale money and dates are formatted in for server-rendered copy (notifications, assistant
     * facts). The product's *copy* is English (ADR-019); money follows the Serbian convention the rest
     * of the app renders, and `formatMoney`'s own default is this value.
     */
    APP_DEFAULT_LOCALE: z.string().default('sr-Latn-RS'),
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
    // ADR-031: `ANTHROPIC_EU` was the default and it is *unimplemented* (`UNIMPLEMENTED_ENDPOINTS`),
    // so a default deployment routed narration at an endpoint that could not answer. LOCAL is the
    // honest default: narration falls back to the deterministic template, which is what this build
    // already documents.
    AI_NARRATE_PRIMARY: z.string().default('LOCAL'),
    AI_OCR_PRIMARY: z.string().default('LOCAL'),

    /**
     * The EEA host each `*_EU` endpoint actually means (ADR-031).
     *
     * Optional, because a deployment that routes `LOCAL` needs none of them — and **required** the
     * moment a task primary names one, which `superRefine` enforces below. There is deliberately no
     * default: the previous default was the provider's global platform (`api.deepseek.com`,
     * `api.openai.com`), which is how an `_EU` suffix came to sit on a non-EEA host.
     */
    DEEPSEEK_EU_BASE_URL: z.string().url().optional(),
    OPENAI_EU_BASE_URL: z.string().url().optional(),
    ANTHROPIC_EU_BASE_URL: z.string().url().optional(),
    GEMINI_EU_BASE_URL: z.string().url().optional(),

    /**
     * S3-compatible object storage (ADR-018, task 4.1.1). All optional: with none of them set the
     * `files` module answers with an honest "storage is not configured" rather than a broken presigned
     * URL, exactly as `EMBEDDINGS` is inert without a model (ADR-021). `attachments` is still the
     * table — a deployment without storage simply cannot accept an upload.
     */
    S3_ENDPOINT: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    /** Presigned URL lifetimes, from docs/06 §9.2/§9.4. */
    S3_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(1).max(604_800).default(900),
    S3_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(1).max(604_800).default(300),

    /**
     * Web push (ADR-028, task 4.2.9). Only `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are secrets — the
     * public key is handed to the client by the `pushPublicKey` query, so it is not one.
     *
     * Both keys are optional, and leaving either unset makes the `WEB_PUSH` sender **inert** rather
     * than fatal (ADR-028 decision 2, the same shape as `S3_*`/`EMBEDDINGS`): rows stay `QUEUED` and
     * `dispatch` reports them skipped with a reason. `VAPID_SUBJECT` is a contact URL or `mailto:`
     * the push services may use to reach the operator; it has a safe default because web-push
     * requires one whenever keys are set.
     */
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().default('mailto:noreply@localhost'),
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
      if (value !== 'LOCAL' && !value.endsWith('_EU') && value !== 'DEEPSEEK_GLOBAL') {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            `${key}="${value}" is not an EEA endpoint. AI tasks carrying Household free text or ` +
            `images may only target LOCAL or an explicit *_EU endpoint (ADR-007). ` +
            `DEEPSEEK_GLOBAL is the one non-EEA endpoint this build knows, and it serves a Household ` +
            `only with recorded consent (ADR-031).`,
        });
      }

      // ADR-031: an `_EU` endpoint is only EEA if it says which EEA host it means. Without this the
      // suffix was satisfied by a name while the adapter's default base URL pointed outside the EEA.
      const baseUrlKey = `${value.replace(/_EU$/, '')}_EU_BASE_URL` as keyof typeof env;
      if (value !== 'LOCAL' && value.endsWith('_EU') && env[baseUrlKey] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            `${key}="${value}" names an EEA endpoint but ${String(baseUrlKey)} is not set. There is ` +
            `no default host for an *_EU endpoint: the provider's own platform is not in the EEA, so ` +
            `defaulting to it would make the suffix a claim rather than a fact (ADR-031).`,
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
