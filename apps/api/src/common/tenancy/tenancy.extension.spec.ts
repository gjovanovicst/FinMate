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
  HOUSEHOLD_SCOPED_WITH_GLOBAL_READS,
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

describe('models that also hold global rows (docs/08, layer 2)', () => {
  // `merchants` and `ai_provider_configs` carry rows with `household_id IS NULL`. docs/08 puts those
  // on the global allow-list: the seeded merchant catalogue is platform content every Household
  // resolves against, so scoping reads to `household_id = ctx` alone hides the seed from the very
  // Household that needs it. The guard previously did exactly that.

  it('lets a read see the Household rows OR the global ones', () => {
    const decision = withTenant(() =>
      applyTenancyGuard('merchants', 'findMany', { where: { name: 'lidl' } }),
    );
    expect(decision.args['where']).toEqual({
      name: 'lidl',
      AND: [{ OR: [{ household_id: HOUSEHOLD_A }, { household_id: null }] }],
    });
  });

  it('does NOT widen writes: an update stays scoped to the Household alone', () => {
    // Widening this would let any Household rename or delete the platform catalogue, and would let
    // one Household reach another's rows. The read/write asymmetry is the whole safety property.
    const decision = withTenant(() =>
      applyTenancyGuard('merchants', 'updateMany', { where: { id: 'm1' }, data: { name: 'x' } }),
    );
    expect(decision.args['where']).toEqual({ id: 'm1', household_id: HOUSEHOLD_A });
    expect(JSON.stringify(decision.args)).not.toContain('null');
  });

  it('does NOT widen deletes either', () => {
    const decision = withTenant(() =>
      applyTenancyGuard('merchants', 'deleteMany', { where: { id: 'm1' } }),
    );
    expect(decision.args['where']).toEqual({ id: 'm1', household_id: HOUSEHOLD_A });
  });

  it('refuses to let a Household create a global row', () => {
    const decision = withTenant(() =>
      applyTenancyGuard('merchants', 'create', { data: { name: 'Mine', is_global: true } }),
    );
    expect(decision.args['data']).toEqual({
      name: 'Mine',
      is_global: false,
      household_id: HOUSEHOLD_A,
    });
  });

  it('scopes an upsert to the Household and forces the created row to be owned', () => {
    const decision = withTenant(() =>
      applyTenancyGuard('merchants', 'upsert', {
        where: { id: 'm1' },
        create: { name: 'Mine', is_global: true },
        update: { name: 'Renamed' },
      }),
    );
    expect(decision.args['where']).toEqual({ id: 'm1', household_id: HOUSEHOLD_A });
    expect(decision.args['create']).toEqual({
      name: 'Mine',
      is_global: false,
      household_id: HOUSEHOLD_A,
    });
  });

  it('leaves a purely household-scoped model on the strict predicate', () => {
    const decision = withTenant(() => applyTenancyGuard('transactions', 'findMany', {}));
    expect(decision.args['where']).toEqual({ household_id: HOUSEHOLD_A });
  });

  it('still refuses to read without a context', () => {
    expect(() => applyTenancyGuard('merchants', 'findMany', {})).toThrow(TenantContextMissingError);
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

  it('covers every model that has household_id across the two column-scoped groups', () => {
    const columnScoped = new Set([
      ...HOUSEHOLD_SCOPED_BY_COLUMN,
      ...HOUSEHOLD_SCOPED_WITH_GLOBAL_READS,
    ]);
    expect([...columnScoped].sort()).toEqual(models.filter(hasHouseholdId).sort());
  });

  it('claims no household_id column for models in the other three groups', () => {
    for (const group of [HOUSEHOLD_SCOPED_BY_ID, PARENT_SCOPED_MODELS, GLOBAL_MODELS]) {
      for (const model of group) expect(hasHouseholdId(model)).toBe(false);
    }
  });

  it('puts only genuinely NULLable household_id models in the global-readable group', () => {
    // The group exists because those rows can be global. A model whose household_id is NOT NULL has
    // no global rows, so listing it here would widen its reads to rows that cannot exist.
    for (const model of HOUSEHOLD_SCOPED_WITH_GLOBAL_READS) {
      const body = new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema)?.[1];
      expect(body).toMatch(/household_id\s+String\?/);
    }
  });
});
