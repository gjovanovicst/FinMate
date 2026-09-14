/**
 * Fixture schema for the golden dataset (docs/10-testing-and-quality.md §5.1, docs/04 §11.1).
 *
 * **Minor units are strings here, deliberately.** `amountMinor` is a `bigint` everywhere in the
 * product (ADR-003, docs/03 §3.1), and JSON has no bigint — a number would silently round past
 * `Number.MAX_SAFE_INTEGER` and quietly reintroduce the float the whole money path exists to
 * exclude. The harness parses these strings with `BigInt(...)` and compares bigint to bigint.
 *
 * Owner: docs/10-testing-and-quality.md §5.1 (case shape) and §1 (this harness is layer 1, the
 * deterministic suite — it asserts *parsing*, not categorisation).
 */

/** The three slices task 2.1.2 ships. The remaining §11.1 slices slot in beside them. */
export type GoldenSlice = 'AMOUNT_FORMAT' | 'MERCHANT' | 'BULK';

export type GoldenKind = 'EXPENSE' | 'INCOME' | 'UNKNOWN';

/**
 * The fields a case may pin.
 *
 * A **present key is asserted; an absent key is not**. That is not laziness — docs/04 §3.1 leaves a
 * few questions genuinely open (what `kind` a `vraćeno 2000` fragment has, which number is the
 * amount when a fragment carries several), and a case for one of those must assert only what the
 * specification decides. Each omission is recorded in `note` and listed in `README.md` under
 * "known gaps".
 */
export interface GoldenExpectation {
  /** Minor units as a decimal string, or `null` for "this fragment carries no amount". */
  readonly amountMinor?: string | null;
  /** ISO-4217 code the fragment itself names, or `null` when it inherits the ledger currency. */
  readonly currency?: string | null;
  readonly kind?: GoldenKind;
  /** ISO local date, or `null`. Always relative to the case's pinned `today`. */
  readonly occurredOn?: string | null;
  readonly description?: string;
  /** Folded content tokens (docs/04 §3.2), asserted exactly and in order. */
  readonly tokens?: readonly string[];
  /** How many readings the ambiguity policy surfaced. Only meaningful on ambiguity cases. */
  readonly candidates?: number;
  readonly needsDirectionConfirmation?: boolean;
}

/** One closed-world fixture. It is scoreable with no human and no network (docs/10 §5.1). */
export interface GoldenCase {
  /** `'amount-0042'` — stable forever, prefixed by slice. */
  readonly id: string;
  readonly slice: GoldenSlice;
  /** Exactly what the user typed. */
  readonly input: string;
  /**
   * The day every relative date in this case is resolved against. **Required**, so a case can never
   * read the clock: `juče` is only meaningful in the Household's timezone (docs/03 §3.2) and a
   * parser that reads the clock is untestable.
   */
  readonly today: string;
  /** The Household ledger currency, used when the text names none. Required for the same reason. */
  readonly ledgerCurrency: string;
  /**
   * One expectation per fragment. `BULK` cases always use the array form (its whole point is how
   * many fragments segmentation produced); the other slices use a single object.
   */
  readonly expected: GoldenExpectation | readonly GoldenExpectation[];
  /** Why an expectation is what it is, or which field is deliberately unasserted and why. */
  readonly note?: string;
  readonly provenance: 'hand-labelled' | 'synthetic';
  /** ISO date the case was added, for trend annotations. */
  readonly addedIn: string;
}
