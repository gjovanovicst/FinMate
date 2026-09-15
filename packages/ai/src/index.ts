/**
 * AI provider abstraction: `AiProvider`, adapters, routing, residency, redaction and the
 * degradation ladder.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §9 (ADR-007)
 *
 * Two rules that shape this package:
 *  - It returns **only Proposal types**. It never writes to the database and never computes money
 *    (ADR-001). The boundary rule enforces the second half: the database lives in `scope:api`,
 *    which this package may not import.
 *  - Routing is **LOCAL or EEA-endpoint only** for PARSE/CLASSIFY/NARRATE/OCR. An endpoint without
 *    an explicit `_EU` suffix is a GDPR Chapter V transfer and needs recorded consent.
 *
 * Implemented in Phase 2 tasks 2.2.1 (provider abstraction) and 2.2.2 (structured-output validation
 * and confidence calibration).
 *
 * ## How to use it
 *
 * ```ts
 * // 1. Build one adapter per endpoint docs/04 §9 names, from the caller's own configuration.
 * const providers = {
 *   LOCAL: createLocalProvider({ baseUrl: config.LOCAL_AI_BASE_URL, fetch }),
 *   DEEPSEEK_EU: createDeepSeekProvider({ apiKey: config.DEEPSEEK_API_KEY, fetch }),
 * };
 *
 * // 2. Construct the router. This validates residency and THROWS on a table that would egress
 * //    outside the EEA — the misconfiguration never becomes a data transfer.
 * const router = new AiRouter({ routing: DEFAULT_ROUTING, providers });
 *
 * // 3. Route a task. A failure is a value: `rung` is the degradation ladder the UI renders.
 * const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput);
 * if (result.ok) {
 *   // result.telemetry.costMicros / latencyMs / model, result.provider, prompt identity from the
 *   // input — all returned so the caller can write them into classification_decisions.
 * } else {
 *   // result.rung === 'RULES_KEYWORDS_ONLY' — rules and keywords already ran (ADR-002).
 * }
 * ```
 *
 * ## What is deliberately absent
 *
 * - **No database.** `scope:api` is not in this project's allowed dependencies, so cost, latency,
 *   provider, and prompt version are *returned* for the caller to persist (docs/04 §9).
 * - **No vendor SDK.** AGENTS.md rule 9: a new dependency needs an ADR, and an SDK would drag
 *   vendor-shaped types into the one package whose job is to treat providers symmetrically.
 * - **No prompt content.** This is the transport layer; the §6.3 template is rendered by the caller
 *   (task 2.2.3), which passes the `prompt_template_id` + `version` this package echoes back.
 *
 * @module @finmate/ai
 */

// --- the contract -------------------------------------------------------------------------------

export {
  TASKS,
  hasCallTask,
  unaccountedTelemetry,
  type AiProvider,
  type CallTelemetry,
  type CategoryCandidate,
  type ClassifyInput,
  type ClassifyProposal,
  type ExtractedFields,
  type FewShotExample,
  type NarrateInput,
  type NeedsUserInput,
  type OcrInput,
  type OcrLine,
  type OcrResult,
  type ParseInput,
  type ParseProposal,
  type PromptRef,
  type ProviderName,
  type RedactedFragment,
  type RoutedProvider,
  type Task,
  type TaskCall,
} from './provider';

// --- routing and residency ----------------------------------------------------------------------

export {
  DEFAULT_ROUTING,
  EEA_ENDPOINT_SUFFIX,
  ENDPOINTS,
  VALIDATED_DEFAULT_ROUTING,
  assertAllowedRoute,
  endpointsForTask,
  isEeaOrLocal,
  isLocalOnly,
  validateRouting,
  type Endpoint,
  type RoutingTable,
  type TaskRoute,
} from './endpoints';

// --- errors -------------------------------------------------------------------------------------

export {
  AiRequestError,
  AiRoutingError,
  AiTransientError,
  AiUnavailableError,
  type AiErrorCode,
  type ProviderFailure,
} from './errors';

// --- the ladder ---------------------------------------------------------------------------------

export {
  DEGRADATION_LADDER,
  ROUTED_TASKS,
  AiRouter,
  degradationRank,
  rungForFailure,
  rungForParseProposal,
  supportsTask,
  worstRung,
  type AiCallFailure,
  type AiCallResult,
  type AiCallSuccess,
  type DegradationReason,
  type DegradationRung,
  type RouterOptions,
} from './router';

// --- circuit breaker ----------------------------------------------------------------------------

export {
  CircuitBreaker,
  CircuitBreakers,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_OPEN_MS,
  type CircuitBreakerOptions,
  type CircuitSnapshot,
  type CircuitState,
} from './circuit-breaker';

// --- transport ----------------------------------------------------------------------------------

export {
  HttpTransport,
  errorCodeForStatus,
  isNonRetryableStatus,
  isSuccess,
  isTransientStatus,
  type FetchLike,
  type HttpRequest,
  type HttpResponse,
} from './transport';

// --- redaction ----------------------------------------------------------------------------------

export {
  MAX_FEW_SHOT_EXAMPLES,
  MAX_FRAGMENT_CHARS,
  MAX_QUESTION_CHARS,
  MAX_RECEIPT_LINE_CHARS,
  MIN_REDACTED_DIGIT_RUN,
  REDACTED_EMAIL,
  REDACTED_NUMBER,
  redactClassifyPayload,
  redactFragment,
  redactReceiptLine,
  redactText,
  resolveId,
  type IdSubstitution,
  type RedactedCategory,
  type RedactedClassifyPayload,
  type RedactionMap,
} from './redaction';

// --- prompt envelope ----------------------------------------------------------------------------

export {
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  UNTRUSTED_SYSTEM_PREAMBLE,
  asUntrusted,
  neutraliseDelimiters,
  renderCategories,
  renderClassifyContext,
  renderFragment,
  withJsonInstruction,
} from './prompt';

// --- validation ---------------------------------------------------------------------------------

export {
  INJECTION_PATTERNS,
  MAX_ALTERNATIVES,
  MAX_NEEDS_USER_INPUT,
  MAX_RATIONALE_CHARS,
  calendarDay,
  clampConfidence,
  emptyClassifyProposal,
  matchesInjection,
  minorUnitsString,
  sanitiseText,
  upperCode,
  validateClassifyProposal,
  validateExtracted,
  type ValidatedClassify,
} from './validation';

// --- confidence calibration ---------------------------------------------------------------------

export {
  AUTO_APPLY_MIN,
  CALIBRATION_MAP_VERSION,
  DEFAULT_LANE_THRESHOLDS,
  MIN_CALIBRATION_SAMPLES,
  SHRINK_FACTOR,
  VERIFY_MIN,
  applyCalibrationMap,
  asRawConfidence,
  buildCalibrationTable,
  calibratedConfidenceFromStorage,
  calibrate,
  calibrationKeyFromPrompt,
  calibrationKeyId,
  fitCalibrationMap,
  isValidCalibrationMap,
  laneFor,
  needsReview,
  parseCalibrationMap,
  shrinkCalibrationMap,
  type CalibratedConfidence,
  type CalibrationKey,
  type CalibrationMap,
  type CalibrationPoint,
  type CalibrationSample,
  type CalibrationStrategy,
  type CalibrationTable,
  type ConfidenceLane,
  type LaneThresholds,
  type RawConfidence,
} from './calibration';

// --- adapters -----------------------------------------------------------------------------------

export {
  DEFAULT_CHAT_PATH,
  DEFAULT_EMBED_PATH,
  DETERMINISM_SEED,
  OpenAiCompatibleProvider,
  TASK_TIMEOUTS_MS,
  joinUrl,
  type AdapterCall,
  type OpenAiCompatibleConfig,
} from './adapters/openai-compatible';

export {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  LOCAL_AI_DEFAULT_BASE_URL,
  LOCAL_DEFAULT_EMBED_MODEL,
  LOCAL_DEFAULT_MODEL,
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  UNIMPLEMENTED_ENDPOINTS,
  createDeepSeekProvider,
  createLocalProvider,
  createOpenAiProvider,
  type EndpointAdapterOptions,
} from './adapters/factory';

export {
  CLASSIFY_SCHEMA,
  OCR_SCHEMA,
  PARSE_SCHEMA,
  readContentJson,
  readModel,
  readProviderError,
  readUsage,
  type ResponseFormatMode,
  type WireContentPart,
  type WireMessage,
} from './adapters/wire';

// --- cost ---------------------------------------------------------------------------------------

export { MODEL_PRICES, costMicros, type CallCost, type ModelPrice } from './pricing';
