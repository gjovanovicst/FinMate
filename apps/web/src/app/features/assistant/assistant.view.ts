import type { TranslationKey } from '../../core/i18n/translations';
import type { MoneyWire } from '../../shared/ui/money/money.component';
import { filterQueryFromBag } from '../transactions/transactions.view';

/**
 * The assistant screen's decisions, as pure functions — F-23, docs/02 §FL-09, docs/06 §8.
 *
 * What lives here is the part that is **wrong silently**:
 *
 *  - which of the five answer phases the screen is in, because a refusal rendered as an answer, or an
 *    error rendered as a refusal, is a lie about whether the ledger answered the question;
 *  - which figures the answer card may show, and in what shape — a `rows[].value` is minor units and
 *    must go through `fm-money` (the only money formatter, ADR-003), but a value that is *not* an
 *    integer is not money and must not be dressed as some;
 *  - the drill-through link, which must be **absent** when the API offered none rather than pointing
 *    at an unfiltered list that would show rows the answer did not come from (docs/06 §4.4);
 *  - the template-fallback decision: docs/06 §8.5 says the UI makes it invisible, so `narrationMode`
 *    and `reason` are deliberately **not** rendered anywhere. A correct answer computed without a
 *    model is not a degraded experience, and labelling it as one teaches users to distrust it.
 *
 * @module apps/web/src/app/features/assistant
 */

export type NarrationMode = 'LLM' | 'TEMPLATE_FALLBACK';

export interface AssistantFactRow {
  readonly label: string;
  readonly value: string;
  readonly formatted: string;
  readonly categoryId?: string | null;
  readonly merchantId?: string | null;
}

export interface AssistantFactTotal {
  readonly label: string;
  readonly money: MoneyWire;
  readonly formatted: string;
}

export interface AssistantFacts {
  readonly template: string;
  readonly rows: readonly AssistantFactRow[];
  readonly totals: readonly AssistantFactTotal[];
  readonly formatted: Readonly<Record<string, string>>;
}

export interface Provenance {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly transactionCount: number;
  readonly sourceQuery: string;
  readonly filters?: Readonly<Record<string, string>> | null;
  readonly computedAt: string;
  readonly ledgerCurrency: string;
}

export interface DrillThrough {
  readonly route: string;
  readonly transactionIds: readonly string[];
  readonly filter?: Readonly<Record<string, string>> | null;
}

export interface AssistantAnswer {
  readonly id: string;
  readonly question: string;
  readonly intent: string;
  readonly answered: boolean;
  readonly answerText: string;
  readonly facts: AssistantFacts;
  readonly provenance: Provenance;
  readonly drillThrough: DrillThrough | null;
  readonly suggestions: readonly string[];
  readonly narrationMode: NarrationMode;
  readonly latencyMs: number;
  readonly costMicros: string | null;
  readonly reason: string | null;
}

/** One exchange in the session's transcript: the question, and the answer if one came back. */
export interface Turn {
  readonly id: string;
  readonly question: string;
  readonly answer: AssistantAnswer | null;
  /** True when the request itself failed — a different state from the ledger refusing to answer. */
  readonly failed: boolean;
  /**
   * The write the answer refused to be, when the question asked for one.
   *
   * Absent for most turns: the proposal is only attempted after a **refusal**, which is the ordering
   * docs/06 §8.16 records — the read planner answers a question it can answer, and a write is offered
   * only when it had nothing to answer with.
   */
  readonly action?: TurnAction | null;
}

export type AnswerPhase = 'idle' | 'asking' | 'answered' | 'refused' | 'failed';

/**
 * Which state the screen shows.
 *
 * `refused` and `failed` are separate because they ask different things of the user: a refusal means
 * "ask something else" (the suggestions are useful), a failure means "try again" (they are noise).
 */
export function phaseOf(turn: Turn | null, asking: boolean): AnswerPhase {
  if (asking) return 'asking';
  if (turn === null) return 'idle';
  if (turn.failed) return 'failed';
  return turn.answer?.answered === true ? 'answered' : 'refused';
}

/** One figure the answer card renders as money, in the household's currency. */
export interface FactMoneyRow {
  readonly label: string;
  readonly money: MoneyWire;
}

/**
 * The row as money, or `null` when it is not an amount.
 *
 * `AssistantFactRow.value` is minor units for every builder this API has, but the field is documented
 * as "minor units for money, **a count otherwise**" (docs/06 §8.2). A bare integer is ambiguous on its
 * own — `3` is either 0,03 RSD or three transactions — so the decision is made the way the server
 * made it: **its own `formatted` string carries the currency** when the value is money. A count that
 * slipped through would render as "3,00 RSD", which is a wrong figure presented as a fact about money.
 */
export function moneyRow(row: AssistantFactRow, currency: string): MoneyWire | null {
  if (!/^\d+$/.test(row.value)) return null;
  return row.formatted.includes(currency) ? { amountMinor: row.value, currency } : null;
}

export function factRows(facts: AssistantFacts): readonly FactMoneyRow[] {
  const currency = facts.totals[0]?.money.currency ?? 'RSD';
  const rows: FactMoneyRow[] = [];
  for (const row of facts.rows) {
    const money = moneyRow(row, currency);
    if (money) rows.push({ label: row.label, money });
  }
  return rows;
}

/** Totals are money by construction (`totals[].money`), so they need no guard. */
export function factTotals(facts: AssistantFacts): readonly { label: string; money: MoneyWire }[] {
  return facts.totals.map((total) => ({ label: total.label, money: total.money }));
}

/**
 * Whether the answer has figures to expand.
 *
 * The provenance line ("based on N transactions") is always shown, and since 4.3.7b it is always a
 * `<details>` — the panel also carries how the answer was worded, so it is never a control that opens on
 * nothing. This decides only whether the **figures** belong inside it, which they do not when the card
 * already renders them (a proposal's table is above, and a report of what happened has none at all).
 */
export function canExpand(facts: AssistantFacts): boolean {
  return facts.rows.length > 0 || facts.totals.length > 0;
}

/** Where the drill-through link goes: the route and the arguments the screen understands. */
export interface DrillThroughTarget {
  readonly route: string;
  readonly queryParams: Readonly<Record<string, string>>;
}

/**
 * The link that lets the user check the answer, or `null`.
 *
 * `null` when the API offered no drill-through — a merchant- or tag-scoped answer has no route that
 * can reproduce its scope yet (docs/06 §8.8) — because a link that shows a *different* set of rows
 * than the answer aggregated is worse than no link at all.
 *
 * Route and parameters are **separate** because `[routerLink]` takes them separately: handing it one
 * string containing `?from=…` makes Angular treat the whole thing as a single path segment and
 * percent-encode the question mark, so the link points at a screen called
 * `/transactions%3Ffrom%3D2026-09-01` (docs/15).
 */
export function drillThroughTarget(drillThrough: DrillThrough | null): DrillThroughTarget | null {
  if (drillThrough === null) return null;
  return { route: drillThrough.route, queryParams: filterQueryFromBag(drillThrough.filter) };
}

/**
 * The suggestion chips for a turn: the canonical answerable questions, and never a chip that would
 * ask the same thing again.
 */
export function suggestionChips(turn: Turn | null): readonly string[] {
  if (turn?.answer === null || turn?.answer === undefined) return [];
  if (turn.answer.answered) return [];
  return turn.answer.suggestions.filter((question) => question.trim().length > 0);
}

/**
 * Whether this answer is F-30's **proposal** rather than a report of what happened.
 *
 * The screen renders it differently on purpose. A proposal is a table of *reductions* with a target and
 * a shortfall, and it must not read like a list of figures that already exist: the answer's own
 * sentence says what it is, and this decides which layout (docs/02 §4.16: *"a computed table labelled
 * Predlog (izračunato)"*).
 */
export function isProposal(facts: AssistantFacts): boolean {
  return facts.template === 'SAVINGS_PROPOSAL';
}

export interface ProposalSummary {
  /** What the Household asked to save. */
  readonly target: MoneyWire | null;
  /** What the rule could cover. */
  readonly proposed: MoneyWire | null;
  /** What it could not — the honest half of the answer. `null` when the target is met. */
  readonly shortfall: MoneyWire | null;
  readonly lines: readonly FactMoneyRow[];
}

/**
 * The proposal's three headline figures and its lines.
 *
 * The server labels them `Target`, `Proposed` and `Shortfall`; the mapping to translation keys is here
 * rather than in the template so an unrecognised label renders as the server's own word instead of a
 * missing key. A shortfall of zero is dropped: "short by 0,00 RSD" is noise on a plan that works.
 */
export function proposalSummary(facts: AssistantFacts): ProposalSummary {
  const byLabel = new Map(facts.totals.map((total) => [total.label, total.money]));
  const shortfall = byLabel.get('Shortfall') ?? null;
  return {
    target: byLabel.get('Target') ?? null,
    proposed: byLabel.get('Proposed') ?? null,
    shortfall: shortfall !== null && shortfall.amountMinor !== '0' ? shortfall : null,
    lines: factRows(facts),
  };
}

/** The translation key for a proposal total, or `null` to render the server's own label. */
export function proposalLabelKey(label: string): TranslationKey | null {
  switch (label) {
    case 'Target':
      return 'assistant.proposalTarget';
    case 'Proposed':
      return 'assistant.proposalProposed';
    case 'Shortfall':
      return 'assistant.proposalShortfall';
    default:
      return null;
  }
}

/**
 * What the drill-through link should say, from the route it points at.
 *
 * A link labelled "open the filtered list" that lands on the Budgets screen is the kind of small lie
 * nobody reports; four wordings and one lookup make it impossible. An unrecognised route gets the
 * transactions wording, which is the API's own default and the only route the filter bag is for.
 */
export function drillThroughLabelKey(
  drillThrough: DrillThrough | null,
):
  | 'assistant.openList'
  | 'assistant.openReview'
  | 'assistant.openBudgets'
  | 'assistant.openAccounts' {
  switch (drillThrough?.route) {
    case '/review':
      return 'assistant.openReview';
    case '/budgets':
      return 'assistant.openBudgets';
    case '/accounts':
      return 'assistant.openAccounts';
    default:
      return 'assistant.openList';
  }
}

/**
 * The provenance sentence's wording.
 *
 * Two forms rather than three, for the same reason {@link badgeAccessibleName} has two: the catalogue
 * has no plural machinery (ADR-019), and the caller interpolates — so a `{count}` placeholder can
 * never reach the DOM. Serbian's 2–4 form is therefore approximated, which is a catalogue limitation
 * recorded there rather than a decision taken here.
 */
export function provenanceKey(count: number): 'assistant.provenanceOne' | 'assistant.provenanceMany' {
  return count === 1 ? 'assistant.provenanceOne' : 'assistant.provenanceMany';
}

/** The period a figure covers, formatted for reading. Dates only: a provenance range is not an instant. */
export function periodLabel(provenance: Provenance, localeTag: string): string {
  const format = (day: string): string => {
    const [year, month, date] = day.split('-').map(Number);
    if (!year || !month || !date) return day;
    try {
      return new Intl.DateTimeFormat(localeTag, { day: 'numeric', month: 'short', year: 'numeric' }).format(
        // A calendar day, rendered as one: the UTC instant keeps the day the server meant, whatever
        // the browser's zone (I-2).
        new Date(Date.UTC(year, month - 1, date)),
      );
    } catch {
      return day;
    }
  };

  return provenance.periodStart === provenance.periodEnd
    ? format(provenance.periodStart)
    : `${format(provenance.periodStart)} – ${format(provenance.periodEnd)}`;
}

/**
 * How the sentence a person is reading was produced — task 4.3.7b.
 *
 * docs/06 §8.5 used to say the UI makes the template fallback **invisible**, on the grounds that "a
 * correct answer computed without a model is not a degraded experience". That was written when every
 * deployment fell back, so the mode carried no information — every answer was the template, and a badge
 * saying so would have trained people to distrust the figures. It is no longer true of a deployment that
 * routes `NARRATE` (ADR-032, and the dev `.env` does): the mode is now the only *statement* of which path
 * produced the words. The remaining clue that a fallback happened is that its copy is English while a
 * model answers in the household's locale — a clue, not a statement, and the second instance of the
 * no-catalogue breach §5.14 records.
 *
 * So it is disclosed, and quietly: inside the provenance panel, never as a badge on the card. The
 * distinction §8.5 was protecting is kept by the wording — the fallback is described as what it is
 * ("put into words by the app itself"), not as a failure.
 */
export function narrationKey(
  mode: NarrationMode,
): 'assistant.narration.llm' | 'assistant.narration.template' {
  return mode === 'LLM' ? 'assistant.narration.llm' : 'assistant.narration.template';
}

/**
 * Why a fallback happened, in words — or `null` for a reason nobody can act on.
 *
 * `reason` is a diagnostic machine string (docs/06 §8.5: *"diagnostic, not an error"*), so it is mapped
 * by the prefix before the first `:` and never rendered. The producers are `assistant.service.ts`
 * (`AI_UNAVAILABLE:…`, `UNACCOUNTED_NUMERALS:…`), `assistant-narrator.ts` (`EMPTY_NARRATION`, and the
 * router's `${reason}:${failures}`) and the router itself (`CONSENT_DECLINED`, `PROVIDER_UNAVAILABLE`,
 * `CIRCUIT_OPEN`). An unrecognised prefix says nothing beyond {@link narrationKey}: inventing an
 * explanation for a reason this build does not know is how a disclosure becomes fiction.
 */
export function narrationReasonKey(reason: string | null): TranslationKey | null {
  switch (reason?.split(':', 1)[0]) {
    case 'CONSENT_DECLINED':
      return 'assistant.narration.why.consent';
    case 'AI_UNAVAILABLE':
      return 'assistant.narration.why.none';
    case 'PROVIDER_UNAVAILABLE':
    case 'CIRCUIT_OPEN':
      return 'assistant.narration.why.unreachable';
    case 'UNACCOUNTED_NUMERALS':
    case 'EMPTY_NARRATION':
      return 'assistant.narration.why.unaccounted';
    default:
      return null;
  }
}

/**
 * The one visible sentence about the mode: when the fallback was a **decision the reader can change**.
 *
 * Everything else stays in the panel, because a note with no action attached is noise on every answer.
 * Consent is different in kind: the Household withheld it, `/settings` is where it is given back, and a
 * reader who never learns that will conclude the feature does not work.
 */
export function fallbackNoteKey(answer: AssistantAnswer): TranslationKey | null {
  if (!answer.answered || answer.narrationMode !== 'TEMPLATE_FALLBACK') return null;
  return answer.reason?.split(':', 1)[0] === 'CONSENT_DECLINED'
    ? 'assistant.narration.consentNote'
    : null;
}

// ---------------------------------------------------------------------------------------------
// The write path — propose → confirm → execute (B-2b; docs/06 §8.16, ADR-035)
// ---------------------------------------------------------------------------------------------

/** The assistant's closed action set, mirroring the API's `AssistantAction`. */
export const ASSISTANT_ACTIONS = ['ADD_CATEGORY'] as const;
export type AssistantActionName = (typeof ASSISTANT_ACTIONS)[number];

/**
 * The slots a proposal's diff can name, mirroring the API's `AssistantActionSlot`.
 *
 * The client needs this because **a label is not an identifier**: `ActionDiffEntry.field` is rendered
 * in the Household's language (`naziv`/`name`), so the card cannot use it to decide which row a control
 * belongs to. It identifies rows by slot and renders them with the label.
 */
export type ActionSlotName = 'name' | 'kind' | 'parentId';

export interface ActionDiffEntry {
  readonly slot: string;
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
  /** `after` in the machine's own vocabulary (`EXPENSE`/`INCOME` for `kind`), or `null`. */
  readonly afterValue?: string | null;
  readonly defaulted: boolean;
}

/** The backend-rendered proposal: one sentence and a diff. Never narrated (ADR-035 decision 8). */
export interface ActionPreview {
  readonly sentence: string;
  readonly diff: readonly ActionDiffEntry[];
}

/**
 * A proposed write, or the server's refusal to propose one.
 *
 * `proposed: false` is a **refusal, not an error** — the shape `answered: false` established. It is
 * `NOT_AN_ACTION` for a question that asked for nothing the registry does (most questions are reads),
 * and `UNRUNNABLE:<slots>` for an unmistakable request that did not say what to write.
 */
export interface ActionProposal {
  readonly proposed: boolean;
  readonly reason: string | null;
  readonly proposalId: string | null;
  readonly action: string | null;
  readonly preview: ActionPreview | null;
  readonly expiresAt: string | null;
}

/** The written row, and how it can be undone. */
export interface ActionResult {
  readonly action: string;
  readonly createdId: string;
  readonly createdLabel: string;
  readonly undo: string;
  readonly sentence: string;
  readonly replayed: boolean;
}

/** One turn's write state: the proposal, the confirmation, its outcome, and the undo. */
export interface TurnAction {
  /**
   * What the server said, or `null` when the proposal call itself failed.
   *
   * Null is not "not an action": the caller only asks after a refusal, so a failed second call leaves a
   * turn that is exactly what a refusal alone looks like — plus, when there is one, a message saying why
   * the write could not even be offered.
   */
  readonly proposal: ActionProposal | null;
  /**
   * Minted **once per proposal** and reused by every click, which is what makes a retry safe: the
   * server remembers the outcome against it, so a repeated confirm replays the same result instead of
   * writing a second row. A re-propose (the `kind` toggle) is a new proposal and gets a new key.
   */
  readonly idempotencyKey: string;
  readonly result: ActionResult | null;
  readonly confirming: boolean;
  /** True while the `kind` toggle is asking the server for a replaced proposal. */
  readonly switching: boolean;
  readonly undoing: boolean;
  readonly undone: boolean;
  /**
   * True once the server says the proposal is gone — expired, or already consumed.
   *
   * R-29 names exactly this: *"a proposal lapses between render and click"*. The card must stop
   * offering a button that cannot work, which is different from a write that failed for a reason a
   * retry could fix (an unreachable server never reached the proposal at all).
   */
  readonly stale: boolean;
  /** A failure of the **write** — never of the question, which the refusal above already answered. */
  readonly error: string | null;
}

/**
 * A proposal the card may render: proposed, identified, and with something to show.
 *
 * Narrowed rather than merely checked, so the template gets a `preview` it can read without a `?` —
 * the one place a view helper returns a *shape* instead of a boolean, because "may I draw this" and
 * "here is what to draw" are the same question on this card.
 */
export interface RenderableProposal extends ActionProposal {
  readonly proposed: true;
  readonly proposalId: string;
  readonly preview: ActionPreview;
}

export function renderableProposal(
  proposal: ActionProposal | null | undefined,
): RenderableProposal | null {
  if (proposal == null || !proposal.proposed) return null;
  if (proposal.proposalId === null || proposal.preview === null) return null;
  return {
    ...proposal,
    proposed: true,
    proposalId: proposal.proposalId,
    preview: proposal.preview,
  };
}

/**
 * What the card says when the server **declined to propose** — or `null` when it should say nothing.
 *
 * `NOT_AN_ACTION` is the ordinary case and gets no copy: the answer was already a refusal, and telling
 * the reader "that was not an action" adds a sentence about the assistant's internals to every
 * unanswerable question. `UNRUNNABLE` is different: the request *was* unmistakable and the user can
 * complete it, so the card asks for the missing detail instead of leaving them with "I cannot answer".
 */
export function actionRefusalKey(reason: string | null | undefined): TranslationKey | null {
  if (reason == null) return null;
  const [head, detail = ''] = reason.split(':', 2) as [string, string?];
  if (head !== 'UNRUNNABLE') return null;
  return detail.split(',').includes('name')
    ? 'assistant.action.needName'
    : 'assistant.action.notRunnable';
}

/**
 * The rows the diff renders: everything the server says the field will become.
 *
 * A row with no `after` is dropped rather than printed with an em dash. The server always sends three
 * rows so the shape is stable, but "this field is not part of the change" and "this field becomes
 * nothing" are different statements and only the second belongs on a confirmation card.
 */
export function actionDiffRows(preview: ActionPreview | null | undefined): readonly ActionDiffEntry[] {
  return (preview?.diff ?? []).filter((entry) => entry.after !== null);
}

/** One option of a two-way choice, as the card renders it. */
export interface KindChoice {
  readonly current: 'EXPENSE' | 'INCOME';
  readonly other: 'EXPENSE' | 'INCOME';
}

/**
 * The `kind` toggle, or `null` when the card must not offer one.
 *
 * Two conditions, both the server's to state:
 *
 * - the row is **`defaulted`** — the proposal filled it rather than the question stating it. That is
 *   ADR-035 decision 5's flag, and it is what makes "guessing visibly" different from "guessing
 *   silently"; a kind the user asked for is not a suggestion to revise.
 * - the row carries an `afterValue` in the machine's vocabulary. Without it the client would have to
 *   compare the localized word `rashod` against a vocabulary of its own — a second copy of the API's
 *   words, which is the drift this codebase keeps paying for.
 */
export function kindChoice(preview: ActionPreview | null | undefined): KindChoice | null {
  const row = actionDiffRows(preview).find((entry) => entry.slot === 'kind');
  if (row?.defaulted !== true) return null;
  const current = row.afterValue === 'EXPENSE' || row.afterValue === 'INCOME' ? row.afterValue : null;
  if (current === null) return null;
  return { current, other: current === 'EXPENSE' ? 'INCOME' : 'EXPENSE' };
}

/** A plan to undo a completed action: which action, and which row. */
export interface UndoPlan {
  readonly action: AssistantActionName;
  readonly id: string;
}

/**
 * How a completed action can be taken back — or `null` when this client cannot take it back.
 *
 * Two independent gates, and the second is the one that matters. `undo` is the **server's** field
 * (ADR-035 decision 7: an action whose undo does not exist is not offered at all), so an action that
 * cannot be undone never reaches this branch. But a client one release behind a server that added an
 * action would know nothing about taking *that* action back, and `ASSISTANT_ACTIONS` being closed is
 * what makes that a `null` here rather than a mutation call against the wrong row.
 */
export function undoPlan(result: ActionResult): UndoPlan | null {
  if (result.undo !== 'SOFT_DELETE') return null;
  if (!(ASSISTANT_ACTIONS as readonly string[]).includes(result.action)) return null;
  return { action: result.action as AssistantActionName, id: result.createdId };
}

/**
 * When the proposal stops being confirmable, as a local clock time — or `null` if it cannot be read.
 *
 * The API's TTL is ten minutes, and a card that silently stopped working would turn an honest `NOT_FOUND`
 * into a mystery. The value is the server's own `expiresAt`; this only renders it.
 */
export function expiryTime(expiresAt: string | null | undefined, localeTag: string): string | null {
  if (expiresAt == null) return null;
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(localeTag, { hour: '2-digit', minute: '2-digit' }).format(at);
  } catch {
    return null;
  }
}
