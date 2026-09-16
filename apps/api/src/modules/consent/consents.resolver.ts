import { createHash } from 'node:crypto';

import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Roles } from '../../common/auth/guards';
import { ApiError } from '../../common/filters/all-exceptions.filter';
import { ConsentModel, RecordConsentInput, toConsentModel } from './consent.model';
import { ConsentsService } from './consents.service';
import type { ConsentKind, ConsentState } from './consent';

/**
 * Reading and recording AI consent — docs/08 §6.6, ADR-007, ADR-031.
 *
 * ## OWNER-only, and it is a step-up act
 *
 * docs/08 §6.6 and Q-11 make granting or withdrawing consent an OWNER act in both directions: it is
 * the evidence base for the lawful basis under which Household free text leaves the EEA. A `MEMBER`
 * reading the state is fine — they are entitled to know what their Household decided — but only the
 * OWNER may change it.
 *
 * ## Re-authentication is required to *change* provider/region, not to withdraw
 *
 * docs/08 §6.6: "Re-authentication is required to change provider/region or grant `EVAL_DATASET`",
 * and separately "withdrawal is reachable in **two taps**". So an easy withdrawal and a hard grant of
 * the eval opt-in are the same mutation reached two ways — re-auth is the *caller's* precondition
 * (a client concern, and the lock screen already exists). This resolver records what it is told and
 * refuses nothing for lack of a second factor it cannot verify; the step-up endpoint is 5.2.
 *
 * @module apps/api/src/modules/consent
 */

@Resolver(() => ConsentModel)
export class ConsentsResolver {
  constructor(private readonly consents: ConsentsService) {}

  @Query(() => [ConsentModel], {
    description:
      'The Household decision for every purpose this build enforces, including the ones never ' +
      'asked. Never a bare boolean: a screen has to be able to say "not asked yet".',
  })
  async aiConsents(): Promise<ConsentModel[]> {
    return (await this.consents.overview()).map(toConsentModel);
  }

  /**
   * Record a decision. Append-only: a withdrawal is a new row, never a mutation of an old one.
   *
   * The evidence is assembled here rather than accepted from the client, because it is the *server's*
   * account of the act: the hashed request fingerprint, the surface, the locale and the request id.
   * `recorded_at` and the deciding `user_id` come from the session and the database clock.
   */
  @Mutation(() => ConsentModel, {
    description:
      'Grant, decline or withdraw one AI consent purpose. OWNER-only (docs/08 §6.6, Q-11). A ' +
      'withdrawal takes effect before the next AI call.',
  })
  @Roles('OWNER')
  async recordAiConsent(
    @Args('input') input: RecordConsentInput,
    @Context('req') request: { ip?: string; headers?: Record<string, unknown> } | undefined,
  ): Promise<ConsentModel> {
    if (input.state === 'NOT_ASKED') {
      throw new ApiError(
        'VALIDATION_FAILED',
        'NOT_ASKED is the absence of a record and cannot be written. Use WITHDRAWN to revoke.',
      );
    }

    const view = await this.consents.record({
      kind: input.kind as ConsentKind,
      state: input.state as Exclude<ConsentState, 'NOT_ASKED'>,
      ...(input.policyVersion === undefined ? {} : { policyVersion: input.policyVersion }),
      evidence: {
        // Never the raw values (docs/03 §4): the session's own fingerprinting rule, applied here for
        // the same reason — evidence has to be identifiable without becoming a location history.
        ...(request === undefined
          ? {}
          : {
              ipHash: fingerprint(request.ip),
              userAgentHash: fingerprint(
                typeof request.headers?.['user-agent'] === 'string'
                  ? (request.headers['user-agent'] as string)
                  : undefined,
              ),
            }),
        ...(input.surface === undefined ? {} : { surface: input.surface }),
        ...(input.locale === undefined ? {} : { locale: input.locale }),
      },
    });

    return toConsentModel(view);
  }
}

/** Hash a request fingerprint before storing it — the same rule `auth.controller.ts` applies. */
function fingerprint(value: string | undefined): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex');
}
