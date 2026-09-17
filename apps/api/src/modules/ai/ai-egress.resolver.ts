import { Inject } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';

import { AiEgressModel, toAiEgressModels } from './ai-egress.model';
import { AI_SEAMS } from './ai-tokens';
import type { AiSeams } from './ai-providers';

/**
 * What this deployment sends where — docs/08 §6.5 and §6.6.
 *
 * The consent sheet has to name the provider and the region, and the only honest source for that is the
 * process holding the routing table (see {@link toAiEgressModels}). It is a **read** of configuration,
 * not of a Household: the same answer for everyone, which is why it takes no arguments and reads no
 * tenancy — the rows are labels, not data.
 *
 * @module apps/api/src/modules/ai
 */
@Resolver(() => AiEgressModel)
export class AiEgressResolver {
  constructor(@Inject(AI_SEAMS) private readonly seams: AiSeams) {}

  @Query(() => [AiEgressModel], {
    description:
      'The routes this deployment would use for the consent-governed tasks **something in this build can ' +
      'call**, with the region derived from the endpoint registry. Empty when no endpoint is configured, ' +
      'which is the honest answer: nothing leaves this server and there is nothing to consent to.',
  })
  aiEgress(): AiEgressModel[] {
    return toAiEgressModels(this.seams.assembly, this.seams.calledTasks);
  }
}
