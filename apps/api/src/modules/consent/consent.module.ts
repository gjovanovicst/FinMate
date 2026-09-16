import { Module } from '@nestjs/common';

import { GraphqlScalarsModule } from '../../graphql/scalars/scalars.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ConsentsResolver } from './consents.resolver';
import { ConsentsService } from './consents.service';

/**
 * The consent record and the gate over it — docs/08 §6.6, ADR-007, ADR-031.
 *
 * Exported because the AI composition root provides the router's `ConsentGate` from
 * {@link ConsentsService}: the gate is the only thing that may admit a non-EEA endpoint, and it must
 * be the *same* object the settings surface writes through, or a withdrawal would not reach it.
 *
 * There is no edge in the other direction: this module knows nothing about AI providers, models or
 * routing. Consent is about permission; `modules/ai` is about plumbing.
 *
 * @module apps/api/src/modules/consent
 */
@Module({
  imports: [PrismaModule, GraphqlScalarsModule],
  providers: [ConsentsService, ConsentsResolver],
  exports: [ConsentsService],
})
export class ConsentModule {}
