import { z } from 'zod';

/**
 * Typed, validated configuration (docs/11-devops-and-observability.md §4).
 *
 * The process refuses to boot on invalid configuration. That is deliberate: a missing
 * DATABASE_URL should fail loudly at startup, not as a mysterious error on the first request
 * three hours later. The same principle applies to the JWT secret and the AI residency settings.
 */

const DEV_JWT_PLACEHOLDER = 'dev-only-not-a-real-secret-change-me';

/**
 * An env var that is **absent** when it is empty or whitespace-only.
 *
 * `node --env-file` (and `dotenv`, and Docker Compose) turn `KEY=` into `KEY=""` — a *present*
 * variable holding nothing. Every inert-seam check in this codebase is `=== undefined`, so a blank
 * value does not mean "unconfigured": it means configured *with nothing*. That is how a copied
 * `.env.example` produced a VAPID pair of `""` (a push sender that throws on the first send), an
 * `_EU_BASE_URL=""` (a boot failure from `z.string().url()`), and would have produced a `LOCAL`
 * provider pointed at `""`. Normalising at the schema is the one place that fixes all of them.
 */
const blankIsAbsent = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** Optional free text; `KEY=` counts as unset. */
const optionalText = z.preprocess(blankIsAbsent, z.string().optional());

/** Optional URL; `KEY=` counts as unset, and a non-empty value must parse as a URL. */
const optionalUrl = z.preprocess(blankIsAbsent, z.string().url().optional());

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
    /**
     * The path prefix the **browser** reaches this API under, or `''` when it is mounted at the root.
     *
     * It exists for one thing today: the refresh cookie's `Path`. A browser matches a cookie's path
     * against the URL it can *see*, and in dev the browser sees `/api/auth/refresh` while the proxy strips
     * `/api` before the API sees anything — so a cookie scoped to `/auth`, which is what the API's own
     * route looks like from the inside, was never sent: `restore()` came back with an empty token and
     * **every hard reload signed the user out** (R-26, task 4.3.5). The scope stays as narrow as it was —
     * the refresh token still only reaches auth endpoints — it just has to be expressed in the browser's
     * terms rather than the API's.
     *
     * `KEY=` counts as unset, i.e. mounted at the root, which is what a reverse proxy serving the API at
     * `/` means. Dev sets it to `/api` (see `.env.example`).
     */
    PUBLIC_API_PREFIX: z.preprocess(
      blankIsAbsent,
      z
        .string()
        // A path prefix: leading slash per segment, no trailing one, no scheme or host. A looser check
        // would accept `https://api.example.com/auth` and then silently produce a cookie no browser ever
        // sends — the exact failure this setting exists to prevent.
        .regex(/^(\/[A-Za-z0-9._~-]+)*$/, 'must be a path prefix such as /api, or empty for the root')
        .default(''),
    ),
    SMTP_URL: optionalText,

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
     * ADR-036's routing rung: which registered intent or action a sentence means.
     *
     * `LOCAL` like the rest, and that is what makes the rung **dark** rather than merely off: with no
     * local model running there is nothing to call, so enabling it is a deliberate act — a deployment
     * names an endpoint *and* the Household records consent. Its payload is the user's own question and
     * nothing else, so it is the same egress as the other text tasks (see `consentKindForTask`).
     */
    AI_ROUTE_PRIMARY: z.string().default('LOCAL'),

    /**
     * The EEA host each `*_EU` endpoint actually means (ADR-031).
     *
     * Optional, because a deployment that routes `LOCAL` needs none of them — and **required** the
     * moment a task primary names one, which `superRefine` enforces below. There is deliberately no
     * default: the previous default was the provider's global platform (`api.deepseek.com`,
     * `api.openai.com`), which is how an `_EU` suffix came to sit on a non-EEA host.
     */
    DEEPSEEK_EU_BASE_URL: optionalUrl,
    OPENAI_EU_BASE_URL: optionalUrl,
    ANTHROPIC_EU_BASE_URL: optionalUrl,
    GEMINI_EU_BASE_URL: optionalUrl,

    /**
     * The host a *credential* belongs to. Only meaningful when a task primary names the endpoint,
     * and read by `modules/ai` when it assembles adapters (ADR-031 decision 6).
     *
     * They live here, not in the AI package, for the reason `packages/ai`'s factory header states:
     * a library that reads `process.env` cannot be unit-tested without mutating global state. The
     * package takes the key as an argument; this file owns the variable names.
     */
    DEEPSEEK_API_KEY: optionalText,
    OPENAI_API_KEY: optionalText,

    /**
     * The local sidecar (Ollama / `llama.cpp`) — docs/08 §6.8. **No default**, deliberately.
     *
     * Setting this is a *claim* that a model is listening there, and `modules/ai` takes it at its
     * word: with it set, every `LOCAL`-routed task opens a socket, and with it blank the task is
     * simply unrouted and the pipeline stays at rules and keywords instantly. The old default
     * (`http://localhost:11434`) was the reverse — a claim nobody had made, on a port nothing
     * listened on, which the composition root would have turned into a refused connection on every
     * unmatched fragment.
     */
    LOCAL_AI_BASE_URL: optionalUrl,

    /**
     * S3-compatible object storage (ADR-018, task 4.1.1). All optional: with none of them set the
     * `files` module answers with an honest "storage is not configured" rather than a broken presigned
     * URL, exactly as `EMBEDDINGS` is inert without a model (ADR-021). `attachments` is still the
     * table — a deployment without storage simply cannot accept an upload.
     */
    S3_ENDPOINT: optionalText,
    S3_BUCKET: optionalText,
    S3_REGION: z.string().default('us-east-1'),
    S3_ACCESS_KEY_ID: optionalText,
    S3_SECRET_ACCESS_KEY: optionalText,
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
    VAPID_PUBLIC_KEY: optionalText,
    VAPID_PRIVATE_KEY: optionalText,
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
      // ADR-036: routing carries the user's own words, so it is subject to the same residency rule as
      // the other text tasks — a config naming a non-EEA host here would be the same Chapter V
      // transfer, one task later.
      'AI_ROUTE_PRIMARY',
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
