import { Args, ArgsType, Field, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { toConnection } from '../../graphql/pagination';
import { AccountConnection, AccountKind, Account } from './account.model';
import { AccountsService } from './accounts.service';

/**
 * Keyset pagination arguments (docs/06 §1).
 *
 * `first` is clamped server-side (`normalisePageSize`), so an ambitious client cannot ask for the
 * entire ledger in one request.
 */
@ArgsType()
export class AccountsPageArgs {
  @Field(() => Int, { nullable: true, description: 'Page size, 1–200. Defaults to 50.' })
  first?: number;

  @Field(() => String, {
    nullable: true,
    description: 'Opaque cursor from a previous page’s endCursor. UUIDv7, so it is time-ordered.',
  })
  after?: string;
}

@ArgsType()
export class CreateAccountArgs {
  @Field(() => String)
  name!: string;

  @Field(() => AccountKind)
  kind!: AccountKind;

  @Field(() => MoneyScalar, {
    nullable: true,
    description: 'Optional starting balance. Defaults to 0 in the Household ledger currency.',
  })
  openingBalance?: { amountMinor: string; currency: string };
}

/**
 * Account queries and mutations.
 *
 * **Tenancy:** the Household is taken from `@CurrentHouseholdId()`, which reads the TenantContext
 * established from the authenticated session. It is never an argument — a client cannot ask for
 * another Household's Accounts, and there is no code path that would let it (ADR-008).
 *
 * **Authorization:** the globally-applied `AuthenticatedGuard` already rejects an unauthenticated
 * request before a resolver runs, so no per-resolver guard is needed here.
 */
@Resolver(() => Account)
export class AccountsResolver {
  constructor(private readonly accountsService: AccountsService) {}

  @Query(() => AccountConnection, {
    description: 'Accounts in the current Household, newest first, with computed balances.',
  })
  async accounts(
    @Args() args: AccountsPageArgs,
    @CurrentHouseholdId() householdId: string,
  ) {
    const page = await this.accountsService.list({
      householdId,
      first: args.first,
      after: args.after,
    });
    return toConnection(page);
  }

  @Query(() => Account, { description: 'A single Account by id, scoped to the Household.' })
  async account(
    @Args('id', { type: () => String }) id: string,
    @CurrentHouseholdId() householdId: string,
  ): Promise<Account> {
    return this.accountsService.getById(householdId, id);
  }

  @Mutation(() => Account, {
    description: 'Create an Account. The currency is the Household ledger currency (ADR-011).',
  })
  async createAccount(
    @Args() args: CreateAccountArgs,
    @CurrentHouseholdId() householdId: string,
  ): Promise<Account> {
    const opening = args.openingBalance ? BigInt(args.openingBalance.amountMinor) : undefined;
    return this.accountsService.create(householdId, {
      name: args.name,
      kind: args.kind,
      openingBalanceMinor: opening,
    });
  }
}
