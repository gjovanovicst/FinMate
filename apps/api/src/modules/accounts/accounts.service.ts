import { Injectable } from '@nestjs/common';

import { addMoney, money, subtractMoney, uuidv7, type Money } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { normalisePageSize, type CursorPage } from '../../graphql/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountKind, type Account } from './account.model';

export interface CreateAccountInput {
  readonly name: string;
  readonly kind: AccountKind;
  readonly openingBalanceMinor?: bigint;
}

/**
 * Accounts — the first real vertical slice through the stack.
 *
 * It exercises the parts that must be right from the start: tenancy (the guard scopes every query
 * from the session), money as `bigint` minor units (ADR-003), pagination by UUIDv7 cursor, and a
 * derived balance computed in the backend (ADR-001, invariant I-4).
 */
@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** One page of Accounts, newest first, with balances resolved in a single extra query. */
  async list(params: {
    householdId: string;
    first?: number;
    after?: string;
  }): Promise<CursorPage<Account>> {
    const take = normalisePageSize(params.first);

    const where = {
      deleted_at: null,
      is_archived: false,
      // The tenancy guard also injects household_id; being explicit keeps the intent obvious and
      // the query plan stable.
      household_id: params.householdId,
      ...(params.after ? { id: { lt: params.after } } : {}),
    };

    // Fetch one extra row to decide `hasNextPage` without a second COUNT over the same predicate.
    const [rows, totalCount] = await Promise.all([
      this.prisma.client.accounts.findMany({
        where,
        orderBy: { id: 'desc' },
        take: take + 1,
      }),
      this.prisma.client.accounts.count({ where: { deleted_at: null, household_id: params.householdId } }),
    ]);

    const hasNextPage = rows.length > take;
    const page = hasNextPage ? rows.slice(0, take) : rows;
    const balances = await this.balancesByAccountId(page.map((row) => row.id));

    const items: Account[] = page.map((row) => this.toModel(row, balances));
    return {
      items,
      totalCount,
      hasNextPage,
      endCursor: items.at(-1)?.id ?? null,
    };
  }

  /** A single Account, or NOT_FOUND. Never `findUnique` — the guard refuses it on scoped models. */
  async getById(householdId: string, id: string): Promise<Account> {
    const row = await this.prisma.client.accounts.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
    });
    if (!row) throw new ApiError('NOT_FOUND', 'Account not found.');

    const balances = await this.balancesByAccountId([row.id]);
    return this.toModel(row, balances);
  }

  async create(householdId: string, input: CreateAccountInput): Promise<Account> {
    const name = input.name.trim();
    if (name.length === 0) throw new ApiError('VALIDATION_FAILED', 'Account name is required.');

    const duplicate = await this.prisma.client.accounts.findFirst({
      where: { household_id: householdId, name, deleted_at: null },
    });
    if (duplicate) throw new ApiError('CONFLICT', 'An account with that name already exists.');

    // The Household ledger currency governs (ADR-011); the client does not choose it.
    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
    });
    if (!household) throw new ApiError('NOT_FOUND', 'Household not found.');

    const openingMinor = input.openingBalanceMinor ?? 0n;
    if (openingMinor < 0n) {
      throw new ApiError('VALIDATION_FAILED', 'Opening balance cannot be negative.');
    }

    const created = await this.prisma.client.accounts.create({
      data: {
        id: uuidv7(),
        household_id: householdId,
        name,
        kind: input.kind,
        currency: household.ledger_currency,
        opening_balance_minor: openingMinor,
      },
    });

    return this.toModel(created, new Map([[created.id, money(0n, created.currency)]]));
  }

  /**
   * Balances for many Accounts in ONE query.
   *
   * Deliberately not per-account: N+1 queries on a list endpoint is the defect docs/10 §10.1 asks
   * the test suite to catch, and it is invisible in development where N is 3.
   */
  private async balancesByAccountId(accountIds: readonly string[]): Promise<Map<string, Money>> {
    const result = new Map<string, Money>();
    if (accountIds.length === 0) return result;

    const rows = await this.prisma.client.accounts.findMany({
      where: { id: { in: [...accountIds] } },
      select: { id: true, opening_balance_minor: true, currency: true },
    });
    const opening = new Map(rows.map((row) => [row.id, row]));

    // Invariant I-4: only CONFIRMED, non-deleted Transactions count, and PENDING never does (I-7).
    const summed = await this.prisma.client.transactions.groupBy({
      by: ['account_id', 'kind'],
      where: {
        account_id: { in: [...accountIds] },
        status: 'CONFIRMED',
        deleted_at: null,
      },
      _sum: { amount_minor: true },
    });

    for (const accountId of accountIds) {
      const account = opening.get(accountId);
      if (!account) continue;

      let balance = money(account.opening_balance_minor, account.currency);
      for (const row of summed) {
        if (row.account_id !== accountId) continue;
        const total = money(row._sum.amount_minor ?? 0n, account.currency);
        balance = row.kind === 'INCOME' ? addMoney(balance, total) : subtractMoney(balance, total);
      }
      result.set(accountId, balance);
    }

    return result;
  }

  private toModel(
    row: {
      id: string;
      name: string;
      kind: string;
      currency: string;
      opening_balance_minor: bigint;
      is_archived: boolean;
      created_at: Date;
      updated_at: Date;
    },
    balances: Map<string, Money>,
  ): Account {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind as AccountKind,
      currency: row.currency,
      openingBalance: money(row.opening_balance_minor, row.currency),
      balance: balances.get(row.id) ?? money(row.opening_balance_minor, row.currency),
      isArchived: row.is_archived,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
