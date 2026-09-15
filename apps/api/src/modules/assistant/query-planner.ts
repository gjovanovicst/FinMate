import {
  addDays,
  addMonths,
  monthPeriod,
  weekPeriod,
  type LocalDate,
} from '@finmate/domain';

import { normaliseForMatching } from '../../common/text/normalise';
import {
  INTENT_TEMPLATES,
  SUGGESTED_QUESTIONS,
  type AssistantIntent,
  type IntentTemplate,
  type SlotName,
} from './assistant-intents';

/**
 * The query planner — docs/06 §8.1, ADR-017, docs/09 task 3.2.1.
 *
 * **A question in, a template plus resolved slots out. Never SQL.** The planner's entire output type is
 * modelled below, and `Plan` has no field that can carry a query: the caller looks the intent up in
 * {@link INTENT_TEMPLATES} and calls the named repository method with the slots. That is ADR-017's
 * "constrained intent classifier" made structural rather than aspirational — and it is why this file is
 * pure and tested without a database.
 *
 * ## Slots are resolved against the Household's *own* names
 *
 * `Samoposluga` is not a category in the shipped tree and `Lidl` is a global Merchant row, so the
 * planner cannot carry a keyword list of its own: it matches the question's folded text against the
 * names it was given (the Household's categories, merchants, accounts and tags) through the shared
 * fold. A second vocabulary here would drift from the tree the user actually has.
 *
 * ## What the planner deliberately does not do
 *
 * It does not decide whether the answer is *true*, does not fetch anything, and does not narrate. It
 * also refuses rather than improvising: anything without a template returns `NO_TEMPLATE_MATCH` with
 * suggestions, which is ADR-017's stated product limitation — *"questions outside the template set are
 * refused rather than improvised, and it must be messaged well"*.
 *
 * @module apps/api/src/modules/assistant
 */

/** A named entity the planner may resolve a slot to. */
export interface NamedEntity {
  readonly id: string;
  readonly name: string;
  /** A category's full breadcrumb (`Hrana / Supermarket`), when it has one. */
  readonly path?: string;
  /**
   * Whether the row belongs to this Household rather than being a shared/global one.
   *
   * `merchants` are globally readable with a nullable `household_id` (docs/08's global allow-list), so
   * a Household that copied the seeded `Lidl` has **two** rows named `Lidl` in its context — and its
   * Transactions point at its own copy. Without this flag the tie falls to the id, which picks
   * whichever row happens to be older: usually the global seed, whose id is on no Transaction at all,
   * so "koliko sam potrošio u lidlu" answered `0,00 RSD`. A fact assembled from a row the ledger does
   * not reference is exactly the kind of confidently-empty answer ADR-017 exists to prevent.
   */
  readonly owned?: boolean;
}

export interface PlannerContext {
  /** The Household's local day. The planner never reads a clock (docs/03 §3.2). */
  readonly today: LocalDate;
  readonly categories: readonly NamedEntity[];
  readonly merchants: readonly NamedEntity[];
  readonly accounts: readonly NamedEntity[];
  readonly tags: readonly NamedEntity[];
}

export interface ResolvedPeriod {
  readonly start: LocalDate;
  readonly end: LocalDate;
  /** Which phrase produced it — the provenance the UI shows and the tests assert. */
  readonly matchedOn: string;
}

export interface ResolvedSlots {
  readonly period: ResolvedPeriod;
  readonly categoryId?: string;
  readonly merchantId?: string;
  readonly accountId?: string;
  readonly tagId?: string;
  readonly goalId?: string;
  readonly recurringRuleId?: string;
  readonly limit?: number;
}

export interface Plan {
  readonly intent: AssistantIntent;
  readonly template: IntentTemplate;
  readonly slots: ResolvedSlots;
  /**
   * The phrases the decision rests on — the words that set the period and any entity.
   *
   * Provenance, not decoration: docs/06 §8.3 requires every answer to be checkable, and "why did it
   * think I meant Hrana?" is the first question a wrong answer raises.
   */
  readonly matchedOn: readonly string[];
  /** Present only for `NO_TEMPLATE_MATCH` (docs/06 §8.4). */
  readonly suggestions?: readonly string[];
}

/**
 * Serbian month **stems**, in calendar order.
 *
 * A stem rather than a name, because the inflected form is not a suffix of the nominative:
 * `septembar` → `septembru` loses the `a`, so `\bseptembar[a-z]{0,2}\b` matches neither `septembru`
 * nor `septembra`. Matching `\bseptemb[a-z]{0,3}\b` covers all three.
 *
 * ⚠️ The cost is that a name beginning with a month stem matches too — a merchant called `Martin`
 * reads as March. It is bounded: month resolution only runs when no explicit period phrase was found,
 * and the period slot is provenance the user can see (`matchedOn`), so a wrong guess is visible rather
 * than silent.
 */
const MONTH_STEMS: readonly string[] = [
  'januar',
  'februar',
  'mart',
  'april',
  'maj',
  'jun',
  'jul',
  'avgust',
  'septemb',
  'oktob',
  'novemb',
  'decemb',
];

const DEFAULT_PERIOD_PHRASE = 'ovog meseca';
/** How many rows a "top N" or list question returns when the user does not say. */
export const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * Plan one question.
 *
 * The order of the rules matters and is deliberate: the most specific phrase wins (`prošlog meseca` is
 * a period *and* a trend cue, and `koliko sam potrošio na hranu` is a category question rather than a
 * total), and the kind is resolved **before** the shape so an income question can never be answered by
 * an expense aggregate.
 */
export function planQuestion(question: string, context: PlannerContext): Plan {
  const folded = normaliseForMatching(question);
  const period = resolvePeriod(folded, context.today);
  const matchedOn: string[] = [period.matchedOn];

  const category = matchEntity(folded, context.categories, (entity) => [entity.name, ...(entity.path === undefined ? [] : [entity.path])]);
  const merchant = matchEntity(folded, context.merchants, (entity) => [entity.name]);
  const account = matchEntity(folded, context.accounts, (entity) => [entity.name]);
  const tag = matchEntity(folded, context.tags, (entity) => [entity.name]);
  for (const [label, entity] of [
    ['category', category],
    ['merchant', merchant],
    ['account', account],
    ['tag', tag],
  ] as const) {
    if (entity !== null) matchedOn.push(`${label}:${entity.name}`);
  }

  const limit = resolveLimit(folded);
  if (limit !== null) matchedOn.push(`limit:${limit}`);

  const intent = resolveIntent(folded, {
    hasCategory: category !== null,
    hasMerchant: merchant !== null,
    hasAccount: account !== null,
    hasTag: tag !== null,
    period,
    matchedOn,
  });

  // A trend question names the **baseline**, not the period to report.
  //
  // "Kako stojim u odnosu na prošli mesec?" asked in September compares September with August; reading
  // `prošli mesec` as the period makes it compare August with July, which is a true answer to a
  // different question. The phrase table cannot tell the two apart — "koliko sam potrošio prošlog
  // meseca" *does* mean August — so the adjustment happens here, after routing, and `matchedOn` says
  // which role the phrase played.
  const baselineIsPreviousMonth =
    intent === 'TREND_VS_LAST_MONTH' && period.matchedOn === 'prošlog meseca';
  const effectivePeriod: ResolvedPeriod = baselineIsPreviousMonth
    ? { ...monthPeriod(context.today), matchedOn: DEFAULT_PERIOD_PHRASE }
    : period;
  if (baselineIsPreviousMonth) {
    matchedOn[0] = `period:${effectivePeriod.matchedOn}`;
    matchedOn.push(`baseline:${period.matchedOn}`);
  }

  const slots: ResolvedSlots = {
    period: effectivePeriod,
    ...(category !== null ? { categoryId: category.id } : {}),
    ...(merchant !== null ? { merchantId: merchant.id } : {}),
    ...(account !== null ? { accountId: account.id } : {}),
    ...(tag !== null ? { tagId: tag.id } : {}),
    ...(limit !== null ? { limit } : {}),
  };

  return {
    intent,
    template: INTENT_TEMPLATES[intent],
    slots,
    matchedOn,
    ...(intent === 'NO_TEMPLATE_MATCH'
      ? { suggestions: SUGGESTED_QUESTIONS.map((entry) => entry.question) }
      : {}),
  };
}

/**
 * Whether the plan is runnable: every required slot resolved.
 *
 * A separate question from "did a template match", because `SPEND_BY_CATEGORY` without a resolvable
 * category is a **near miss** — the user asked something answerable, just not about a category the
 * Household has. The caller turns that into `NO_TEMPLATE_MATCH` with suggestions rather than running an
 * aggregate over everything and mislabelling it.
 */
export function isRunnable(plan: Plan): boolean {
  if (plan.intent === 'NO_TEMPLATE_MATCH') return false;
  return plan.template.requiredSlots.every((slot) => hasSlot(plan.slots, slot));
}

/** The missing required slots, for the refusal message. */
export function missingSlots(plan: Plan): readonly SlotName[] {
  return plan.template.requiredSlots.filter((slot) => !hasSlot(plan.slots, slot));
}

function hasSlot(slots: ResolvedSlots, slot: SlotName): boolean {
  switch (slot) {
    case 'period':
      return true;
    case 'categoryId':
      return slots.categoryId !== undefined;
    case 'merchantId':
      return slots.merchantId !== undefined;
    case 'accountId':
      return slots.accountId !== undefined;
    case 'tagId':
      return slots.tagId !== undefined;
    case 'limit':
      return slots.limit !== undefined;
    case 'goalId':
      return slots.goalId !== undefined;
    case 'recurringRuleId':
      return slots.recurringRuleId !== undefined;
  }
}

/**
 * Resolve the period phrase, in the order a reader would read the question.
 *
 * A named month resolves to the **most recent** one: asking "koliko sam potrošio u avgustu" in March
 * means last August, and answering with the August that has not happened yet would be a figure the user
 * cannot reconcile with anything.
 */
export function resolvePeriod(folded: string, today: LocalDate): ResolvedPeriod {
  if (/\bdanas\b/.test(folded)) return { start: today, end: today, matchedOn: 'danas' };
  if (/\bjuce\b|\bjucer\b/.test(folded)) {
    const yesterday = addDays(today, -1);
    return { start: yesterday, end: yesterday, matchedOn: 'juče' };
  }
  if (/\bove nedelje\b|\bova nedelja\b/.test(folded)) {
    const week = weekPeriod(today);
    return { ...week, matchedOn: 'ove nedelje' };
  }
  if (/\bprosle nedelje\b|\bprosla nedelja\b/.test(folded)) {
    const week = weekPeriod(addDays(weekPeriod(today).start, -1));
    return { ...week, matchedOn: 'prošle nedelje' };
  }
  if (/\bproslog meseca\b|\bprosli mesec\b/.test(folded)) {
    const month = monthPeriod(addMonths(today, -1));
    return { start: month.start, end: month.end, matchedOn: 'prošlog meseca' };
  }
  if (/\bove godine\b|\bova godina\b/.test(folded)) {
    return { start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31`, matchedOn: 'ove godine' };
  }
  if (/\bprosle godine\b|\bprosla godina\b/.test(folded)) {
    const year = Number(today.slice(0, 4)) - 1;
    return { start: `${year}-01-01`, end: `${year}-12-31`, matchedOn: 'prošle godine' };
  }

  // "poslednjih 30 dana" / "zadnjih 7 dana"
  const window = /\b(?:poslednjih|zadnjih|proteklih)\s+(\d{1,3})\s+dana\b/.exec(folded);
  if (window !== null) {
    const days = Math.min(Math.max(Number(window[1]), 1), 366);
    return { start: addDays(today, -(days - 1)), end: today, matchedOn: `poslednjih ${days} dana` };
  }

  // A named month, most recent occurrence first. The trailing `[a-z]{0,2}` carries the case ending:
  // people type "u avgustu" and "u septembru", and `\bavgust\b` does not match either.
  for (const [index, stem] of MONTH_STEMS.entries()) {
    const hit = new RegExp(`\\b${stem}[a-z]{0,3}\\b`).exec(folded);
    if (hit === null) continue;
    const monthNumber = index + 1;
    const pad = String(monthNumber).padStart(2, '0');
    const thisYear = `${today.slice(0, 4)}-${pad}-01`;
    const anchor = thisYear > today ? `${Number(today.slice(0, 4)) - 1}-${pad}-01` : thisYear;
    const month = monthPeriod(anchor);
    // The **word as typed** (`avgustu`, `septembru`), not the table entry: provenance is for the user,
    // and the question they will re-read is the one they wrote.
    return { start: month.start, end: month.end, matchedOn: hit[0] };
  }

  const month = monthPeriod(today);
  return { start: month.start, end: month.end, matchedOn: DEFAULT_PERIOD_PHRASE };
}

interface IntentCues {
  readonly hasCategory: boolean;
  readonly hasMerchant: boolean;
  readonly hasAccount: boolean;
  readonly hasTag: boolean;
  readonly period: ResolvedPeriod;
  readonly matchedOn: string[];
}

/**
 * Pick the template.
 *
 * Written as an ordered list of `[intent, test]` pairs rather than a nested `if` tree so the precedence
 * is readable in one screen — the rule that fired is also appended to `matchedOn`, which is how a
 * misrouted question is diagnosed from the audit rather than by re-reading this function.
 */
function resolveIntent(folded: string, cues: IntentCues): AssistantIntent {
  const has = (...phrases: string[]): boolean => phrases.some((phrase) => folded.includes(phrase));
  const note = (intent: AssistantIntent, phrase: string): AssistantIntent => {
    cues.matchedOn.push(`intent:${phrase}`);
    return intent;
  };

  // ---- budgets & pace (before spending: "koliko mi je ostalo od budžeta" contains "koliko")
  if (has('budzet') || has('budžet')) {
    if (has('tempo', 'preko plana', 'isplanirano', 'odstupa')) {
      return note('BUDGET_PACE_VS_PLAN', 'budžet + tempo');
    }
    // "which budgets exist" is a list question; "how much is left of the budget" is a status one.
    if (has('koji budzet', 'koji budžet', 'koje budzete', 'koje budžete', 'svi budzeti', 'svi budžeti', 'lista budzeta', 'lista budžeta', 'spisak budzeta', 'spisak budžeta')) {
      return note('BUDGET_LIST', 'lista budžeta');
    }
    return note('BUDGET_STATUS', 'budžet');
  }
  if (has('mogu da potrosim', 'mogu da potrošim', 'mogu li da potrosim', 'mogu li da potrošim')) {
    return note('SAFE_TO_SPEND', 'mogu da potrošim');
  }
  if (has('projekcija', 'kraj meseca', 'do kraja meseca')) {
    return note('MONTH_PROJECTION', 'projekcija');
  }

  // ---- goals & recurring
  if (has('kako da ustekam', 'kako da uštedim', 'kako da ustedim', 'predlog za stednju', 'predlog za štednju')) {
    return note('SAVINGS_PROPOSAL', 'kako da uštedim');
  }
  if (has('cilj', 'cilju', 'stednja', 'štednja', 'stek', 'štek')) {
    if (has('mesecno', 'mesečno', 'koliko mesecno', 'koliko mesečno')) {
      return note('GOAL_REQUIRED_MONTHLY', 'cilj + mesečno');
    }
    return note('GOAL_PROGRESS', 'cilj');
  }
  // "what gets charged soon" is a recurring question even without the word *pretplata*: the cue is the
  // charge plus imminence, and requiring the noun would refuse a question the ledger can answer.
  const imminent = has('uskoro', 'dolazec', 'dolazeć', 'sledece', 'sledeće', 'ovog meseca', 'ovih dana');
  // `placa`/`plaća` rather than the phrase "placa se": people write "šta mi se plaća uskoro" and the
  // verb and its clitic are in the other order. The word also means *salary*, but the income templates
  // cue on `zaradio`/`prihod`/`plata`, so the two do not collide.
  const charge = has('placa', 'plaća', 'naplat', 'racun', 'račun', 'trosak', 'trošak');
  if (has('pretplat', 'ponavljajuc', 'ponavljajuć', 'rekurentn') || (imminent && charge)) {
    if (imminent) {
      return note('RECURRING_UPCOMING', 'pretplate + uskoro');
    }
    return note('RECURRING_LIST', 'pretplate');
  }

  // ---- income & flow
  if (has('neto', 'na neto', 'koliko mi ostaje', 'koliko mi je ostalo od prihoda', 'cashflow')) {
    return note('NET_CASHFLOW', 'neto');
  }
  if (has('zaradio', 'zaradila', 'prihod', 'prihodi', 'primitak')) {
    return note('INCOME_TOTAL', 'prihod');
  }
  if (has('stanje na racunu', 'stanje na računu', 'stanje racuna', 'stanje računa', 'na racunu imam', 'na računu imam')) {
    return cues.hasAccount ? note('ACCOUNT_BALANCE', 'stanje + račun') : note('ACCOUNT_BALANCE_ALL', 'stanje');
  }

  // ---- comparison & trend (a trend cue beats a plain spend question, because the comparison is the
  // question: "kako stojim u odnosu na prošli mesec" is not "how much did I spend")
  if (has('u odnosu na prosli mesec', 'u odnosu na prošli mesec', 'nego proslog meseca', 'nego prošlog meseca', 'poredenju sa proslim', 'poređenju sa prošlim')) {
    return note('TREND_VS_LAST_MONTH', 'odnos prema prošlom mesecu');
  }
  if (has('uporedi', 'uporedimo', 'poredjenje', 'poređenje', 'uporedjenje', 'upoređenje')) {
    return note('COMPARE_PERIODS', 'uporedi');
  }
  // Deliberately *not* a bare "prosek": "prosečno dnevno" is a different template, and the spending
  // block below would never be reached if a bare stem stole it.
  if (has('odnosu na prosek', 'odstupa od proseka', 'odstupam', 'uobicajeno', 'uobičajeno')) {
    return note('TREND_VS_AVERAGE', 'u odnosu na prosek');
  }

  // ---- spending
  if (has('najvise', 'najviše', 'gde mi odlazi', 'gde odlazi')) {
    if (has('prodavac', 'prodavca', 'prodavci', 'merchant', 'radnj')) {
      return note('TOP_MERCHANTS', 'najviše + prodavci');
    }
    return note('TOP_CATEGORIES', 'najviše');
  }
  if (has('najvece transakcije', 'najveće transakcije', 'najveci iznos', 'najveći iznos', 'najveca kupovina', 'najveća kupovina')) {
    return note('LARGEST_TRANSACTIONS', 'najveće transakcije');
  }
  if (has('prosecno dnevno', 'prosečno dnevno', 'dnevni prosek', 'po danu')) {
    return note('AVERAGE_DAILY_SPEND', 'prosečno dnevno');
  }
  if (has('koliko transakcija', 'broj transakcija', 'koliko kupovina', 'koliko unosa')) {
    return note('TRANSACTION_COUNT', 'broj transakcija');
  }
  if (has('za proveru', 'neprepoznat', 'bez kategorije', 'nekategorisan', 'cekaju proveru', 'čekaju proveru')) {
    return note('UNCATEGORISED_REVIEW', 'za proveru');
  }
  if (has('prikazi transakcije', 'lista transakcija', 'spisak transakcija', 'koje transakcije')) {
    return note('TRANSACTION_LIST', 'lista transakcija');
  }
  if (has('potrosio', 'potrošio', 'potrosila', 'potrošila', 'trosio', 'trošio', 'kupio', 'kupila', 'platio', 'platila', 'rashod')) {
    if (cues.hasCategory) return note('SPEND_BY_CATEGORY', 'potrošio + kategorija');
    if (cues.hasMerchant) return note('SPEND_BY_MERCHANT', 'potrošio + prodavac');
    if (cues.hasAccount) return note('SPEND_BY_ACCOUNT', 'potrošio + račun');
    if (cues.hasTag) return note('SPEND_BY_TAG', 'potrošio + oznaka');
    // "na hranu", "za gorivo", "u lidlu" — the question is **scoped** to something, and if that
    // something is not a name this Household has, answering the unscoped total would answer a
    // different question under the one that was asked. Refusing is the honest outcome (ADR-017).
    if (hasUnresolvedScope(folded, cues.period)) return note('NO_TEMPLATE_MATCH', 'nerazrešen opseg');
    return note('SPEND_TOTAL', 'potrošio');
  }

  return 'NO_TEMPLATE_MATCH';
}

/**
 * The longest folded name the question refers to.
 *
 * ## Why a substring test is not enough: Serbian inflects
 *
 * `Hrana` is the category; people type *"koliko sam potrošio na **hranu**"*. Word-for-word matching
 * finds nothing, and the question then falls through to `SPEND_TOTAL` — a **wrong answer to a question
 * the template set can answer**, which is worse than a refusal because nothing about it looks wrong.
 * The same holds for `Gorivo`/`goriva`, `Tekući`/`tekućeg`, `Lidl`/`lidlu`.
 *
 * So a name also matches when it shares a **stem** with a word in the question: a common prefix of at
 * least four characters, allowing the last two characters to differ (Serbian case endings are one or
 * two: `-a`, `-u`, `-e`, `-i`, `-om`, `-eg`). The four-character floor is what keeps short unrelated
 * words apart — `keš` and `keks` share two characters and must not match — and a match found this way
 * scores below an exact substring, so an exact hit always wins.
 *
 * ## Longest wins, because the specific answer is the one that was meant
 *
 * `Hrana / Supermarket` beats `Hrana` when both are present, and picking the parent would silently
 * widen the aggregate the user asked for. Ties (including two identically named entities) fall back to
 * the id, so resolution is deterministic rather than dependent on row order.
 */
function matchEntity(
  folded: string,
  entities: readonly NamedEntity[],
  namesOf: (entity: NamedEntity) => readonly string[],
): NamedEntity | null {
  const words = folded.split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
  const candidates: { entity: NamedEntity; score: number }[] = [];

  for (const entity of entities) {
    for (const name of namesOf(entity)) {
      const foldedName = normaliseForMatching(name);
      if (foldedName.length < 2) continue;

      if (folded.includes(foldedName)) {
        // An exact occurrence: the strongest evidence, scored by how much of the question it covers.
        candidates.push({ entity, score: foldedName.length + 100 });
        continue;
      }

      const stem = longestSharedStem(foldedName, words);
      if (stem !== null) candidates.push({ entity, score: stem });
    }
  }

  // Highest score wins; then the Household's **own** row over a shared one (see {@link NamedEntity.owned});
  // then the id, so two identically named entities resolve deterministically rather than by row order.
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      Number(right.entity.owned ?? false) - Number(left.entity.owned ?? false) ||
      (left.entity.id < right.entity.id ? -1 : 1),
  );
  return candidates[0]?.entity ?? null;
}

/** The longest word of `name` whose stem appears among `words`, or `null`. */
function longestSharedStem(name: string, words: readonly string[]): number | null {
  let best: number | null = null;
  for (const part of name.split(/[^a-z0-9]+/)) {
    if (part.length < 4) continue;
    for (const word of words) {
      if (!sharesStem(part, word)) continue;
      if (best === null || part.length > best) best = part.length;
    }
  }
  return best;
}

/**
 * A three-character floor, with the last two characters free — Serbian case endings.
 *
 * Three rather than four because `kafa`/`kafu` and `voda`/`vodi` differ in the last of only four
 * characters; the floor plus "at most two may differ" is what keeps unrelated words apart, and the
 * caller only considers name parts of four characters or more, so a three-letter name (`Keš`) must be
 * typed exactly.
 */
function sharesStem(name: string, word: string): boolean {
  if (name.length < 4 || word.length < 4) return false;
  const shortest = Math.min(name.length, word.length);
  let common = 0;
  while (common < shortest && name[common] === word[common]) common += 1;
  return common >= 3 && common >= shortest - 2;
}

/**
 * Whether a spend question names a scope the planner could not resolve.
 *
 * Deliberately narrow: only the prepositions that introduce a scope (`na`, `za`, `u`, `kod`) followed by
 * a word of four or more characters that the period did not already consume. `koliko sam potrošio na
 * more` refuses; `koliko sam potrošio ovog meseca` does not, and neither does `koliko sam potrošio u
 * avgustu` — a month the phrase table resolved *is* a resolved scope, and reading it as an unresolved
 * entity refused a question the templates can answer.
 */
const SCOPE_WORDS = new Set([
  'ovog', 'ovog', 'proslog', 'prošlog', 'ove', 'prosle', 'prošle', 'poslednjih', 'zadnjih', 'proteklih',
  'meseca', 'mesec', 'nedelje', 'godine', 'dana', 'danas', 'juce', 'juče', 'sve', 'svih', 'kartici',
  'racuna', 'računa', 'gotovinu', 'gotovine', 'prosek', 'proseka', 'ukupno',
]);

function hasUnresolvedScope(folded: string, period: ResolvedPeriod): boolean {
  // The words the period phrase used are resolved by definition. A named month is the case that needs
  // this: `resolvePeriod` returns the word **as typed** (`avgustu`), which is what the question says.
  const allowed = new Set(SCOPE_WORDS);
  for (const word of normaliseForMatching(period.matchedOn).split(/[^a-z0-9]+/)) {
    if (word.length > 0) allowed.add(word);
  }

  for (const match of folded.matchAll(/\b(?:na|za|u|kod)\s+([a-z]{4,})/g)) {
    if (!allowed.has(match[1] ?? '')) return true;
  }
  return false;
}

/** `top 5`, `5 najvećih`, `poslednjih 5` — or `null` for the template's default. */
function resolveLimit(folded: string): number | null {
  const match = /\b(?:top|najvecih|najvećih|poslednjih|zadnjih)\s+(\d{1,2})\b/.exec(folded);
  if (match === null) return null;
  return Math.min(Math.max(Number(match[1]), 1), MAX_LIMIT);
}
