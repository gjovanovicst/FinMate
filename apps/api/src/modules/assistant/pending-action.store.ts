/**
 * Where a pending action lives between **propose** and **confirm** — ADR-035 decision 6.
 *
 * The invariant this file exists to protect: **the confirmation carries only the proposal id**, so the
 * server must be able to re-read the exact action the human saw. That is why a proposal is stored at
 * all, and why `${id}` is the only thing the execute path is allowed to need.
 *
 * ## Redis, and what that costs
 *
 * Redis is already running (ADR-004), so this adds no datastore under rule 9. It is **not durable**,
 * and the honest consequences are:
 *
 * - an unconfirmed proposal dies with a restart, which is fine — the user asks again;
 * - **a multi-instance API must share the Redis**, because an in-process map would fail to find a
 *   proposal confirmed against another instance. That is the trigger to move to a table, and it is
 *   recorded rather than discovered.
 *
 * ## The failure mode is closed, not open
 *
 * `RedisService`'s degradation policy leaves the choice to the caller. Rate limiting fails **open**
 * because locking everyone out is worse than missing a counter; this fails **closed** in both
 * directions: a proposal that cannot be stored is never offered, and one that cannot be read back is
 * never executed. A write must not happen on a guess about what the human approved.
 *
 * @module apps/api/src/modules/assistant
 */

import { Injectable } from '@nestjs/common';

import { RedisService } from '../../common/redis/redis.service';
import type { ActionSlotName, AssistantAction } from './assistant-actions';

/** Ten minutes: long enough to read a card, short enough that an abandoned proposal is not a trap. */
export const PROPOSAL_TTL_SECONDS = 600;

const PROPOSAL_PREFIX = 'assistant:action:proposal:';
const RESULT_PREFIX = 'assistant:action:result:';

/** One field of the preview's diff, as the card renders it. Always `before` × `after`, never a prose. */
export interface ActionDiffEntry {
  /**
   * **Which** field this is, stably — the slot's own name, not its label.
   *
   * `field` is localized for the reader (`naziv` in Serbian, `name` in English), so it cannot be an
   * identifier: a card that wants to offer a control for one field has to know which row that control
   * belongs to, in every language. That is what this is for (B-2b's `kind` toggle).
   */
  readonly slot: ActionSlotName;
  /** The label, in the Household's language. */
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
  /**
   * `after` in the machine's own vocabulary, when the slot has one — `EXPENSE`/`INCOME` for `kind`.
   *
   * A label is not a value either: the card offers a control that re-proposes with the **chosen**
   * kind, so it has to know which kind is currently proposed without comparing localized words. `null`
   * for a slot whose value is free text (`name`) and for `parentId`, where a null parent *is* the
   * honest value ("top level").
   */
  readonly afterValue: string | null;
  /** True when {@link ActionTemplate.defaultedSlots} filled it, so the card can offer to change it. */
  readonly defaulted: boolean;
}

/** The backend-rendered proposal: a sentence and a diff. Never narrated (ADR-035 decision 8). */
export interface ActionPreview {
  readonly sentence: string;
  readonly diff: readonly ActionDiffEntry[];
}

export interface PendingActionProposal {
  readonly id: string;
  /** The Household that asked. A proposal is not transferable, and this is what enforces it. */
  readonly householdId: string;
  readonly userId: string;
  readonly action: AssistantAction;
  readonly slots: Readonly<Record<string, string>>;
  readonly preview: ActionPreview;
  readonly createdAt: string;
}

/** What a completed action returns — stored so an idempotent replay answers the same thing. */
export interface ExecutedActionResult {
  readonly action: AssistantAction;
  readonly createdId: string;
  readonly createdLabel: string;
  readonly undo: string;
  /** The same sentence the preview showed, so the confirmation describes the thing that happened. */
  readonly sentence: string;
  readonly executedAt: string;
}

@Injectable()
export class PendingActionStore {
  constructor(private readonly redis: RedisService) {}

  /**
   * Store a proposal. `false` means Redis refused, and the caller must **not** offer it: an action
   * that cannot be read back cannot be confirmed, and offering a button that will fail is worse than
   * saying so now.
   */
  async put(proposal: PendingActionProposal): Promise<boolean> {
    try {
      const result = await this.redis.client.set(
        key(PROPOSAL_PREFIX, proposal.householdId, proposal.id),
        JSON.stringify(proposal),
        'EX',
        PROPOSAL_TTL_SECONDS,
      );
      return result === 'OK';
    } catch {
      return false;
    }
  }

  /**
   * Read a proposal **and consume it in one atomic step**.
   *
   * `GETDEL` is the whole concurrency story: two confirms racing on one proposal cannot both see it,
   * so a double-click cannot create two Categories. A replay after a successful execute therefore
   * finds nothing and is refused — unless {@link recallResult} holds its outcome, which is why the
   * execute path checks that first.
   */
  async take(householdId: string, id: string): Promise<PendingActionProposal | null> {
    try {
      const raw = await this.redis.client.getdel(key(PROPOSAL_PREFIX, householdId, id));
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      // A blob from an older build is not a proposal this build can honour; refusing is the only
      // safe reading, and it is why the shape is checked rather than cast.
      if (!isProposal(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Remember an outcome against the caller's idempotency key, so a retry is not a second write. */
  async rememberResult(
    householdId: string,
    idempotencyKey: string,
    result: ExecutedActionResult,
  ): Promise<void> {
    try {
      await this.redis.client.set(
        key(RESULT_PREFIX, householdId, idempotencyKey),
        JSON.stringify(result),
        'EX',
        PROPOSAL_TTL_SECONDS,
      );
    } catch {
      // Best effort: the proposal is already consumed, so the worst case is a retry that reports
      // "expired" for a write that did happen — never a second write.
    }
  }

  async recallResult(householdId: string, idempotencyKey: string): Promise<ExecutedActionResult | null> {
    try {
      const raw = await this.redis.client.get(key(RESULT_PREFIX, householdId, idempotencyKey));
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      return isResult(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

/** Household-scoped, so one Household's key can never address another's proposal (ADR-008). */
function key(prefix: string, householdId: string, id: string): string {
  return `${prefix}${householdId}:${id}`;
}

function isProposal(value: unknown): value is PendingActionProposal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PendingActionProposal>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.householdId === 'string' &&
    typeof candidate.userId === 'string' &&
    typeof candidate.action === 'string' &&
    typeof candidate.slots === 'object' &&
    candidate.slots !== null &&
    typeof candidate.preview === 'object' &&
    candidate.preview !== null &&
    typeof candidate.createdAt === 'string'
  );
}

function isResult(value: unknown): value is ExecutedActionResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ExecutedActionResult>;
  return (
    typeof candidate.action === 'string' &&
    typeof candidate.createdId === 'string' &&
    typeof candidate.createdLabel === 'string' &&
    typeof candidate.sentence === 'string'
  );
}
