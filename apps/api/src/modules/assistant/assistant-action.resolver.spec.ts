import { describe, expect, it } from 'vitest';

import type { MemberRole, TenantContext } from '../../common/tenancy/tenant-context';
import { AssistantResolver } from './assistant.resolver';
import type { AssistantActionService } from './assistant-action.service';
import type { AssistantService } from './assistant.service';

/**
 * The resolver is where the two decisions that are **not** the service's live: whether a question asks
 * for an action at all, and whether the caller's role may perform it.
 *
 * Both are unit-testable because the resolver takes its tenant as a parameter rather than reading a
 * global — so the role gate can be exercised for every role without a request.
 */
function tenant(role: MemberRole): TenantContext {
  return { householdId: 'h1', userId: 'u1', role, requestId: 'action-resolver-spec' };
}

/** A resolver whose action service is a stub, plus a recorder so "was it reached" is assertable. */
function resolverWith(propose?: AssistantActionService['propose']): {
  resolver: AssistantResolver;
  calls: () => number;
} {
  let calls = 0;
  const stub = {
    propose: async (...args: Parameters<AssistantActionService['propose']>) => {
      calls += 1;
      if (propose === undefined) throw new Error('the service must not be reached');
      return propose(...args);
    },
  };
  return {
    resolver: new AssistantResolver({} as AssistantService, stub as unknown as AssistantActionService),
    calls: () => calls,
  };
}

describe('assistantProposeAction (ADR-035)', () => {
  it('refuses a question that asks for nothing, without reaching the service', async () => {
    const { resolver, calls } = resolverWith();

    const result = await resolver.assistantProposeAction(tenant('MEMBER'), 'kolika mi je penzija');

    expect(result.proposed).toBe(false);
    expect(result.reason).toBe('NOT_AN_ACTION');
    expect(result.proposalId).toBeNull();
    expect(calls()).toBe(0);
  });

  it('refuses an unmistakable request that does not say what to create', async () => {
    // A silent fall-through to the read planner would answer a question nobody asked, so this is a
    // named refusal with the missing slot in it.
    const { resolver, calls } = resolverWith();

    const result = await resolver.assistantProposeAction(tenant('MEMBER'), 'dodaj kategoriju');

    expect(result.proposed).toBe(false);
    expect(result.reason).toBe('UNRUNNABLE:name');
    expect(calls()).toBe(0);
  });

  it('refuses a VIEWER — the first write path that does', async () => {
    const { resolver, calls } = resolverWith();

    await expect(
      resolver.assistantProposeAction(tenant('VIEWER'), 'dodaj kategoriju Putovanja'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls()).toBe(0);
  });

  it('proposes for a MEMBER, with the expiry as a Date for the DateTime scalar', async () => {
    const { resolver } = resolverWith(async () => ({
      proposed: true as const,
      proposalId: 'p1',
      action: 'ADD_CATEGORY' as const,
      preview: { sentence: 'Nova kategorija „Putovanja” (rashod, bez nadređene)', diff: [] },
      expiresAt: '2026-09-17T00:10:00.000Z',
    }));

    const result = await resolver.assistantProposeAction(tenant('MEMBER'), 'dodaj kategoriju Putovanja');

    expect(result.proposed).toBe(true);
    expect(result.proposalId).toBe('p1');
    expect(result.action).toBe('ADD_CATEGORY');
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it('passes a supplied kind through, so the card can re-propose rather than change a proposal', async () => {
    let seen: Record<string, string> | undefined;
    const { resolver } = resolverWith(async (input) => {
      seen = { ...input.slots };
      return {
        proposed: true as const,
        proposalId: 'p2',
        action: 'ADD_CATEGORY' as const,
        preview: { sentence: 's', diff: [] },
        expiresAt: '2026-09-17T00:10:00.000Z',
      };
    });

    await resolver.assistantProposeAction(tenant('MEMBER'), 'dodaj kategoriju Plata', 'INCOME' as never);

    expect(seen).toEqual({ name: 'Plata', kind: 'INCOME' });
  });

  it('passes an account through too, because the card offers to change the one it guessed', async () => {
    // The same mechanism as `kind`, and the same reason: the account a capture goes to is
    // preselected, and a preselection the user cannot correct is a silent guess (ADR-035 decision 5).
    let seen: Record<string, string> | undefined;
    const { resolver } = resolverWith(async (input) => {
      seen = { ...input.slots };
      return {
        proposed: true as const,
        proposalId: 'p3',
        action: 'ADD_TRANSACTION' as const,
        preview: { sentence: 's', diff: [] },
        expiresAt: '2026-09-17T00:10:00.000Z',
      };
    });

    await resolver.assistantProposeAction(
      tenant('MEMBER'),
      'dodaj trošak kafa 180',
      undefined,
      'acct-2',
    );

    expect(seen).toEqual({ text: 'kafa 180', accountId: 'acct-2' });
  });

  it('returns the service\'s own refusal as a refusal, not as an error', async () => {
    // `NO_AMOUNT` and friends are decided where the pipeline runs, and they are refusals: the question
    // asked for something the registry does, and the text could not become a row.
    const { resolver } = resolverWith(async () => ({ proposed: false as const, reason: 'NO_AMOUNT' }));

    const result = await resolver.assistantProposeAction(tenant('MEMBER'), 'dodaj trošak kafu');

    expect(result.proposed).toBe(false);
    expect(result.reason).toBe('NO_AMOUNT');
    expect(result.proposalId).toBeNull();
  });
});
