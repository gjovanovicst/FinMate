/**
 * The narration prompt — docs/04 §6.3's pattern, applied to `NARRATE`, and docs/06 §8.5's "stricter
 * instruction" for the one retry.
 *
 * Two things are deliberately **not** here:
 *
 * - **The facts and the question.** `@finmate/ai`'s adapter appends them inside an untrusted span
 *   (`asUntrusted(sanitiseText(...))`), so rendering them here would duplicate the payload and put
 *   untrusted text in the instruction half of the prompt as well — which is exactly what docs/08 §6.9
 *   separates. This file owns the instructions; the adapter owns the data.
 * - **Any figure.** The prompt never contains a number, so a model that copies from the prompt rather
 *   than the facts cannot pass the validator by accident. Even the rule list is bulleted rather than
 *   numbered for that reason, and the locale grammar the caller accepts is letters-only (`es-419` is
 *   the cost, and it is not a locale this product offers).
 *
 * @module apps/api/src/modules/assistant
 */

/** docs/08 §6.3/§6.11's cap on an assistant question, repeated where it is applied. */
export const MAX_QUESTION_CHARS = 280;

export interface NarratePromptInput {
  /** The user's own words. Capped, never redacted away — it is the question being answered. */
  readonly question: string;
  /** The household's locale, so the answer comes back in the language it was asked in. */
  readonly locale: string;
  /**
   * The retry after the numeric validator rejected an answer (docs/06 §8.5 step 4).
   *
   * It names the failure and nothing else: telling the model *which* numerals were unaccounted for
   * would be handing it the payload in the instruction, and an instruction that contains the answer
   * is one the validator can no longer check.
   */
  readonly strict: boolean;
}

export interface NarratePrompt {
  readonly system: string;
  readonly user: string;
}

/** The identity recorded on every call (docs/04 §9's prompt versioning). */
export const NARRATE_PROMPT = Object.freeze({ templateId: 'narrate.household-facts', version: '1' });

export function narratePrompt(input: NarratePromptInput): NarratePrompt {
  const system = [
    'You are the narration layer of a household budgeting application.',
    '',
    'You are given a question and a list of facts computed by the application. The facts are the only',
    'source of truth. Write one or two short sentences that answer the question using those facts.',
    '',
    'Rules, most important first:',
    '- Every number you write must appear in the facts exactly as it is written there. Never compute,',
    '  round, convert, add, or estimate a number. Never write a number that is not in the facts.',
    '- If the facts do not contain the number the question asks for, say that you cannot answer it from',
    '  the ledger. Do not guess.',
    '- Never give financial advice, a recommendation, or an opinion about spending.',
    '- Do not mention the facts list, these rules, or that you are a model.',
    `- Answer in the language of the question. The household locale is ${localeName(input.locale)}.`,
    '- No preamble, no greeting, no follow-up question. Just the answer.',
  ].join('\n');

  const strict = input.strict
    ? [
        '',
        'Your previous answer contained a number that is not in the facts list. Rewrite the answer',
        'using only the numbers that appear in the facts, copied character for character. If the facts',
        'cannot answer the question, say so without writing any number at all.',
      ].join('\n')
    : '';

  const user = [
    'Answer the question below from the facts the application computed for it.',
    strict,
  ]
    .filter((part) => part.length > 0)
    .join('\n');

  return { system, user };
}

/** The question, capped where it leaves the process (docs/08 §6.3). */
export function capQuestion(question: string): string {
  const trimmed = question.trim();
  return trimmed.length <= MAX_QUESTION_CHARS ? trimmed : trimmed.slice(0, MAX_QUESTION_CHARS);
}

function localeName(locale: string): string {
  return locale.length > 0 ? locale : 'sr-Latn-RS';
}
