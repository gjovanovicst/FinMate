import { Controller, Get, Header, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { AuthenticatedGuard } from '../../common/auth/guards';
import { TransactionKind, TransactionStatus } from './transaction.model';
import { TransactionsService, type TransactionFilters } from './transactions.service';

/**
 * CSV export as a plain REST download (F-25).
 *
 * **Why REST and not GraphQL**, given the app is otherwise GraphQL-first: a download is a navigation,
 * not a fetch. An `<a href>` with the session cookie streams the response straight to the file
 * system — no Blob, no object URL, no revoking it afterwards, and no multi-megabyte string held in
 * JavaScript. Putting it behind GraphQL would mean returning the whole file as a string field and
 * rebuilding the browser's own download behaviour by hand.
 *
 * The filters are the same names the `transactions` query takes and resolve through the same
 * `buildWhere`, so what the user sees on the list is what lands in the file.
 */
@Controller('export')
export class TransactionsExportController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get('transactions.csv')
  @UseGuards(AuthenticatedGuard)
  @Header('Cache-Control', 'no-store')
  async exportCsv(
    @CurrentHouseholdId() householdId: string,
    @Query('accountId') accountId: string | undefined,
    @Query('categoryId') categoryId: string | undefined,
    @Query('kind') kind: TransactionKind | undefined,
    @Query('status') status: TransactionStatus | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('search') search: string | undefined,
    @Query('needsReview') needsReview: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const filters: TransactionFilters = {
      accountId,
      categoryId,
      kind,
      status,
      from,
      to,
      search,
      // A query string has no types, so only an explicit "true" is a filter. Anything else leaves it
      // unfiltered rather than silently meaning "false" — `needsReview=false` is a real filter the
      // GraphQL side supports, but omitting the param must not become it.
      ...(needsReview === 'true' ? { needsReview: true } : {}),
      ...(needsReview === 'false' ? { needsReview: false } : {}),
    };

    const { csv, rowCount } = await this.transactions.exportCsv(householdId, filters);

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${exportFilename(from, to)}"`,
    );
    // A custom header lets the client report how many rows it got without parsing the file.
    response.setHeader('x-export-rows', String(rowCount));
    response.send(csv);
  }
}

/**
 * A filename the user can recognise in a Downloads folder months later.
 *
 * The range is included when there is one, because "transactions.csv (3)" tells nobody anything.
 * Values are re-derived rather than echoed: a header value is a response-splitting risk if it
 * carries arbitrary client text, so only digits and dashes survive.
 */
export function exportFilename(from?: string, to?: string): string {
  const day = (value: string | undefined): string | null =>
    value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

  const start = day(from);
  const end = day(to);
  if (start && end) return `finmate-transactions-${start}_${end}.csv`;
  if (start) return `finmate-transactions-from-${start}.csv`;
  if (end) return `finmate-transactions-to-${end}.csv`;
  return `finmate-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
}
