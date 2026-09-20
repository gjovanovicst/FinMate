import type { CopyMap } from './copy';

/**
 * The assistant's fact-table labels, in both languages (ADR-040).
 *
 * These are the words in the "what the answer was computed from" table — *Saved*, *Target*,
 * *This period*. The client renders them **verbatim** (`assistant.component.ts` prints `row.label`),
 * and only three of them were ever mapped back to a translation key, so before this every Serbian
 * reader's facts table was English.
 *
 * They live in their own module because two callers need the same strings: `fact-assembly.service.ts`
 * builds the rows, and `narration-template.ts` looks a couple of them up again to read the sentence
 * *"This period …, against …"* out of the payload. A second copy of a label is exactly how the sentence
 * and the table start naming different rows.
 *
 * @module apps/api/src/common/i18n
 */

export const FACT_LABELS = {
  saved: { en: 'Saved', sr: 'Sačuvano' },
  target: { en: 'Target', sr: 'Cilj' },
  remaining: { en: 'Remaining', sr: 'Preostalo' },
  perMonth: { en: 'Per month', sr: 'Mesečno' },
  proposed: { en: 'Proposed', sr: 'Predloženo' },
  shortfall: { en: 'Shortfall', sr: 'Nedostaje' },
  averagePerDay: { en: 'Average per day', sr: 'Prosek po danu' },
  income: { en: 'Income', sr: 'Prihod' },
  spending: { en: 'Spending', sr: 'Trošak' },
  net: { en: 'Net', sr: 'Neto' },
  safeToSpendToday: { en: 'Safe to spend today', sr: 'Možeš da potrošiš danas' },
  projectedTotal: { en: 'Projected total', sr: 'Predviđeno ukupno' },
  projectedOverrun: { en: 'Projected overrun', sr: 'Predviđeno prekoračenje' },
  thisPeriod: { en: 'This period', sr: 'Ovaj period' },
  previousPeriod: { en: 'Previous period', sr: 'Prethodni period' },
  change: { en: 'Change', sr: 'Promena' },
  usual: { en: 'Usual', sr: 'Uobičajeno' },
  difference: { en: 'Difference', sr: 'Razlika' },
  household: { en: 'Household', sr: 'Domaćinstvo' },
} as const satisfies Readonly<Record<string, CopyMap>>;
