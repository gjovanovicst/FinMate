import { toMajorString, type Money } from '@finmate/domain';

/**
 * Serialise Transactions as RFC 4180 CSV.
 *
 * This is a pure function on purpose: CSV looks trivial until a description contains a comma, a
 * quote or a newline — and a field that shifts every later column by one turns a spreadsheet into
 * wrong numbers that look plausible. The escaping rules are pinned by
 * `transactions.csv.spec.ts` rather than trusted to review.
 *
 * Two format choices worth knowing:
 *
 *  - **Money is exported twice**: as `amount_minor` (the exact integer the ledger stores, ADR-003)
 *    and as `amount` (major units, dot decimal). A spreadsheet wants `2000.50`; a re-import or a
 *    reconciliation wants `200050`. Exporting only the friendly form would make the export lossy
 *    for anything but eye-reading.
 *  - **Splits are in the same file**, as `path:amountMinor` pairs. They are the only record of a
 *    divided Transaction's categorisation, and an export that dropped them would be incomplete in a
 *    way the user could not detect.
 *  - **A UTF-8 BOM is written.** Without it, Excel on a Windows machine in a Serbian locale reads
 *    the file as CP1252 and turns `Hleb` and `septička` into mojibake. The primary consumer of this
 *    file is a person opening it in a spreadsheet, so the BOM is the pragmatically correct choice;
 *    parsers that dislike it (`utf-8-sig`, `encoding='utf-8-sig'`) strip it in one flag.
 */

/** The columns, in order. Also the header row, so the two can never disagree. */
const COLUMNS = [
  'occurred_local_date',
  'occurred_at',
  'kind',
  'status',
  'amount_minor',
  'amount',
  'currency',
  'description',
  'category',
  'splits',
  'account',
  'note',
  'needs_review',
  'source',
  'id',
] as const;

/** One part of a divided Transaction, as the export shows it. */
export interface CsvSplit {
  readonly categoryPath: string;
  readonly amount: Money;
}

export interface CsvTransactionRow {
  readonly occurredLocalDate: string;
  readonly occurredAt: Date | string;
  readonly kind: string;
  readonly status: string;
  readonly amount: Money;
  readonly description: string;
  readonly categoryPath: string | null;
  /**
   * The parts of a divided Transaction.
   *
   * A Transaction with splits carries no category of its own, so omitting this column would drop
   * that categorisation from the export entirely — which defeats the point of an export whose
   * promise is that the data is the household's own.
   */
  readonly splits: readonly CsvSplit[];
  readonly accountName: string;
  readonly note: string | null;
  readonly needsReview: boolean;
  readonly source: string;
  readonly id: string;
}

const BOM = '\uFEFF';
/** RFC 4180 specifies CRLF, and Excel is the consumer that actually cares. */
const EOL = '\r\n';

/**
 * Quote a field when it contains a delimiter, a quote or a line break.
 *
 * Always quoting would also be valid, but it makes the file harder to read and diff for no gain.
 * A leading `=`, `+`, `-` or `@` is **not** escaped here: CSV injection is a real concern for
 * exports that are re-opened as formulas, but prefixing user text with a quote would corrupt every
 * genuine negative-looking value on re-import. The file is generated from the household's own data
 * for the household's own use, so the trade is made in favour of fidelity — noted here so the next
 * reader knows it was a decision, not an oversight.
 */
function field(value: string): string {
  if (value === '') return '';
  const needsQuotes = /[",\r\n]/.test(value);
  if (!needsQuotes) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function transactionsToCsv(rows: readonly CsvTransactionRow[]): string {
  const lines: string[] = [COLUMNS.join(',')];

  for (const row of rows) {
    lines.push(
      [
        row.occurredLocalDate,
        instant(row.occurredAt),
        row.kind,
        row.status,
        row.amount.amountMinor.toString(),
        toMajorString(row.amount),
        row.amount.currency,
        row.description,
        row.categoryPath ?? '',
        row.splits.map((split) => `${split.categoryPath}:${split.amount.amountMinor}`).join('; '),
        row.accountName,
        row.note ?? '',
        row.needsReview ? 'true' : 'false',
        row.source,
        row.id,
      ]
        .map(field)
        .join(','),
    );
  }

  // A trailing CRLF terminates the last record, which is what RFC 4180 asks for and what
  // spreadsheet importers expect.
  return BOM + lines.join(EOL) + EOL;
}
