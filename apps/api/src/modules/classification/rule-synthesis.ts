import { foldForMatching, foldTokens, INCOME_MARKERS, NEGATION_MARKERS } from '@finmate/nlp';
import type { ConditionTree, EvaluationContext, RuleActions, RuleOrigin } from '@finmate/rules-engine';

/**
 * Rule synthesis — docs/04 §8.1. From a correction, derive **the narrowest rule that would have
 * prevented it**.
 *
 * Pure and I/O-free on purpose. The interesting question ("which rule should this correction
 * become?") is a decision about *shape*, and it can be answered — and tested exhaustively — without a
 * database. The caller supplies the rule set when it wants the conflict check, because that is the
 * one part that needs to know what else exists.
 *
 * ## Never auto-creates anything
 *
 * docs/04 §8.2 and ADR-010: synthesis **proposes**; the user confirms. Nothing in this file writes.
 * The {@link RuleProposal} that comes out is inert data, and §8.2's "no rule from a single ambiguous
 * correction unless the trigger is a resolved entity" is honoured by the *confirmation* step plus the
 * confidence below — a token-shaped guess is proposed at a confidence that says "check this", never
 * applied.
 *
 * ## The trigger order, and why
 *
 * Narrowest first. A resolved Counterparty is a durable identity the user created; a resolved
 * Merchant is a place we matched; a text token is a guess about wording. And a Merchant the user has
 * now corrected three times is a *different* problem — the answer is to fix that Merchant's default
 * rather than to pile up rules, which is exactly how rule sets rot (docs/04 §8.2).
 *
 * @module apps/api/src/modules/classification
 */

/** docs/06 §5.3's `RuleSynthesisTrigger`. */
export type RuleSynthesisTrigger =
  | 'COUNTERPARTY_RESOLVED'
  | 'MERCHANT_RESOLVED'
  | 'DISTINCTIVE_TOKEN'
  | 'REPEATED_MERCHANT_CORRECTION'
  | 'CONTRADICTS_EXISTING_RULE';

/**
 * Stable codes the client localises, following the same rule as the API's error codes: the server
 * owns the machine-readable code and a safe English sentence, and the *client* owns the wording
 * (AGENTS.md — no hardcoded user-facing strings). docs/06 §5.3 declares `explanation` only and says
 * the UI shows it verbatim; `explanationCode` is the additive field that lets the client localise
 * instead, so the proposal reads in the user's language.
 */
export type RuleExplanationCode =
  | 'RULE_SYNTH_COUNTERPARTY'
  | 'RULE_SYNTH_MERCHANT'
  | 'RULE_SYNTH_TOKEN'
  | 'RULE_SYNTH_MERCHANT_REPEAT'
  | 'RULE_SYNTH_CONTRADICTS';

/** docs/04 §8.1's `priority` default; lower wins (docs/04 §5.3.1). */
export const LEARNED_RULE_PRIORITY = 100;

/**
 * `confidence` per trigger.
 *
 * **Derived, not specified** — docs/04 §8.1 gives the triggers and §8.2 the guardrails, and no
 * numbers. The ordering is the point: a resolved entity is a fact about the user's own data, a text
 * token is a guess about their wording, and a repeat is a pattern that needs a different fix. Used
 * for ordering and explanation only; it never gates anything automatically, because nothing here
 * auto-creates.
 */
export const TRIGGER_CONFIDENCE: Readonly<Record<RuleSynthesisTrigger, number>> = Object.freeze({
  COUNTERPARTY_RESOLVED: 0.9,
  MERCHANT_RESOLVED: 0.85,
  REPEATED_MERCHANT_CORRECTION: 0.8,
  DISTINCTIVE_TOKEN: 0.55,
  CONTRADICTS_EXISTING_RULE: 0.5,
});

/** docs/04 §8.2: the third correction of one Merchant to one Category is a default, not a rule. */
export const REPEATED_MERCHANT_CORRECTION_THRESHOLD = 3;

/** Shortest token considered distinctive. `ulje` (docs/04 §5.4's own example) is four. */
export const MIN_DISTINCTIVE_TOKEN_LENGTH = 4;

/**
 * Tokens that must never become a rule's trigger.
 *
 * A rule keyed on `i` or `za` would match half the household's ledger, and one keyed on `plata`
 * would fight the income markers the parser already owns. There is no stopword list in
 * `packages/nlp` because the parser does not need one; this is a *synthesis* concern, so it lives
 * here. Deliberately small and explicit rather than clever: a wrong entry silently removes a
 * sentence the user would have wanted, so the list only holds words that cannot be a merchant, a
 * good or a service.
 */
export const NON_DISTINCTIVE_TOKENS: readonly string[] = Object.freeze([
  'i',
  'pa',
  'za',
  'na',
  'od',
  'do',
  'sa',
  'se',
  'je',
  'su',
  'the',
  'and',
  'for',
  'racun',
  'kartica',
  'kartice',
  'kes',
  'gotovina',
  'kupovina',
  'uplata',
  'isplata',
  'rata',
  'mesecno',
  'danas',
  'juce',
  // The parser's own markers: a token the direction parser already interprets is not a category
  // signal, and a rule on it would disagree with the parser (docs/04 §3.1).
  ...INCOME_MARKERS,
  ...NEGATION_MARKERS,
]);

/** Everything synthesis needs about the correction, supplied by the caller. Pure data. */
export interface CorrectionSubject {
  /** The Category the user corrected **to** — the rule's action. */
  readonly categoryId: string;
  /** For the explanation only; the rule itself stores the id. */
  readonly categoryName: string;
  /** The Transaction's `description` — the same text the rule engine is evaluated against. */
  readonly description: string;
  readonly merchantId: string | null;
  readonly merchantName: string | null;
  readonly counterpartyId: string | null;
  readonly counterpartyName: string | null;
  /**
   * How many **earlier** corrections sent this same Merchant to this same Category.
   *
   * `2` therefore means "this is the third", which is docs/04 §8.2's threshold.
   */
  readonly priorSameMerchantCorrections: number;
}

/** A keyword synthesis wants added alongside the rule (docs/04 §8.1, the `DISTINCTIVE_TOKEN` row). */
export interface SuggestedKeyword {
  readonly keyword: string;
  readonly categoryId: string;
}

export interface RuleSynthesis {
  readonly proposal: RuleProposal;
  /** Non-null only for a token trigger: §8.1 wants the token added as an INCLUDE keyword too. */
  readonly keyword: SuggestedKeyword | null;
  /**
   * An input that the proposed rule matches, for the caller to run the conflict check against.
   *
   * This is what makes the conflict check a *fact* rather than a guess: the caller evaluates the real
   * engine over the real rule set with this context and asks who wins. Synthesis and conflict
   * detection therefore cannot drift from runtime behaviour, because they run the same code.
   */
  readonly witness: EvaluationContext;
}

/** One candidate rule, ready for docs/06 §5.3's `RuleProposal`. */
export interface RuleProposal {
  readonly name: string;
  readonly priority: number;
  readonly conditions: ConditionTree;
  readonly actions: RuleActions;
  readonly origin: RuleOrigin;
  /** Safe English fallback, per docs/06 §5.3. The client localises `explanationCode` instead. */
  readonly explanation: string;
  readonly explanationCode: RuleExplanationCode;
  readonly trigger: RuleSynthesisTrigger;
  readonly confidence: number;
}

/**
 * Synthesise the narrowest rule that would have prevented this correction, or `null`.
 *
 * `null` means "there is nothing to propose" — no resolved entity and no distinctive token — which is
 * a legitimate outcome for a correction on a bare amount. The caller shows no prompt rather than a
 * useless one.
 *
 * ## The name carries no language
 *
 * It used to be `Naučeno: <merchant> → <category>`, which baked a Serbian word into `rules.name` for
 * every Household — a stored string the reader can never re-language (ADR-040). The name is now just
 * the mapping, and the fact that the app learned it is what `origin: LEARNED` is for; `/rules` already
 * renders `rules.origin.LEARNED` beside the name.
 */
export function synthesiseRule(subject: CorrectionSubject): RuleSynthesis | null {
  const repeated =
    subject.merchantId !== null &&
    subject.priorSameMerchantCorrections + 1 >= REPEATED_MERCHANT_CORRECTION_THRESHOLD;

  if (repeated && subject.merchantId !== null) {
    return {
      proposal: proposal({
        name: `${subject.merchantName ?? subject.merchantId} → ${subject.categoryName}`,
        conditions: { all: [{ field: 'merchant', op: 'eq', value: subject.merchantId }] },
        actions: { setCategoryId: subject.categoryId },
        trigger: 'REPEATED_MERCHANT_CORRECTION',
        code: 'RULE_SYNTH_MERCHANT_REPEAT',
        explanation:
          `You have changed ${subject.merchantName ?? 'this merchant'} to ` +
          `${subject.categoryName} ${subject.priorSameMerchantCorrections + 1} times. Setting that as ` +
          `the merchant's default category is usually better than adding another rule.`,
      }),
      keyword: null,
      witness: { merchantId: subject.merchantId, text: subject.description, description: subject.description },
    };
  }

  if (subject.counterpartyId !== null) {
    return {
      proposal: proposal({
        name: `${subject.counterpartyName ?? subject.counterpartyId} → ${subject.categoryName}`,
        conditions: { all: [{ field: 'counterparty', op: 'eq', value: subject.counterpartyId }] },
        actions: { setCategoryId: subject.categoryId },
        trigger: 'COUNTERPARTY_RESOLVED',
        code: 'RULE_SYNTH_COUNTERPARTY',
        explanation:
          `Everything from ${subject.counterpartyName ?? 'this person'} goes to ` +
          `${subject.categoryName} from now on.`,
      }),
      keyword: null,
      witness: {
        counterpartyId: subject.counterpartyId,
        text: subject.description,
        description: subject.description,
      },
    };
  }

  if (subject.merchantId !== null) {
    return {
      proposal: proposal({
        name: `${subject.merchantName ?? subject.merchantId} → ${subject.categoryName}`,
        conditions: { all: [{ field: 'merchant', op: 'eq', value: subject.merchantId }] },
        actions: { setCategoryId: subject.categoryId },
        trigger: 'MERCHANT_RESOLVED',
        code: 'RULE_SYNTH_MERCHANT',
        explanation:
          `Everything bought at ${subject.merchantName ?? 'this merchant'} goes to ` +
          `${subject.categoryName} from now on.`,
      }),
      keyword: null,
      witness: { merchantId: subject.merchantId, text: subject.description, description: subject.description },
    };
  }

  const token = distinctiveToken(subject.description);
  if (token === null) return null;

  return {
    proposal: proposal({
      name: `${token} → ${subject.categoryName}`,
      conditions: { all: [{ field: 'text', op: 'contains', value: token }] },
      actions: { setCategoryId: subject.categoryId },
      trigger: 'DISTINCTIVE_TOKEN',
      code: 'RULE_SYNTH_TOKEN',
      explanation:
        `Anything mentioning “${token}” goes to ${subject.categoryName} from now on. This came from ` +
        `one entry, so check that the word really means what you think it does.`,
    }),
    keyword: { keyword: token, categoryId: subject.categoryId },
    witness: { text: token, description: token },
  };
}

/**
 * The most distinctive content token in `description`, or `null`.
 *
 * "Most distinctive" is the **longest** eligible token, ties broken by first appearance. A heuristic,
 * and deliberately a conservative one: length is the best available proxy for specificity
 * (`septička` beats `jama`), and when two candidates tie the earlier one is the one the user put
 * first. Rejecting a description entirely is better than proposing a rule on a throwaway word — a bad
 * rule is permanent policy (docs/04 §8.2) and the user has to find and delete it.
 */
export function distinctiveToken(description: string): string | null {
  const tokens = foldTokens(description);

  let best: string | null = null;
  for (const token of tokens) {
    if (token.length < MIN_DISTINCTIVE_TOKEN_LENGTH) continue;
    // A pure number is an amount or a date fragment, never a category signal.
    if (/^\d+$/.test(token)) continue;
    if (NON_DISTINCTIVE_TOKENS.includes(token)) continue;
    // The words `contains` will compare are folded, so the rule must store the folded form or it
    // would never match (the same reason keywords are stored folded).
    if (best === null || token.length > best.length) best = token;
  }

  return best;
}

function proposal(args: {
  readonly name: string;
  readonly conditions: ConditionTree;
  readonly actions: RuleActions;
  readonly trigger: RuleSynthesisTrigger;
  readonly code: RuleExplanationCode;
  readonly explanation: string;
}): RuleProposal {
  return {
    name: args.name,
    priority: LEARNED_RULE_PRIORITY,
    conditions: args.conditions,
    actions: args.actions,
    // ADR-010: a rule from a correction is `LEARNED`, never `USER` — the audit trail has to show that
    // the product proposed it and the user accepted, not that the user wrote it.
    origin: 'LEARNED',
    explanation: args.explanation,
    explanationCode: args.code,
    trigger: args.trigger,
    confidence: TRIGGER_CONFIDENCE[args.trigger],
  };
}

/**
 * Re-label a proposal that something else would shadow, without changing what it would do.
 *
 * docs/06 §5.3's `CONTRADICTS_EXISTING_RULE` trigger exists so the UI can say *why* it is offering to
 * edit an existing rule rather than to save a new one. The conditions and actions are untouched: the
 * trigger describes the situation, and rewriting the rule would hide what is being compared.
 */
export function triggerForConflict(proposal: RuleProposal): RuleProposal {
  return {
    ...proposal,
    trigger: 'CONTRADICTS_EXISTING_RULE',
    explanationCode: 'RULE_SYNTH_CONTRADICTS',
    confidence: TRIGGER_CONFIDENCE.CONTRADICTS_EXISTING_RULE,
    explanation:
      `An existing rule already handles this, so “${proposal.name}” would never fire. Editing that ` +
      `rule is usually better than adding a second one.`,
  };
}

/**
 * Derive an input that a stored rule's conditions match, or `null` when none can be derived.
 *
 * This is the reverse of {@link synthesiseRule}: instead of "which rule fits this correction", it asks
 * "what input would this rule fire on". It is what makes `Rule.conflictsWith` a **witnessed** check
 * rather than a static overlap heuristic — the caller runs the real engine on this input and asks who
 * actually wins, so the answer cannot drift from runtime behaviour.
 *
 * Returns `null` for any condition it cannot witness: `any`, `none`, a nested tree, `is_null`,
 * `regex`, `starts_with` on an empty value, `in`/`between` (a witness would be one arbitrary member),
 * `not_contains`, a `dayOfWeek`/`dayOfMonth` predicate (the calendar comes from the Transaction, not
 * from the rule), or an amount that is not a decimal integer. Returning `null` means "cannot check",
 * and the caller reports no conflicts for that rule — a rule with no witness is not a rule with no
 * conflicts, and conflating the two is how a screen starts lying.
 */
export function witnessFromConditions(conditions: ConditionTree): EvaluationContext | null {
  const leaves =
    typeof conditions === 'object' && conditions !== null && 'all' in conditions
      ? conditions.all
      : [conditions];

  const context: {
    text?: string;
    description?: string;
    merchantId?: string | null;
    counterpartyId?: string | null;
    kind?: 'EXPENSE' | 'INCOME' | null;
    amountMinor?: bigint | null;
  } = {};

  for (const leaf of leaves) {
    if (!('field' in leaf) || !('op' in leaf)) return null;

    switch (leaf.field) {
      case 'merchant':
        if (leaf.op !== 'eq' || typeof leaf.value !== 'string') return null;
        context.merchantId = leaf.value;
        break;

      case 'counterparty':
        if (leaf.op !== 'eq' || typeof leaf.value !== 'string') return null;
        context.counterpartyId = leaf.value;
        break;

      case 'text':
      case 'description': {
        if (leaf.op !== 'contains' && leaf.op !== 'equals') return null;
        if (typeof leaf.value !== 'string' || leaf.value.length === 0) return null;
        context.text = leaf.value;
        context.description = leaf.value;
        break;
      }

      case 'kind':
        if (leaf.op !== 'eq' || (leaf.value !== 'EXPENSE' && leaf.value !== 'INCOME')) return null;
        context.kind = leaf.value;
        break;

      case 'amount': {
        if (leaf.op !== 'eq') return null;
        // JSONB carries no bigint, so a stored amount is a decimal string. Anything else — a float, a
        // negative, a word — is not witnessable, and must not become a float in the money path.
        if (typeof leaf.value !== 'string' || !/^\d+$/.test(leaf.value)) return null;
        context.amountMinor = BigInt(leaf.value);
        break;
      }

      default:
        return null;
    }
  }

  return context as EvaluationContext;
}

/**
 * Does this condition tree actually match `context`? Used to reject a proposal that would not fire.
 *
 * Deliberately **not** a general matcher: it answers only "does the leaf the synthesis produced match
 * this witness", which is the one question the caller needs before offering a rule the user would
 * accept and never see work. The engine remains the authority (the caller runs it too) — this is the
 * cheap pre-check that keeps a nonsense proposal from reaching a prompt.
 */
export function conditionsMatchWitness(
  conditions: ConditionTree,
  witness: EvaluationContext,
): boolean {
  const leaves =
    typeof conditions === 'object' && conditions !== null && 'all' in conditions
      ? conditions.all
      : [conditions];

  return leaves.every((leaf) => {
    if (!('field' in leaf)) return false;
    if (leaf.field === 'merchant') return typeof leaf.value === 'string' && leaf.value === witness.merchantId;
    if (leaf.field === 'counterparty') {
      return typeof leaf.value === 'string' && leaf.value === witness.counterpartyId;
    }
    if (leaf.field === 'text' || leaf.field === 'description') {
      if (typeof leaf.value !== 'string') return false;
      // Both sides folded, exactly as the engine compares them.
      return foldForMatching(witness.text ?? '').includes(foldForMatching(leaf.value));
    }
    return true;
  });
}
