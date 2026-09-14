import { Module } from '@nestjs/common';

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
    UuidScalar,
    LocalDateScalar,
  ],
})
export class AccountsModule {}
