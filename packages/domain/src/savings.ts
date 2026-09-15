import type { CurrencyCode } from './money';

/**
 * The savings-proposal calculator — docs/01 F-30, docs/02 §4.16.
 *
 * > *"How do I save X this month?"* — **backend computes, AI explains.**
 *
 * ## What it is, and what it deliberately is not
 *
 * It is a **deterministic** plan: given a target and what the Household actually spent per Category in
 * the period, it proposes a reduction per Category until the target is met, or reports the shortfall if
 * it cannot be. Pure, in integer minor units, no I/O, no model (ADR-001) — which is also why F-30
 * survives an AI outage with only its narrative gone ([08 §6.7](../../../docs/08-security-privacy-and-compliance.md)).
 *
 * It is **not** advice about which spending is cuttable. Nothing in the data model marks a Category as
 * discretionary, so the rule is stated and applied uniformly: **up to {@link DEFAULT_CAP_PERCENT}% of
 * each Category's own spend, biggest Category first**. A smarter proposal needs a product decision and
 * a column (an `essential` flag on `categories`), not a heuristic invented here — the honest
 * consequence is that a Household's largest Category may well be rent, and the plan says so rather than
 * quietly proposing something else.
 *
 * ## Why the cap exists at all
 *
 * "Save 20.000" answered with "spend nothing" is arithmetically fine and useless. A plan that asks for
 * a fifth of each Category is one a person can actually attempt, and the shortfall is the honest part
 * of the answer: a target this rule cannot reach is reported as unreachable rather than met on paper.
 *
 * @module @finmate/domain
 */

/** The stated cap: a Category is never asked to give up more than this share of its own spend. */
export const DEFAULT_CAP_PERCENT = 20;

const MAX_CAP_PERCENT = 100;

/** One Category's confirmed spend in the period. Splits must already be included (invariant I-1). */
export interface SavingsCandidate {
  readonly categoryId: string;
  /** Minor units, always positive — a Category with no spend is not a candidate. */
  readonly spentMinor: bigint;
}

export interface SavingsProposalLine {
  readonly categoryId: string;
  /** What the period's spend would fall to if the reduction is kept. */
  readonly proposedSpendMinor: bigint;
  readonly reductionMinor: bigint;
  /** The reduction as a share of that Category's spend, floored to a whole percent. */
  readonly reductionPercent: number;
}

export interface SavingsProposalInput {
  /** How much the Household wants to save in the period. Must be positive. */
  readonly targetMinor: bigint;
  readonly candidates: readonly SavingsCandidate[];
  readonly capPercent?: number;
  readonly currency?: CurrencyCode;
}

export interface SavingsProposal {
  readonly targetMinor: bigint;
  readonly currency: CurrencyCode;
  /** The cap this plan was computed under, echoed so the figure is auditable. */
  readonly capPercent: number;
  /** Biggest reduction first; only Categories that gave something up appear. */
  readonly lines: readonly SavingsProposalLine[];
  /** The sum of the lines. Never more than the target. */
  readonly proposedMinor: bigint;
  /** What the rule could not cover — `0n` when the target is met. The rest of the answer. */
  readonly shortfallMinor: bigint;
  /** True when the target is fully covered. */
  readonly meetsTarget: boolean;
  /** Every input, echoed back so the UI can show its working (docs/01 F-19's convention). */
  readonly basis: {
    readonly candidatesConsidered: number;
    readonly spentMinor: bigint;
  };
}

/**
 * Propose reductions that add up to at most `targetMinor`.
 *
 * Determinism, explicitly: candidates are ordered by spend **descending**, ties broken by
 * `categoryId` ascending, so two identical inputs always produce the same plan — a proposal that
 * reshuffles between two identical requests is one nobody can act on.
 *
 * Arithmetic, explicitly: every step is `bigint`. The cap is `(spent * capPercent) / 100n`, which
 * floors — so a Category whose cap is a fraction of a para gives up the whole para it can, and no
 * float ever touches a money value (ADR-003).
 */
export function proposeSavings(input: SavingsProposalInput): SavingsProposal {
  const capPercent = input.capPercent ?? DEFAULT_CAP_PERCENT;
  if (!Number.isInteger(capPercent) || capPercent < 1 || capPercent > MAX_CAP_PERCENT) {
    throw new Error(`capPercent must be a whole number between 1 and ${MAX_CAP_PERCENT}`);
  }
  if (input.targetMinor <= 0n) {
    throw new Error('A savings target must be greater than zero');
  }

  const ordered = [...input.candidates]
    .filter((candidate) => candidate.spentMinor > 0n)
    .sort((left, right) =>
      right.spentMinor > left.spentMinor
        ? 1
        : right.spentMinor < left.spentMinor
          ? -1
          : left.categoryId < right.categoryId
            ? -1
            : 1,
    );

  const lines: SavingsProposalLine[] = [];
  let remaining = input.targetMinor;
  let proposed = 0n;

  for (const candidate of ordered) {
    if (remaining <= 0n) break;

    const cap = (candidate.spentMinor * BigInt(capPercent)) / 100n;
    if (cap <= 0n) continue;

    const reduction = cap < remaining ? cap : remaining;
    remaining -= reduction;
    proposed += reduction;
    lines.push({
      categoryId: candidate.categoryId,
      proposedSpendMinor: candidate.spentMinor - reduction,
      reductionMinor: reduction,
      reductionPercent: Number((reduction * 100n) / candidate.spentMinor),
    });
  }

  const shortfall = input.targetMinor - proposed;
  return {
    targetMinor: input.targetMinor,
    currency: input.currency ?? 'RSD',
    capPercent,
    lines,
    proposedMinor: proposed,
    shortfallMinor: shortfall,
    meetsTarget: shortfall === 0n,
    basis: {
      candidatesConsidered: ordered.length,
      spentMinor: ordered.reduce((sum, candidate) => sum + candidate.spentMinor, 0n),
    },
  };
}
