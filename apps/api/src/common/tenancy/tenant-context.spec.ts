import { describe, expect, it } from 'vitest';

import {
  getTenantContext,
  hasTenantContext,
  requireTenantContext,
  runWithTenant,
  TenantContextMissingError,
  type TenantContext,
} from './tenant-context';

const CONTEXT: TenantContext = {
  householdId: '11111111-1111-7111-8111-111111111111',
  userId: '22222222-2222-7222-8222-222222222222',
  role: 'OWNER',
  sessionId: '33333333-3333-7333-8333-333333333333',
  requestId: 'req-test-1',
};

describe('TenantContext (ADR-008 — household scoping from the session, never from input)', () => {
  it('is absent outside a tenanted scope', () => {
    expect(hasTenantContext()).toBe(false);
    expect(getTenantContext()).toBeUndefined();
  });

  it('fails closed: requireTenantContext throws rather than returning undefined', () => {
    expect(() => requireTenantContext('accounts.findMany')).toThrow(TenantContextMissingError);
    expect(() => requireTenantContext()).toThrow(/No TenantContext is active/);
  });

  it('exposes the context inside runWithTenant', () => {
    runWithTenant(CONTEXT, () => {
      expect(hasTenantContext()).toBe(true);
      expect(requireTenantContext().householdId).toBe(CONTEXT.householdId);
      expect(requireTenantContext().role).toBe('OWNER');
    });
  });

  it('isolates contexts between concurrent scopes', async () => {
    // Two Households interleaved on one event loop must never observe each other's context.
    // This is the property that makes AsyncLocalStorage safe for multi-tenant request handling.
    const other: TenantContext = { ...CONTEXT, householdId: 'household-B', requestId: 'req-B' };

    const observed: string[] = [];

    await Promise.all([
      runWithTenant(CONTEXT, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        observed.push(requireTenantContext().householdId);
      }),
      runWithTenant(other, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        observed.push(requireTenantContext().householdId);
      }),
    ]);

    expect(observed).toContain(CONTEXT.householdId);
    expect(observed).toContain('household-B');
  });

  it('restores the outer scope after an inner one completes (nesting)', () => {
    runWithTenant(CONTEXT, () => {
      runWithTenant({ ...CONTEXT, householdId: 'inner' }, () => {
        expect(requireTenantContext().householdId).toBe('inner');
      });
      expect(requireTenantContext().householdId).toBe(CONTEXT.householdId);
    });
  });

  it('propagates the context into background work started inside the scope', async () => {
    // Background jobs are wrapped in runWithTenant explicitly; this asserts the context survives
    // an await boundary, which is what makes that pattern work.
    await runWithTenant(CONTEXT, async () => {
      await Promise.resolve();
      expect(requireTenantContext().householdId).toBe(CONTEXT.householdId);
    });
  });
});

describe('runWithTenant and lazy thenables', () => {
  const ctx: TenantContext = {
    householdId: '11111111-1111-7111-8111-111111111111',
    userId: '22222222-2222-7222-8222-222222222222',
    role: 'OWNER',
    requestId: 'req-lazy',
  };

  it('keeps the context alive when fn returns a thenable that has not run yet', async () => {
    // This is a Prisma query object in miniature: it only does its work when `then` is called, which
    // happens on `await` — after `storage.run` would otherwise have exited.
    let contextDuringWork: TenantContext | undefined;
    const lazy = {
      then(resolve: (value: unknown) => void) {
        contextDuringWork = getTenantContext();
        resolve(undefined);
      },
    };

    await runWithTenant(ctx, () => lazy);

    expect(contextDuringWork).toEqual(ctx);
  });

  it('still returns the value for a synchronous fn, and still scopes it', () => {
    expect(runWithTenant(ctx, () => getTenantContext()?.householdId)).toBe(ctx.householdId);
  });

  it('does not leak the context past the call', () => {
    runWithTenant(ctx, () => undefined);
    expect(getTenantContext()).toBeUndefined();
  });
});
