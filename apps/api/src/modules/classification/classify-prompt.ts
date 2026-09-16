/**
 * The classify prompt — docs/04-categorization-and-ai-engine.md §6.3, rendered in-process.
 *
 * ## The caller owns the *instructions*; the adapter owns the *payload*
 *
 * That split is not a preference, it is the only one that works, and this file used to get it wrong.
 * The category list cannot be rendered here: `packages/ai` replaces every category id with an opaque
 * placeholder (`u1`, `c1`, `n1`) before the request ships, so the ids the model is allowed to answer
 * with do not exist until the adapter builds the message (docs/08 §6.3 — the model never sees a real
 * id, and the redaction map is the only way back). A caller that renders the list itself renders a
 * *second*, different list — and a model told "choose only from the provided list" then answers with
 * an id the redaction map cannot resolve, which validation turns into `null`.
 *
 * So: this module renders the rules and the task instruction. The adapter appends the closed category
 * list (with placeholders), the known entities, the few-shot examples and the redacted fragment.
 *
 * ## Why the text still lives here
 *
 * `@finmate/ai` is transport: it redacts, ships, times, prices and returns. Prompt *content* is product
 * content that changes on a product schedule and must be versioned independently of the adapter.
 * {@link CLASSIFY_PROMPT} carries that version and every audit row stores it, which is what makes an
 * accuracy regression attributable to a prompt change rather than a guess (docs/04 §9).
 *
 * @module apps/api/src/modules/classification
 */

import { UNTRUSTED_SYSTEM_PREAMBLE } from '@finmate/ai';

/**
 * One entry of the closed category list the **adapter** renders, as the caller knows it.
 *
 * `path` is the display breadcrumb the model reads (`Hrana / Supermarket`); `id` is the only thing it
 * may return (docs/04 §6.2) — and `packages/ai` substitutes that id for a placeholder before the
 * request ships, so this shape is the caller-side view rather than the wire's. Kept separate from the
 * pipeline's `PipelineCategory` so a caller cannot accidentally make the prompt depend on a database
 * column it does not need.
 */
export interface PromptCategory {
  readonly id: string;
  /** Display breadcrumb the model reads, e.g. `Hrana / Supermarket`. */
  readonly path: string;
  readonly description?: string;
}

/**
 * What the caller must hand {@link promptFor}.
 *
 * Deliberately empty, and typed as an object rather than removed so the call site reads the same and a
 * future instruction parameter has an obvious home. Every field this interface used to carry —
 * `fragment`, `categories`, the entity names, the keyword candidates — belongs to the adapter's
 * payload, not the caller's instructions (see the module header).
 */
export type ClassifyPromptInput = Record<string, never>;

/** A rendered prompt: the two strings the provider receives. */
export interface RenderedPrompt {
  readonly system: string;
  readonly user: string;
}

/**
 * Render the §6.3 classify prompt.
 *
 * The system text is §6.3's list of rules, kept verbatim where it states a product constraint
 * (*never invent an id*, *never perform arithmetic*, the Serbian amount/income conventions) because
 * those sentences are the prompt's actual contract with the model.
 */
export function promptFor(_input: ClassifyPromptInput = {}): RenderedPrompt {
  const system = [
    UNTRUSTED_SYSTEM_PREAMBLE,
    'You extract and classify household financial transactions for a Serbian household.',
    'Rules you must follow:',
    '- Choose a category ONLY from the provided list of ids. Never invent an id.',
    '- If you are unsure, return a low confidence and list alternatives. Do not guess confidently.',
    '- Never perform arithmetic. Never compute totals or balances.',
    '- Input may mix Serbian latin and cyrillic, abbreviations and typos.',
    '- "plata", "penzija", "uplata", "povraćaj" indicate INCOME unless context says otherwise.',
    '- Amounts: "." and space are thousands separators, "," is the decimal separator.',
    'Respond with JSON matching the required schema and nothing else.',
  ].join('\n');

  // No category list, no fragment, no entity names: the adapter appends all four, redacted and with
  // the ids substituted. Anything rendered here would be a second copy the model could answer with.
  const user = [
    'Classify the household transaction given below.',
    'The candidate categories, the known merchants and people, and the input itself follow in the next message.',
    'Choose an id exactly as it is written in that candidate list, or null when nothing fits.',
  ].join('\n');

  return { system, user };
}
