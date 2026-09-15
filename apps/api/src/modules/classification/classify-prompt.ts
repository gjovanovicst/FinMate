/**
 * The classify prompt — docs/04-categorization-and-ai-engine.md §6.3, rendered in-process.
 *
 * ## Prompt content lives here, not in `packages/ai`
 *
 * `@finmate/ai` is transport: it redacts, ships, times, prices and returns. It does not own prompt
 * text (see its module header), because a prompt is product content that changes on a product
 * schedule and must be versioned independently of the adapter. {@link CLASSIFY_PROMPT} carries that
 * version, and every audit row stores it, which is what makes an accuracy regression attributable to
 * a prompt change rather than a guess (docs/04 §9).
 *
 * ## Two things the §6.3 shape buys
 *
 * - **The category list is closed and small.** §6.3's "top ~25 by keyword/embedding retrieval, not
 *   the whole tree for large households" is the cost control; the caller passes the list and §6.2's
 *   validation refuses anything outside it.
 * - **The fragment is delimited as untrusted data.** `asUntrusted` wraps it, so a fragment that says
 *   "ignore previous instructions" is data, not an instruction (docs/08 §6.9 defence 3).
 *
 * @module apps/api/src/modules/classification
 */

import { asUntrusted, renderClassifyContext, UNTRUSTED_SYSTEM_PREAMBLE } from '@finmate/ai';
import type { TransactionFragment } from '@finmate/nlp';
import type { KeywordCandidate } from '@finmate/rules-engine';

/**
 * One entry of the closed category list the prompt renders.
 *
 * `path` is the display breadcrumb the model reads (`Hrana / Supermarket`); `id` is the only thing it
 * may return (docs/04 §6.2). Kept a separate type from the pipeline's `PipelineCategory` so a caller
 * cannot accidentally make the prompt depend on a database column it does not need.
 */
export interface PromptCategory {
  readonly id: string;
  /** Display breadcrumb the model reads, e.g. `Hrana / Supermarket`. */
  readonly path: string;
  readonly description?: string;
}

/**
 * Inputs {@link promptFor} renders.
 *
 * `categories` is typed to the *prompt's* needs, not the pipeline's, so `ClassifyRequest` stays the
 * only place that knows about both.
 */
export interface ClassifyPromptInput {
  readonly fragment: TransactionFragment;
  /** The resolved entity names, when stage 3 hit. */
  readonly merchantName?: string;
  readonly counterpartyName?: string;
  /** The scored keyword candidates, attached as context (docs/04 §5.4). */
  readonly keywordCandidates: readonly KeywordCandidate[];
  readonly categories: readonly PromptCategory[];
}

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
export function promptFor(input: ClassifyPromptInput): RenderedPrompt {
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

  const knownMerchants = input.merchantName ? `Known merchant: ${input.merchantName}` : null;
  const knownPeople = input.counterpartyName ? `Known person: ${input.counterpartyName}` : null;

  const user = [
    renderClassifyContext({
      categories: input.categories.map((category) => ({
        id: category.id,
        path: category.path,
        ...(category.description ? { description: category.description } : {}),
      })),
      ...(knownMerchants ? { knownMerchants: [knownMerchants] } : {}),
      ...(knownPeople ? { knownPeople: [knownPeople] } : {}),
    }),
    // The fragment is the one part of the prompt a user controls, so it is the one part that is
    // delimited (docs/08 §6.9 defence 3).
    `Input: ${asUntrusted(input.fragment.rawText)}`,
  ].join('\n\n');

  return { system, user };
}
