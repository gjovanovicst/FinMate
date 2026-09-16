import { Injectable, Logger } from '@nestjs/common';

import type { Task } from '@finmate/ai';
import { uuidv7 } from '@finmate/domain';

import { getTenantContext, requireTenantContext } from '../../common/tenancy/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CONSENT_POLICY_VERSION,
  EXPOSED_CONSENT_KINDS,
  consentKindForTask,
  purposesForKind,
  type ConsentKind,
  type ConsentState,
  type ConsentView,
} from './consent';

export interface RecordConsentInput {
  readonly kind: ConsentKind;
  readonly state: Exclude<ConsentState, 'NOT_ASKED'>;
  /** The revision of the copy the user was shown. Defaults to this build's. */
  readonly policyVersion?: string;
  /** What we know about the decision: locale, surface, hashed request fingerprint. */
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/**
 * The consent record and the gate that reads it — docs/08 §6.6, ADR-007, ADR-031.
 *
 * ## The table is append-only, and that is the point
 *
 * Every decision is a new row. "Current state" is the newest row per `(household_id, kind)`, so the
 * history *is* the evidence that consent was held at a particular time — a mutable `granted` column
 * would destroy exactly what docs/08 §6.6 says we must be able to prove. There is no update and no
 * delete in this service, and `PurgeReceipts`/`gdpr.purge` (unbuilt) is the only thing that may
 * remove a row.
 *
 * ## Why the gate is here and not in `packages/ai`
 *
 * `AiRouter` needs an answer to "may this Household's text leave the EEA?" on every call. It cannot
 * know: the answer is a row, scoped by `TenantContext` (ADR-008), and `packages/ai` has no database
 * by construction. So it takes a {@link ConsentGate} callback and this class is that callback's
 * implementation in `apps/api` — the same split as the fold in `packages/rules-engine` and the
 * injected `fetch` in the adapters.
 *
 * ## Failure is refusal
 *
 * {@link permits} answers `false` when there is no tenant, when the kind cannot be resolved, and when
 * the read throws. A gate that cannot tell whose Household it is answering for has not been given
 * permission; the caller's correct behaviour is the rules-only rung, which needs no model at all
 * (docs/08 §6.7).
 *
 * @module apps/api/src/modules/consent
 */
@Injectable()
export class ConsentsService {
  private readonly logger = new Logger(ConsentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The current state of every purpose this build exposes, for the settings surface. */
  async overview(): Promise<ConsentView[]> {
    const views: ConsentView[] = [];
    for (const kind of EXPOSED_CONSENT_KINDS) {
      views.push(await this.state(kind));
    }
    return views;
  }

  /** The newest record for one kind, or `NOT_ASKED` when the Household has never decided. */
  async state(kind: ConsentKind): Promise<ConsentView> {
    const row = await this.prisma.client.consents.findFirst({
      where: { kind },
      // `recorded_at` is the decision clock and `id` is the tiebreaker. It matters here more than
      // anywhere: a GRANT immediately followed by a WITHDRAW lands in the same millisecond, and
      // `recorded_at` alone leaves Postgres free to return either — so the wrong answer would
      // silently re-admit egress. `id` is a UUIDv7 whose 12-bit in-millisecond sequence makes
      // "newest" total (docs/15).
      orderBy: [{ recorded_at: 'desc' }, { id: 'desc' }],
      select: { granted: true, withdrawn_at: true, policy_version: true, recorded_at: true },
    });

    return {
      kind,
      state: stateOf(row),
      recordedAt: row?.recorded_at ?? null,
      policyVersion: row?.policy_version ?? null,
      purposes: purposesForKind(kind),
    };
  }

  /**
   * Append a decision.
   *
   * `WITHDRAWN` is stored as `granted = false` **with** `withdrawn_at` set, which is what makes the
   * row distinguishable from a first-time `DECLINED` — the distinction docs/08 §6.6's state machine
   * needs and docs/03 §4's columns can express without a migration.
   */
  async record(input: RecordConsentInput): Promise<ConsentView> {
    const tenant = requireTenantContext('Record AI consent');
    const now = new Date();

    await this.prisma.client.consents.create({
      data: {
        id: uuidv7(),
        household_id: tenant.householdId,
        user_id: tenant.userId,
        kind: input.kind,
        granted: input.state === 'GRANTED',
        policy_version: input.policyVersion ?? CONSENT_POLICY_VERSION,
        recorded_at: now,
        withdrawn_at: input.state === 'WITHDRAWN' ? now : null,
        evidence: {
          ...(input.evidence ?? {}),
          // Recorded here rather than trusted from the client: the decision, the Household it was
          // made for, and the request that carried it are the server's account of what happened.
          decision: input.state,
          householdId: tenant.householdId,
          requestId: tenant.requestId,
          ...(tenant.sessionId === undefined ? {} : { sessionId: tenant.sessionId }),
        },
      },
    });

    return this.state(input.kind);
  }

  /**
   * May `task`'s payload reach a non-EEA endpoint for the Household in scope?
   *
   * This is {@link ConsentGate.permits}, and the router calls it once per non-EEA endpoint, per call.
   * It deliberately re-reads the newest row every time: docs/08 §6.6 requires a withdrawal to "take
   * effect before the next AI call", and a memoised grant would outlive it. The read is one indexed
   * lookup on the exception path, which is the right price.
   */
  async permits(task: Task): Promise<boolean> {
    const kind = consentKindForTask(task);
    // `EMBED` never leaves the node, so there is nothing to permit. `false` is the fail-closed
    // answer; the router does not route EMBED anywhere but LOCAL in any case.
    if (kind === null) return false;

    // Asked before the query rather than catching the guard's refusal: with no Household there is no
    // record to read, and a background scope reaching here is a configuration state, not an error.
    if (getTenantContext() === undefined) {
      this.logger.warn(
        `Refusing ${task} to a non-EEA endpoint: no TenantContext, so no Household consented.`,
      );
      return false;
    }

    try {
      const view = await this.state(kind);
      return view.state === 'GRANTED';
    } catch (error) {
      this.logger.warn(
        `Refusing ${task} to a non-EEA endpoint because consent could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}

/** The newest row's state, with `NOT_ASKED` for the absence of any row (docs/08 §6.6). */
function stateOf(
  row: { readonly granted: boolean; readonly withdrawn_at: Date | null } | null,
): ConsentState {
  if (row === null) return 'NOT_ASKED';
  if (row.withdrawn_at !== null) return 'WITHDRAWN';
  return row.granted ? 'GRANTED' : 'DECLINED';
}
