import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runWithTenant, TenantContextMissingError, type TenantContext } from './tenant-context';
import {
  ALL_CLASSIFIED_MODELS,
  applyTenancyGuard,
  GLOBAL_MODELS,
  HOUSEHOLD_SCOPED_BY_COLUMN,
  HOUSEHOLD_SCOPED_BY_ID,
  PARENT_SCOPED_MODELS,
  TenancyError,
} from './tenancy.extension';

const HOUSEHOLD_A = '11111111-1111-7111-8111-111111111111';
const HOUSEHOLD_B = '99999999-9999-7999-8999-999999999999';

const CONTEXT: TenantContext = {
  householdId: HOUSEHOLD_A,
  userId: '22222222-2222-7222-8222-222222222222',
  role: 'OWNER',
  sessionId: '33333333-3333-7333-8333-333333333333',
  requestId: 'req-test-1',
};

function withTenant<T>(fn: () => T): T {
  return runWithTenant(CONTEXT, fn);
}

describe('tenancy guard (ADR-008 layer 2 — mechanical household scoping)', () => {
  describe('the hard requirement: no context means no access', () => {
    it('throws for a read on a household-scoped model', () => {
      expect(() => applyTenancyGuard('transactions', 'findMany', {})).toThrow(
        TenantContextMissingError,
      );
    });

    it('throws for a write on a household-scoped model', () => {
      expect(() => applyTenancyGuard('transactions', 'create', { data: {} })).toThrow(
        TenantContextMissingError,
      );
    });

    it('names the offending operation so the bug is findable', () => {
      expect(() => applyTenancyGuard('budgets', 'deleteMany', {})).toThrow(/budgets\.deleteMany/);
    });

    it('does not throw for a global model', () => {
      expect(applyTenancyGuard('users', 'findMany', {})).toEqual({ allowed: true, args: {} });
    });
  });

  describe('read scoping', () => {
    it('injects household_id into where for findMany', () => {
      const { args } = withTenant(() =>
        applyTenancyGuard('transactions', 'findMany', { where: { kind: 'EXPENSE' } }),
      );
      expect(args['where']).toEqual({ kind: 'EXPENSE', household_id: HOUSEHOLD_A });
    });

    it('creates a where clause when none was supplied', () => {
      const { args } = withTenant(() => applyTenancyGuard('accounts', 'findFirst', {}));
      expect(args['where']).toEqual({ household_id: HOUSEHOLD_A });
    });

    it('overrides a caller-supplied household_id rather than trusting it', () => {
      const { args } = withTenant(() =>
        applyTenancyGuard('transactions', 'findMany', { where: { household_id: HOUSEHOLD_B } }),
      );
      expect(args['where']).toEqual({ household_id: HOUSEHOLD_A });
    });

    it('scopes count, aggregate and groupBy too', () => {
      for (const operation of ['count', 'aggregate', 'groupBy']) {
        const { args } = withTenant(() => applyTenancyGuard('transactions', operation, {}));
        expect(args['where']).toEqual({ household_id: HOUSEHOLD_A });
      }
    });

    it('scopes households by primary key, so the platform is never listed wholesale', () => {
      const { args } = withTenant(() => applyTenancyGuard('households', 'findMany', {}));
      expect(args['where']).toEqual({ id: HOUSEHOLD_A });
    });

    it('cannot be tricked into listing other Households via households.findMany', () => {
      const { args } = withTenant(() =>
        applyTenancyGuard('households', 'findMany', { where: { id: HOUSEHOLD_B } }),
      );
      expect(args['where']).toEqual({ id: HOUSEHOLD_A });
    });
  });

  describe('write scoping', () => {
    it('injects household_id into data on create', () => {
      const { args } = withTenant(() =>
        applyTenancyGuard('transactions', 'create', { data: { description: 'Lidl' } }),
      );
      expect(args['data']).toEqual({ description: 'Lidl', household_id: HOUSEHOLD_A });
    });

    it('injects household_id into every row on createMany', () => {
      const { args } = withTenant(() =>
        applyTenancyGuard('transactions', 'createMany', {
          data: [{ description: 'a' }, { description: 'b' }],
        }),
      );
      expect(args['data']).toEqual([
        { description: 'a', household_id: HOUSEHOLD_A },
        { description: 'b', household_id: HOUSEHOLD_A },
      ]);
    });

    it('refuses a cross-Household write instead of silently rewriting it', () => {
      expect(() =>
        withTenant(() =>
          applyTenancyGuard('transactions', 'create', {
            data: { household_id: HOUSEHOLD_B, description: 'attack' },
          }),
        ),
      ).toThrow(TenancyError);
    });

    it('scopes update and delete by where', () => {
      for (const operation of ['update', 'delete', 'updateMany', 'deleteMany']) {
        const { args } = withTenant(() =>
          applyTenancyGuard('transactions', operation, { where: { id: 'x' } }),
        );
        expect(args['where']).toEqual({ id: 'x', household_id: HOUSEHOLD_A });
      }
    });

    it('scopes both branches of an upsert', () => {
      const { args } = withTenant(() =>
        applyTenancyGuard('transactions', 'upsert', { where: { id: 'x' }, create: { id: 'x' } }),
      );
      expect(args['where']).toEqual({ id: 'x', household_id: HOUSEHOLD_A });
      expect(args['create']).toEqual({ id: 'x', household_id: HOUSEHOLD_A });
    });
  });

  describe('findUnique is refused by design', () => {
    it('throws with actionable guidance to use findFirst', () => {
      expect(() => withTenant(() => applyTenancyGuard('transactions', 'findUnique', {}))).toThrow(
        TenancyError,
      );
      expect(() => withTenant(() => applyTenancyGuard('transactions', 'findUnique', {}))).toThrow(
        /findFirst/,
      );
    });

    it('throws for findUniqueOrThrow as well', () => {
      expect(() =>
        withTenant(() => applyTenancyGuard('transactions', 'findUniqueOrThrow', {})),
      ).toThrow(TenancyError);
    });

    it('still allows findUnique on a global model', () => {
      expect(applyTenancyGuard('users', 'findUnique', { where: { id: 'x' } })).toEqual({
        allowed: true,
        args: { where: { id: 'x' } },
      });
    });
  });

  describe('parent-scoped models are refused directly', () => {
    it.each(['transaction_tags', 'merchant_aliases', 'counterparty_aliases'])(
      'refuses a direct query on %s and explains the include pattern',
      (model) => {
        expect(() => withTenant(() => applyTenancyGuard(model, 'findMany', {}))).toThrow(TenancyError);
        expect(() => withTenant(() => applyTenancyGuard(model, 'findMany', {}))).toThrow(/include/);
      },
    );

    it('refuses direct access even without a tenant context, as a distinct failure', () => {
      expect(() => applyTenancyGuard('transaction_tags', 'findMany', {})).toThrow(TenancyError);
    });
  });

  describe('aggregated child tables are directly scoped', () => {
    // transaction_splits, receipt_items and goal_contributions carry their own household_id
    // (migration 20260914160000) because they are SUMMED per Household: budget consumption by
    // category, "how much on meat this month", goal progress. Being parent-scoped would have meant
    // an escape hatch for every rollup and for reassignment when a Category is deleted.
    it.each(['transaction_splits', 'receipt_items', 'goal_contributions'])(
      'scopes %s directly instead of refusing it',
      (model) => {
        const { args } = withTenant(() =>
          applyTenancyGuard(model, 'findMany', { where: { category_id: 'c-1' } }),
        );
        expect(args['where']).toEqual({ category_id: 'c-1', household_id: HOUSEHOLD_A });
      },
    );

    it('still refuses access to them without a tenant context', () => {
      for (const model of ['transaction_splits', 'receipt_items', 'goal_contributions']) {
        expect(() => applyTenancyGuard(model, 'findMany', {})).toThrow(TenantContextMissingError);
      }
    });
  });

  describe('fail closed on unknown operations', () => {
    it('refuses an operation that is neither filterable nor a create', () => {
      expect(() => withTenant(() => applyTenancyGuard('transactions', 'someFutureOp', {}))).toThrow(
        /not covered by the tenancy guard/,
      );
    });
  });
});

describe('model classification — the list that must not be forgotten', () => {
  const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]!);
  const hasHouseholdId = (model: string): boolean => {
    const body = new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema)?.[1];
    return body !== undefined && /household_id/.test(body);
  };

  it('finds every model in the Prisma schema', () => {
    expect(models.length).toBeGreaterThan(30);
  });

  it.each(models)('classifies "%s" in at least one group', (model) => {
    expect(ALL_CLASSIFIED_MODELS.some((group) => group.has(model))).toBe(true);
  });

  it.each(models)('classifies "%s" in exactly one group', (model) => {
    expect(ALL_CLASSIFIED_MODELS.filter((group) => group.has(model))).toHaveLength(1);
  });

  it('does not classify a model that no longer exists', () => {
    const known = new Set(models);
    for (const group of ALL_CLASSIFIED_MODELS) {
      for (const model of group) expect(known.has(model)).toBe(true);
    }
  });

  it('lists in HOUSEHOLD_SCOPED_BY_COLUMN exactly the models that have household_id', () => {
    expect([...HOUSEHOLD_SCOPED_BY_COLUMN].sort()).toEqual(models.filter(hasHouseholdId).sort());
  });

  it('claims no household_id column for models in the other three groups', () => {
    for (const group of [HOUSEHOLD_SCOPED_BY_ID, PARENT_SCOPED_MODELS, GLOBAL_MODELS]) {
      for (const model of group) expect(hasHouseholdId(model)).toBe(false);
    }
  });
});
