/**
 * The template answer — docs/06 §8.5's `TEMPLATE_FALLBACK`, docs/04 §10's "template-rendered answer
 * with no LLM at all".
 *
 * ## Why this exists at all
 *
 * Two paths reach it, and neither is an error:
 *
 * 1. **No provider is configured** (the state of this build, and the state of any household whose
 *    provider is unreachable). The facts are already computed, so refusing to answer because a model
 *    is down would be a self-inflicted outage.
 * 2. **The model narrated a number the payload does not contain.** docs/06 §8.5 regenerates once
 *    with a stricter instruction and then renders deterministically — the user still gets the correct
 *    answer, and the UI is expected to make the fallback invisible.
 *
 * ## The rule this file obeys
 *
 * It **cannot** invent a numeral: every figure it prints is read from `facts.formatted`,
 * `facts.rows[].formatted` or `facts.totals[].formatted`, and the provenance it prints is the count
 * and the range the payload already carries. A unit test runs `validateNarration` over the rendered
 * answer for every intent, so that is an assertion rather than an intention.
 *
 * ## It is written in the reader's language
 *
 * The connective copy used to be English-only, while the assistant's card copy was bilingual — so a
 * Serbian reader got an English sentence above a Serbian table (ADR-040). Each frame is now a copy
 * pair rendered through {@link tr}, and the numerals are interpolated **after** transliteration so an
 * amount or a Household name is never rewritten into another script.
 *
 * @module apps/api/src/modules/assistant
 */

import { tr, type CopyLocale } from '../../common/i18n/copy';
import { FACT_LABELS } from '../../common/i18n/fact-labels';
import type { AssistantIntent, IntentTemplate } from './assistant-intents';
import type { AssistantFactsView, ProvenanceView } from './fact-assembly.service';

export interface TemplateAnswerInput {
  readonly intent: AssistantIntent;
  readonly template: IntentTemplate;
  readonly facts: AssistantFactsView;
  readonly provenance: ProvenanceView;
  /** Defaults to English, the product's primary language. */
  readonly locale?: CopyLocale;
}

/**
 * Which sentence an intent's fallback uses.
 *
 * A `Record<AssistantIntent, Frame>` rather than a `switch` with a default arm: adding an intent then
 * fails `tsc` until somebody decides how it reads, which is the same reason the intent registry and
 * the builder registry are records. The arm names the **shape of the sentence**, not the intent, so
 * the prose lives in a handful of renderers instead of twenty-nine.
 */
type Frame =
  | 'TOTAL_AMOUNT'
  | 'AVERAGE'
  | 'COUNT'
  | 'NET'
  | 'STATE'
  | 'BUDGET'
  | 'SAFE'
  | 'PROJECTION'
  | 'ROWS'
  | 'LIST'
  | 'TREND_PREVIOUS'
  | 'TREND_AVERAGE'
  | 'PROPOSAL'
  | 'GOAL'
  | 'GOAL_MONTHLY'
  | 'SCHEDULE'
  | 'DUE'
  | 'REFUSAL';

const FRAMES: Readonly<Record<AssistantIntent, Frame>> = {
  SPEND_TOTAL: 'TOTAL_AMOUNT',
  SPEND_BY_CATEGORY: 'TOTAL_AMOUNT',
  SPEND_BY_MERCHANT: 'TOTAL_AMOUNT',
  SPEND_BY_ACCOUNT: 'TOTAL_AMOUNT',
  SPEND_BY_TAG: 'TOTAL_AMOUNT',
  TOP_CATEGORIES: 'ROWS',
  TOP_MERCHANTS: 'ROWS',
  LARGEST_TRANSACTIONS: 'LIST',
  AVERAGE_DAILY_SPEND: 'AVERAGE',
  TRANSACTION_COUNT: 'COUNT',
  TRANSACTION_LIST: 'LIST',
  UNCATEGORISED_REVIEW: 'LIST',
  INCOME_TOTAL: 'TOTAL_AMOUNT',
  INCOME_BY_CATEGORY: 'TOTAL_AMOUNT',
  NET_CASHFLOW: 'NET',
  ACCOUNT_BALANCE: 'STATE',
  ACCOUNT_BALANCE_ALL: 'STATE',
  BUDGET_STATUS: 'BUDGET',
  BUDGET_LIST: 'ROWS',
  SAFE_TO_SPEND: 'SAFE',
  MONTH_PROJECTION: 'PROJECTION',
  BUDGET_PACE_VS_PLAN: 'ROWS',
  TREND_VS_LAST_MONTH: 'TREND_PREVIOUS',
  COMPARE_PERIODS: 'REFUSAL',
  TREND_VS_AVERAGE: 'TREND_AVERAGE',
  GOAL_PROGRESS: 'GOAL',
  GOAL_REQUIRED_MONTHLY: 'GOAL_MONTHLY',
  SAVINGS_PROPOSAL: 'PROPOSAL',
  RECURRING_UPCOMING: 'DUE',
  RECURRING_LIST: 'SCHEDULE',
  NO_TEMPLATE_MATCH: 'REFUSAL',
};

/** How many rows a fallback sentence names before it stops reading them out. */
const MAX_NAMED_ROWS = 3;

/** The conjunction between named rows: `A, then B` / `A, zatim B`. */
const THEN = { en: ', then ', sr: ', zatim ' };

/**
 * Render the deterministic answer for an assembled plan.
 *
 * Unavailable templates are not rendered here at all — the service returns {@link renderRefusal}
 * for those, because an answer with no facts must carry no figure.
 */
export function renderTemplateAnswer(input: TemplateAnswerInput): string {
  const { facts, provenance, template } = input;
  const locale: CopyLocale = input.locale ?? 'en';
  const frame = FRAMES[input.intent];
  const headline = facts.formatted['headline'] ?? '';
  const at =
    facts.totals.find((total) => total.label === tr(locale, FACT_LABELS.thisPeriod))?.formatted ??
    headline;

  switch (frame) {
    case 'TOTAL_AMOUNT': {
      // The scope the question named, when the builder could phrase it (docs/06 §8.2). Without it a
      // scoped answer reads "You spent 4.000,00 RSD." — a true figure answering a question nobody can
      // check against the one that was asked (docs/15). The phrase is already in the reader's language.
      const scope = facts.formatted['scope'];
      const of = scope === undefined || scope === '' ? '' : ` ${scope}`;
      return template.kind === 'INCOME'
        ? tr(locale, { en: 'You received {headline}{of}.', sr: 'Primio si {headline}{of}.' }, { headline, of })
        : tr(locale, { en: 'You spent {headline}{of}.', sr: 'Potrošio si {headline}{of}.' }, { headline, of });
    }

    case 'AVERAGE': {
      const days = facts.formatted['days'];
      const total = facts.formatted['total'];
      if (days === undefined) {
        return tr(
          locale,
          { en: 'You spent {headline} a day on average.', sr: 'Potrošio si {headline} dnevno u proseku.' },
          { headline },
        );
      }
      return total === undefined
        ? tr(
            locale,
            {
              en: 'You spent {headline} a day on average over {days} days.',
              sr: 'Potrošio si {headline} dnevno u proseku tokom {days} dana.',
            },
            { headline, days },
          )
        : tr(
            locale,
            {
              en: 'You spent {headline} a day on average over {days} days, {total} in total.',
              sr: 'Potrošio si {headline} dnevno u proseku tokom {days} dana, ukupno {total}.',
            },
            { headline, days, total },
          );
    }

    case 'COUNT':
      return provenance.transactionCount === 1
        ? tr(locale, { en: 'You have 1 transaction in that period.', sr: 'Imaš 1 transakciju u tom periodu.' })
        : tr(
            locale,
            { en: 'You have {headline} transactions in that period.', sr: 'Imaš {headline} transakcija u tom periodu.' },
            { headline },
          );

    case 'NET':
      return tr(
        locale,
        {
          en: 'Income {income}, spending {spending}, net {headline}.',
          sr: 'Prihod {income}, trošak {spending}, neto {headline}.',
        },
        {
          income: facts.formatted['income'] ?? '',
          spending: facts.formatted['spending'] ?? '',
          headline,
        },
      );

    case 'STATE': {
      const asOf = facts.formatted['asOf'];
      const named = namedRows(facts);
      const subject =
        named.length === 0
          ? tr(locale, { en: 'Your balance', sr: 'Stanje' })
          : tr(
              locale,
              { en: 'Your balance on {name}', sr: 'Stanje na računu „{name}“' },
              { name: named[0]?.label ?? '' },
            );
      return asOf === undefined
        ? tr(locale, { en: '{subject} is {headline}.', sr: '{subject} je {headline}.' }, { subject, headline })
        : tr(
            locale,
            { en: '{subject} is {headline}, as of {asOf}.', sr: '{subject} je {headline}, na dan {asOf}.' },
            { subject, headline, asOf },
          );
    }

    case 'BUDGET': {
      const limit = facts.formatted['limit'];
      const spent = facts.formatted['spent'];
      if (limit === '' || limit === undefined) {
        return spent === undefined
          ? tr(
              locale,
              { en: 'You have {headline} left of that budget.', sr: 'Ostalo ti je {headline} od tog budžeta.' },
              { headline },
            )
          : tr(
              locale,
              {
                en: 'You have {headline} left of that budget after {spent}.',
                sr: 'Ostalo ti je {headline} od tog budžeta nakon {spent}.',
              },
              { headline, spent },
            );
      }
      return spent === undefined
        ? tr(
            locale,
            { en: 'You have {headline} left of {limit}.', sr: 'Ostalo ti je {headline} od {limit}.' },
            { headline, limit },
          )
        : tr(
            locale,
            {
              en: 'You have {headline} left of {limit}, with {spent} spent.',
              sr: 'Ostalo ti je {headline} od {limit}, a potrošeno je {spent}.',
            },
            { headline, limit, spent },
          );
    }

    case 'SAFE': {
      const spent = facts.formatted['spent'];
      return spent === undefined
        ? tr(
            locale,
            { en: 'You can spend {headline} safely today.', sr: 'Danas možeš bezbedno da potrošiš {headline}.' },
            { headline },
          )
        : tr(
            locale,
            {
              en: 'You can spend {headline} safely today; {spent} is spent this month.',
              sr: 'Danas možeš bezbedno da potrošiš {headline}; ovog meseca je potrošeno {spent}.',
            },
            { headline, spent },
          );
    }

    case 'PROJECTION': {
      const overrun = facts.totals.find(
        (total) => total.label === tr(locale, FACT_LABELS.projectedOverrun),
      )?.formatted;
      const reliable = facts.formatted['reliable'] === 'true';
      const caveat = reliable
        ? ''
        : tr(locale, {
            en: ' The month is early, so this is a rough figure.',
            sr: ' Mesec je tek počeo, pa je ovo gruba procena.',
          });
      return overrun === undefined
        ? tr(
            locale,
            { en: 'You are on track for {headline} this month.{caveat}', sr: 'Ovog meseca si na putu ka {headline}.{caveat}' },
            { headline, caveat },
          )
        : tr(
            locale,
            {
              en: 'You are on track for {headline} this month, over by {overrun}.{caveat}',
              sr: 'Ovog meseca si na putu ka {headline}, u prekoračenju za {overrun}.{caveat}',
            },
            { headline, overrun, caveat },
          );
    }

    case 'ROWS': {
      const named = namedRows(facts);
      // No rows means nothing to rank — and printing the zero headline the builder left behind
      // ("Nothing to report there (0,00 RSD)") is a figure the answer does not need. The sentence
      // carries no numeral at all, which is also the most honest thing a ranked list can say.
      if (named.length === 0) {
        return tr(locale, {
          en: 'Nothing stands out in that period.',
          sr: 'Ništa se ne ističe u tom periodu.',
        });
      }
      return `${named.map((row) => `${row.label} ${row.formatted}`).join(tr(locale, THEN))}.`;
    }

    case 'LIST': {
      const named = namedRows(facts);
      const count = provenance.transactionCount;
      const lead =
        count === 1
          ? tr(locale, { en: '1 transaction', sr: '1 transakcija' })
          : tr(locale, { en: '{headline} transactions', sr: '{headline} transakcija' }, { headline });
      return named.length === 0
        ? tr(locale, { en: 'Nothing matched ({lead}).', sr: 'Ništa nije pronađeno ({lead}).' }, { lead })
        : `${lead}: ${named.map((row) => `${row.label} ${row.formatted}`).join(tr(locale, THEN))}.`;
    }

    case 'TREND_PREVIOUS': {
      const previous = facts.formatted['previous'];
      return previous === undefined
        ? tr(locale, { en: 'This period {at}.', sr: 'Ovaj period {at}.' }, { at })
        : tr(
            locale,
            {
              en: 'This period {at}, against {previous} in the previous period — a change of {headline}.',
              sr: 'Ovaj period {at}, u odnosu na {previous} u prethodnom periodu — promena {headline}.',
            },
            { at, previous, headline },
          );
    }

    case 'TREND_AVERAGE': {
      const average = facts.formatted['average'];
      return average === undefined
        ? tr(locale, { en: 'This period {at}.', sr: 'Ovaj period {at}.' }, { at })
        : tr(
            locale,
            {
              en: 'This period {at}, against a usual {average} — a difference of {headline}.',
              sr: 'Ovaj period {at}, u odnosu na uobičajenih {average} — razlika {headline}.',
            },
            { at, average, headline },
          );
    }

    case 'GOAL': {
      // F-18. Contributed / target / the percentage, all from `formatted`, and the percentage comes
      // from the domain calculator rather than being divided here.
      const goal = facts.formatted['goal'];
      const target = facts.formatted['target'] ?? '';
      const remaining = facts.formatted['remaining'];
      const percent = facts.formatted['progressPercent'] ?? '';
      const subject =
        goal === undefined ? tr(locale, { en: 'That goal', sr: 'Taj cilj' }) : `“${goal}”`;
      const bar = percent === '' ? '' : ` (${percent}%)`;
      return remaining === undefined
        ? tr(
            locale,
            {
              en: '{subject} stands at {headline} of {target}{bar}.',
              sr: '{subject} stoji na {headline} od {target}{bar}.',
            },
            { subject, headline, target, bar },
          )
        : tr(
            locale,
            {
              en: '{subject} stands at {headline} of {target}{bar}, with {remaining} to go.',
              sr: '{subject} stoji na {headline} od {target}{bar}, do cilja još {remaining}.',
            },
            { subject, headline, target, bar, remaining },
          );
    }

    case 'GOAL_MONTHLY': {
      const months = facts.formatted['monthsRemaining'];
      const date = facts.formatted['targetDate'];
      const goal = facts.formatted['goal'];
      const subject = goal === undefined ? tr(locale, { en: 'that goal', sr: 'taj cilj' }) : `“${goal}”`;
      const by =
        date === undefined
          ? ''
          : tr(locale, { en: ' by {date}', sr: ' do {date}' }, { date });
      return months === undefined
        ? tr(
            locale,
            {
              en: 'Reaching {subject} needs {headline} a month{by}.',
              sr: 'Za {subject} potrebno je {headline} mesečno{by}.',
            },
            { subject, headline, by },
          )
        : tr(
            locale,
            {
              en: 'Reaching {subject}{by} needs {headline} a month for {months} months.',
              sr: 'Za {subject}{by} potrebno je {headline} mesečno narednih {months} meseci.',
            },
            { subject, by, headline, months },
          );
    }

    case 'SCHEDULE': {
      // F-16. The count is `formatted.count`, not `provenance.transactionCount`: these rows are
      // **rules**, and no Transaction was aggregated (the same reason the builder reports 0 there).
      const count = facts.formatted['count'] ?? headline;
      const paused = facts.formatted['pausedCount'];
      const named = namedRows(facts);
      if (named.length === 0) {
        return tr(locale, {
          en: 'There are no recurring charges on this ledger.',
          sr: 'Nema ponavljajućih plaćanja u ovoj evidenciji.',
        });
      }
      const list = named.map((row) => `${row.label} ${row.formatted}`).join(tr(locale, THEN));
      const rest =
        paused === undefined || paused === '0'
          ? ''
          : tr(locale, { en: ' {paused} of them are paused.', sr: ' {paused} su pauzirana.' }, { paused });
      return count === '1'
        ? tr(
            locale,
            { en: 'You have 1 recurring charge: {list}.{rest}', sr: 'Imaš 1 ponavljajuće plaćanje: {list}.{rest}' },
            { list, rest },
          )
        : tr(
            locale,
            {
              en: 'You have {count} recurring charges: {list}.{rest}',
              sr: 'Imaš {count} ponavljajućih plaćanja: {list}.{rest}',
            },
            { count, list, rest },
          );
    }

    case 'DUE': {
      const count = facts.formatted['count'] ?? headline;
      const days = facts.formatted['days'];
      const window =
        days === undefined
          ? tr(locale, { en: 'soon', sr: 'uskoro' })
          : tr(locale, { en: 'in the next {days} days', sr: 'u narednih {days} dana' }, { days });
      const named = namedRows(facts);
      if (named.length === 0) {
        return tr(locale, { en: 'Nothing is due {window}.', sr: 'Ništa ne dospeva {window}.' }, { window });
      }
      const list = named.map((row) => `${row.label} ${row.formatted}`).join(tr(locale, THEN));
      return count === '1'
        ? tr(
            locale,
            { en: '1 charge is due {window}: {list}.', sr: '1 plaćanje dospeva {window}: {list}.' },
            { window, list },
          )
        : tr(
            locale,
            {
              en: '{count} charges are due {window}: {list}.',
              sr: '{count} plaćanja dospevaju {window}: {list}.',
            },
            { count, window, list },
          );
    }

    case 'PROPOSAL': {
      // F-30. The sentence names the target, what the plan covers and what it cannot — all three from
      // `formatted`, so the fallback says the same thing the table shows.
      const target = facts.formatted['target'];
      const shortfall = facts.formatted['shortfall'];
      const named = namedRows(facts);
      if (named.length === 0) {
        return target === undefined
          ? tr(locale, {
              en: 'There is nothing in that period to cut.',
              sr: 'U tom periodu nema šta da se smanji.',
            })
          : tr(
              locale,
              {
                en: "I cannot reach {target} from that period's spending — there is nothing to cut.",
                sr: 'Ne mogu da dostignem {target} iz potrošnje tog perioda — nema šta da se smanji.',
              },
              { target },
            );
      }
      // One verb for the list, not one per item: "cut X by A, then cut Y by B" reads like a form.
      const plan = named
        .map(
          (row, index) =>
            tr(
              locale,
              index === 0
                ? { en: 'cut {label} by {amount}', sr: 'smanji {label} za {amount}' }
                : { en: '{label} by {amount}', sr: '{label} za {amount}' },
              { label: row.label, amount: row.formatted },
            ),
        )
        .join(tr(locale, THEN));
      const short =
        shortfall === undefined || facts.formatted['meetsTarget'] === 'true'
          ? ''
          : tr(
              locale,
              { en: ' That still leaves {shortfall} short.', sr: ' I dalje nedostaje {shortfall}.' },
              { shortfall },
            );
      return target === undefined
        ? `${plan}.${short}`
        : tr(locale, { en: 'To save {target}: {plan}.{short}', sr: 'Da uštediš {target}: {plan}.{short}' }, { target, plan, short });
    }

    case 'REFUSAL':
      // The service refuses before it renders (no facts are assembled for an unavailable template);
      // this arm exists so the `Record` stays total and says so rather than throwing.
      return renderRefusal('NO_TEMPLATE_MATCH', locale);
  }
}

/**
 * The copy for an answer the ledger cannot give.
 *
 * It is deliberately a **value** rather than an exception (docs/06 §8.5: `answered = false`, no
 * figure, suggestions offered), and it says which kind of "cannot" it is, because "we do not have
 * goals yet" and "I could not tell which Category you meant" are different problems for the user.
 */
export function renderRefusal(reason: string, locale: CopyLocale = 'en'): string {
  if (reason === 'NO_TEMPLATE_MATCH') {
    return tr(locale, {
      en: 'I cannot answer that from your ledger. Try one of the questions below.',
      sr: 'Ne mogu to da odgovorim iz tvoje evidencije. Probaj neko od pitanja ispod.',
    });
  }
  if (reason === 'ACTION_REQUEST') {
    // The refusal a **command** gets (B-4a): it is not a question, and the card under this sentence is
    // the answer to it.
    return tr(locale, {
      en: 'That is something I can do rather than answer — confirm it below.',
      sr: 'To je nešto što mogu da uradim, a ne da odgovorim — potvrdi ispod.',
    });
  }
  if (reason === 'NEEDS_TWO_PERIODS') {
    return tr(locale, {
      en: 'Comparing two periods needs both of them, which is not built yet.',
      sr: 'Za poređenje dva perioda potrebna su oba, a to još nije napravljeno.',
    });
  }
  if (reason === 'NO_TARGET_DATE') {
    return tr(locale, {
      en: 'That goal has no target date, so there is no monthly amount that reaches it. Give it a date and I can work one out.',
      sr: 'Taj cilj nema rok, pa ne postoji mesečni iznos koji ga dostiže. Daj mu datum i mogu da ga izračunam.',
    });
  }
  if (reason.startsWith('NOT_BUILT:')) {
    // Generic since A-2 built the last four templates that refused this way: the arm names the missing
    // piece from the reason rather than carrying prose for a template nobody has written, so a new
    // declaration fails loudly at the builder and reads sensibly here.
    return tr(
      locale,
      {
        en: 'I cannot answer that yet: {missing} is not part of the ledger.',
        sr: 'Još ne mogu to da odgovorim: {missing} nije deo evidencije.',
      },
      { missing: reason.slice('NOT_BUILT:'.length) },
    );
  }
  if (reason.startsWith('UNRUNNABLE:')) {
    const missing = reason.slice('UNRUNNABLE:'.length);
    const nouns: Readonly<Record<string, { en: string; sr: string }>> = {
      categoryId: { en: 'which Category you meant', sr: 'na koju kategoriju si mislio' },
      merchantId: { en: 'which Merchant you meant', sr: 'na kog prodavca si mislio' },
      accountId: { en: 'which Account you meant', sr: 'na koji račun si mislio' },
      tagId: { en: 'which Tag you meant', sr: 'na koju oznaku si mislio' },
      goalId: { en: 'which goal you meant', sr: 'na koji cilj si mislio' },
      recurringRuleId: { en: 'which recurring rule you meant', sr: 'na koje ponavljajuće plaćanje si mislio' },
      limit: { en: 'how many rows you wanted', sr: 'koliko redova želiš' },
      targetMinor: { en: 'how much you want to save', sr: 'koliko želiš da uštediš' },
      period: { en: 'which period you meant', sr: 'na koji period si mislio' },
    };
    return tr(
      locale,
      { en: 'I could not tell {noun}. Try naming it.', sr: 'Nisam mogao da prepoznam {noun}. Probaj da ga navedeš.' },
      { noun: tr(locale, nouns[missing] ?? { en: 'what you meant', sr: 'na šta si mislio' }) },
    );
  }
  return tr(locale, {
    en: 'I cannot answer that from your ledger yet.',
    sr: 'Još ne mogu to da odgovorim iz tvoje evidencije.',
  });
}

/** The rows a sentence may name, capped so a fallback stays a sentence. */
function namedRows(facts: AssistantFactsView): readonly { readonly label: string; readonly formatted: string }[] {
  return facts.rows.filter((row) => row.label.length > 0).slice(0, MAX_NAMED_ROWS);
}
