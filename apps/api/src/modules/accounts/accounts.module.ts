import { Module } from '@nestjs/common';

import { BalanceScalar } from '../../graphql/scalars/balance.scalar';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar, UuidScalar } from '../../graphql/scalars/uuid.scalar';
import { AccountsResolver } from './accounts.resolver';
import { AccountsService } from './accounts.service';

@Module({
  providers: [
    AccountsResolver,
    AccountsService,
    // Custom scalars are registered by being provided; they are referenced by type in @Field().
    MoneyScalar,
    BalanceScalar,
    UuidScalar,
    LocalDateScalar,
  ],
  // The assistant reads balances through this service rather than re-deriving them: a balance is
  // `opening + income − expense` over every CONFIRMED Transaction, which is invariant I-4's arithmetic
  // and must exist in exactly one place (docs/06 §8.2, ADR-001).
  exports: [AccountsService],
})
export class AccountsModule {}
