import { describe, expect, it } from 'vitest';

import { transactionsToCsv, type CsvTransactionRow } from './transactions.csv';

function row(overrides: Partial<CsvTransactionRow> = {}): CsvTransactionRow {
  return {
    occurredLocalDate: '2026-09-14',
    occurredAt: new Date('2026-09-14T10:00:00.000Z'),
    kind: 'EXPENSE',
    status: 'CONFIRMED',
    amount: { amountMinor: 200050n, currency: 'RSD' },
    description: 'Lidl',
    categoryPath: 'Hrana › Namirnice',
    splits: [],
    accountName: 'Kartica',
    note: null,
    needsReview: false,
    source: 'MANUAL',
    id: '01a0a04e-d056-7000-97d1-5b094eedf16c',
    ...overrides,
  };
}

/** Split without losing the quoted-newline case, which is the whole point of the escaping tests. */
function lines(csv: string): string[] {
  return csv.replace(/^\uFEFF/, '').split('\r\n');
}

describe('transactionsToCsv', () => {
  it('writes a BOM and a header naming every column', () => {
    const csv = transactionsToCsv([]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(lines(csv)[0]).toBe(
      'occurred_local_date,occurred_at,kind,status,amount_minor,amount,currency,description,' +
        'category,splits,account,note,needs_review,source,id',
    );
  });

  it('terminates the last record with CRLF, per RFC 4180', () => {
    expect(transactionsToCsv([row()]).endsWith('\r\n')).toBe(true);
  });

  it('exports money as BOTH exact minor units and a readable major amount', () => {
    // Only the readable form would make the export lossy; only the integer would make it unusable
    // in a spreadsheet.
    const csv = lines(transactionsToCsv([row({ amount: { amountMinor: 200050n, currency: 'RSD' } })]));
    const cells = (csv[1] as string).split(',');
    expect(cells[4]).toBe('200050');
    expect(cells[5]).toBe('2000.50');
    expect(cells[6]).toBe('RSD');
  });

  it('keeps a 0-decimal currency honest instead of forcing two decimals', () => {
    const csv = lines(transactionsToCsv([row({ amount: { amountMinor: 1000n, currency: 'JPY' } })]));
    expect((csv[1] as string).split(',')[5]).toBe('1000');
  });

  it('quotes a description containing a comma, so later columns do not shift', () => {
    const csv = lines(transactionsToCsv([row({ description: 'Lidl, Dorćol' })]));
    expect((csv[1] as string).startsWith('2026-09-14,2026-09-14T10:00:00.000Z,EXPENSE,CONFIRMED,200050,2000.50,RSD,"Lidl, Dorćol",')).toBe(true);
  });

  it('doubles an embedded quote', () => {
    const csv = lines(transactionsToCsv([row({ description: 'Cafe "Vuk"' })]));
    expect(csv[1]).toContain('"Cafe ""Vuk"""');
  });

  it('quotes a field containing a line break rather than emitting a broken record', () => {
    const csv = transactionsToCsv([row({ note: 'first\nsecond' })]);
    // The newline stays inside the quotes, so the file is still exactly two records and a reader
    // that splits on the record separator does not see a ghost row.
    expect(csv).toContain('"first\nsecond"');
    expect(csv.trimEnd().split('\r\n')).toHaveLength(2);
  });

  it('keeps Serbian diacritics and Cyrillic intact', () => {
    const csv = transactionsToCsv([row({ description: 'Septička jama — Лиди' })]);
    expect(csv).toContain('Septička jama — Лиди');
  });

  it('renders null and absent values as empty cells, not as the text "null"', () => {
    const csv = lines(transactionsToCsv([row({ note: null, categoryPath: null })]));
    const cells = (csv[1] as string).split(',');
    expect(cells[8]).toBe('');
    expect(cells[9]).toBe('');
    expect(cells[11]).toBe('');
    expect(csv[1]).not.toContain('null');
  });

  it('renders needs_review as a literal boolean a spreadsheet can read', () => {
    const csv = lines(
      transactionsToCsv([row({ needsReview: true }), row({ needsReview: false })]),
    );
    expect((csv[1] as string).split(',')[12]).toBe('true');
    expect((csv[2] as string).split(',')[12]).toBe('false');
  });

  it('lists a divided Transaction\'s parts, which carry its only categorisation', () => {
    const csv = lines(
      transactionsToCsv([
        row({
          categoryPath: null,
          splits: [
            { categoryPath: 'Hrana › Namirnice', amount: { amountMinor: 150000n, currency: 'RSD' } },
            { categoryPath: 'Kucni › Higijena', amount: { amountMinor: 50050n, currency: 'RSD' } },
          ],
        }),
      ]),
    );
    expect((csv[1] as string).split(',')[9]).toBe(
      'Hrana › Namirnice:150000; Kucni › Higijena:50050',
    );
  });

  it('emits one record per row, in the order given', () => {
    const csv = lines(transactionsToCsv([row({ description: 'a' }), row({ description: 'b' })]));
    // 1 header + 2 rows + the empty string after the final CRLF
    expect(csv).toHaveLength(4);
    expect(csv[1]).toContain(',a,');
    expect(csv[2]).toContain(',b,');
  });

  it('accepts an ISO string for occurred_at as well as a Date', () => {
    const csv = lines(transactionsToCsv([row({ occurredAt: '2026-09-14T10:00:00.000Z' })]));
    expect((csv[1] as string).split(',')[1]).toBe('2026-09-14T10:00:00.000Z');
  });
});
