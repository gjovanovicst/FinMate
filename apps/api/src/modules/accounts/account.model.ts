import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';

import type { Money } from '@finmate/domain';

import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { Paginated } from '../../graphql/pagination';

export enum AccountKind {
  CASH = 'CASH',
  BANK = 'BANK',
  CARD = 'CARD',
  OTHER = 'OTHER',
}

registerEnumType(AccountKind, {
  name: 'AccountKind',
  description: 'What kind of container holds the money (docs/03 §2).',
});

@ObjectType({
  description:
    'An Account: a place money sits. Balance is computed, never stored — invariant I-4 requires the ' +
    'ledger to be reconstructible from Transactions.',
})
export class Account {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => AccountKind)
  kind!: AccountKind;

  @Field(() => MoneyScalar, {
    description: 'The balance the Account started with, before any Transaction.',
  })
  openingBalance!: Money;

  @Field(() => MoneyScalar, {
    description:
      'Derived: openingBalance + income − expense over CONFIRMED, non-deleted Transactions. ' +
      'Computed by the backend and never by a language model (ADR-001, invariant I-4).',
  })
  balance!: Money;

  @Field(() => String, { description: 'ISO-4217 code; the Household ledger currency (ADR-011).' })
  currency!: string;

  @Field(() => Boolean)
  isArchived!: boolean;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType()
export class AccountConnection extends Paginated(Account) {}
