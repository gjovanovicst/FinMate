import { requireTenantContext } from './tenant-context';

/**
 * Prisma client extension that mechanically enforces household scoping (ADR-008, layer 2 of 3).
 *
 * Every model is classified into exactly one of four groups, and the classification is asserted
 * against the Prisma schema by `tenancy.extension.spec.ts` — so adding a table without deciding
 * its tenancy fails CI instead of silently leaking (risk R-10).
 *
 * ## Why `findUnique` is refused on scoped models
 *
 * Prisma's `findUnique` accepts only unique fields in `where`, so `household_id` cannot be added
 * to the filter. The row would be fetched across Households and the check would have to happen
 * afterwards, at every call site. Instead the guard rejects `findUnique` and requires `findFirst`,
 * which accepts arbitrary filters and can therefore always carry the tenant predicate.
 *
 * @module apps/api/src/common/tenancy
 */

/**
 * Models carrying a `household_id` column. The guard injects it into every read and write.
 * 24 models as of the baseline migration (docs/03-domain-model.md §4).
 */
export const HOUSEHOLD_SCOPED_BY_COLUMN: ReadonlySet<string> = new Set([
  'accounts',
  'alert_rules',
  'attachments',
  'audit_log',
  'budgets',
  'categories',
  'category_keywords',
  'classification_decisions',
  'consents',
  'corrections',
  'counterparties',
  'entity_embeddings',
  'household_members',
  'insights',
  'notifications',
  'purge_receipts',
  'receipts',
  'recurring_rules',
  'rules',
  'saving_goals',
  'tags',
  'transactions',
  // Denormalised from their parent so they can be scoped and aggregated per Household
  // (migration 20260914160000_scope_aggregated_children).
  'transaction_splits',
  'receipt_items',
  'goal_contributions',
]);

/**
 * `households` has no `household_id` column — it is scoped by its own primary key.
 *
 * This one matters: without it, `households.findMany()` would list every Household on the
 * platform. The guard therefore injects `id = householdId`.
 */
export const HOUSEHOLD_SCOPED_BY_ID: ReadonlySet<string> = new Set(['households']);

/**
 * Models that hold BOTH Household rows and platform-wide reference rows.
 *
 * docs/08 §"Layer 2" puts `merchants.is_global` / `household_id IS NULL` on the **global allow-list**:
 * the seeded merchant catalogue is platform content that every Household resolves against. Scoping
 * their reads to `household_id = ctx` alone hid all 38 seeded merchants from the Households that need
 * them, so the classifier would have been blind to its own seed data.
 *
 * **The scope therefore depends on the operation, and that asymmetry is the safety property:**
 *  - **reads** see the Household's rows OR the global ones;
 *  - **writes** see only the Household's rows. Widening a write would let any Household rename or
 *    delete the platform catalogue, and — worse — reach another Household's rows.
 *
 * Only models whose `household_id` is nullable belong here; a `NOT NULL` column has no global rows to
 * read, so listing it would widen the predicate to rows that cannot exist. A spec asserts this.
 */
export const HOUSEHOLD_SCOPED_WITH_GLOBAL_READS: ReadonlySet<string> = new Set([
  'ai_provider_configs',
  'merchants',
]);

/**
 * Child tables with no `household_id`, reachable only through a scoped parent.
 *
 * Direct access is **refused**, because there is no tenant predicate the guard could add — a bare
 * `receipt_items.findMany()` would return every Household's receipt lines. Reach them through the
 * parent instead, which Prisma expresses as a relation load:
 *
 * ```ts
 * // refused
 * await prisma.receipt_items.findMany({ where: { receipt_id: id } });
 * // correct — the parent query is scoped, so the children are too
 * await prisma.receipts.findFirst({ where: { id }, include: { receipt_items: true } });
 * ```
 */
export const PARENT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'counterparty_aliases',
  'merchant_aliases',
  'transaction_tags',
]);

/**
 * Models with no Household relationship. Tenancy does not apply; the authorization matrix does.
 *
 * `users`, `sessions`, `refresh_tokens` and `email_tokens` are scoped to the authenticated *user*
 * — that is an authentication concern (Phase 0 task 0.6), not a tenancy concern. `prompt_templates`
 * is platform configuration.
 */
export const GLOBAL_MODELS: ReadonlySet<string> = new Set([
  'email_tokens',
  'prompt_templates',
  'refresh_tokens',
  'sessions',
  'users',
]);

/** Every model the guard knows about. The spec asserts this matches the Prisma schema exactly. */
export const ALL_CLASSIFIED_MODELS: readonly ReadonlySet<string>[] = [
  HOUSEHOLD_SCOPED_BY_COLUMN,
  HOUSEHOLD_SCOPED_BY_ID,
  HOUSEHOLD_SCOPED_WITH_GLOBAL_READS,
  PARENT_SCOPED_MODELS,
  GLOBAL_MODELS,
];

/** Operations whose `args.where` accepts arbitrary filters, so the scope can be injected. */
const FILTERABLE_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

/**
 * The read subset, which is the only one that may be widened to include global rows.
 *
 * Kept separate from the writes on purpose: a single set is how a "reads may see global rows" rule
 * quietly becomes "writes may too".
 */
const READ_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Operations that create rows and therefore need the scope injected into `data`. */
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

export class TenancyError extends Error {
  readonly code = 'TENANCY_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'TenancyError';
  }
}

export interface TenancyGuardDecision {
  readonly allowed: boolean;
  readonly args: Record<string, unknown>;
}

/**
 * Pure decision function: decide whether a Prisma operation is permitted and how its arguments
 * must be rewritten.
 *
 * Kept pure — no Prisma, no I/O — so the tenancy rule is exhaustively unit-testable without a
 * database. Security-critical logic should not require integration infrastructure to verify.
 *
 * @throws {TenantContextMissingError} household-scoped model, no active context.
 * @throws {TenancyError} operation cannot carry a tenant predicate, or is a cross-Household write.
 */
export function applyTenancyGuard(
  model: string | undefined,
  operation: string,
  args: Record<string, unknown>,
): TenancyGuardDecision {
  if (!model || GLOBAL_MODELS.has(model)) {
    return { allowed: true, args };
  }

  if (PARENT_SCOPED_MODELS.has(model)) {
    throw new TenancyError(
      `${model} has no household_id and cannot be scoped directly, so direct access is refused. ` +
        `Reach it through its parent, whose query the tenancy guard already scopes — for example ` +
        `\`prisma.transactions.findFirst({ where: { id }, include: { transaction_tags: true } })\` ` +
        `instead of querying ${model} directly (ADR-008).`,
    );
  }

  const context = requireTenantContext(`${model}.${operation}`);
  const scopeKey = HOUSEHOLD_SCOPED_BY_ID.has(model) ? 'id' : 'household_id';
  const scopeValue = context.householdId;

  if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
    throw new TenancyError(
      `${model}.${operation} is not permitted on a household-scoped model: its \`where\` accepts ` +
        `only unique fields, so the Household scope cannot be enforced in the query. Use ` +
        `\`findFirst\` (or \`findFirstOrThrow\`) with the same unique field instead (ADR-008).`,
    );
  }

  const globalReadable = HOUSEHOLD_SCOPED_WITH_GLOBAL_READS.has(model);

  if (CREATE_OPERATIONS.has(operation)) {
    const scoped = injectIntoData(model, operation, args, scopeKey, scopeValue);
    // A Household creates owned rows only. `is_global` is forced rather than validated so a caller
    // cannot mint platform-wide content that every other Household would then see.
    return { allowed: true, args: globalReadable ? forceOwned(scoped) : scoped };
  }

  if (READ_OPERATIONS.has(operation)) {
    return {
      allowed: true,
      args: globalReadable
        ? injectGlobalReadableWhere(args, scopeValue)
        : injectIntoWhere(operation, args, scopeKey, scopeValue),
    };
  }

  if (FILTERABLE_OPERATIONS.has(operation)) {
    const scoped = injectIntoWhere(operation, args, scopeKey, scopeValue);
    // An upsert's `create` branch is still a create, so it gets the same ownership rule.
    return {
      allowed: true,
      args: globalReadable && operation === 'upsert' ? forceOwnedCreate(scoped) : scoped,
    };
  }

  throw new TenancyError(
    `${model}.${operation} is not covered by the tenancy guard. Add it to FILTERABLE_OPERATIONS ` +
      `or CREATE_OPERATIONS in tenancy.extension.ts once you have confirmed it cannot read or ` +
      `modify rows across Households.`,
  );
}

function injectIntoWhere(
  operation: string,
  args: Record<string, unknown>,
  scopeKey: string,
  scopeValue: string,
): Record<string, unknown> {
  const where = (args['where'] ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = {
    ...args,
    // Spread `where` first, then override the scope key: a caller-supplied value can never win.
    where: { ...where, [scopeKey]: scopeValue },
  };

  if (operation === 'upsert') {
    const create = (args['create'] ?? {}) as Record<string, unknown>;
    next['create'] = { ...create, [scopeKey]: scopeValue };
  }

  return next;
}

/**
 * Add `household_id = ctx OR household_id IS NULL` to a read.
 *
 * Composed with `AND` rather than merged as a sibling `OR` key: Prisma's `where` holds at most one
 * `OR`, so writing ours there would silently discard a caller's own `OR` and change their query.
 * `AND` accumulates instead, which is what a scope injection must do to be invisible.
 */
function injectGlobalReadableWhere(
  args: Record<string, unknown>,
  scopeValue: string,
): Record<string, unknown> {
  const where = (args['where'] ?? {}) as Record<string, unknown>;
  const existingAnd = where['AND'];
  const and = Array.isArray(existingAnd) ? existingAnd : existingAnd ? [existingAnd] : [];

  return {
    ...args,
    where: {
      ...where,
      AND: [...and, { OR: [{ household_id: scopeValue }, { household_id: null }] }],
    },
  };
}

/** Force `is_global: false` on `create`/`createMany` data. */
function forceOwned(args: Record<string, unknown>): Record<string, unknown> {
  const own = (row: unknown): unknown => ({ ...(row as Record<string, unknown>), is_global: false });
  const data = args['data'];
  if (Array.isArray(data)) return { ...args, data: data.map(own) };
  if (data && typeof data === 'object') return { ...args, data: own(data) };
  return args;
}

/** Force `is_global: false` on an upsert's `create` branch. */
function forceOwnedCreate(args: Record<string, unknown>): Record<string, unknown> {
  const create = args['create'];
  if (create && typeof create === 'object') {
    return { ...args, create: { ...(create as Record<string, unknown>), is_global: false } };
  }
  return args;
}

function injectIntoData(
  model: string,
  operation: string,
  args: Record<string, unknown>,
  scopeKey: string,
  scopeValue: string,
): Record<string, unknown> {
  const withScope = (row: Record<string, unknown>): Record<string, unknown> => {
    const existing = row[scopeKey];
    if (typeof existing === 'string' && existing !== scopeValue) {
      throw new TenancyError(
        `${model}.${operation} attempted to write ${scopeKey}=${existing} while the active ` +
          `TenantContext is ${scopeKey}=${scopeValue}. Cross-Household writes are forbidden.`,
      );
    }
    return { ...row, [scopeKey]: scopeValue };
  };

  const data = args['data'];
  if (Array.isArray(data)) {
    return { ...args, data: data.map((row) => withScope(row as Record<string, unknown>)) };
  }
  if (data && typeof data === 'object') {
    return { ...args, data: withScope(data as Record<string, unknown>) };
  }
  return args;
}

/**
 * Wrap a Prisma client with the tenancy guard.
 *
 * Applied once in `PrismaService`, so every consumer is protected without opting in.
 */
export function withTenancy<T extends object>(client: T): T {
  const extended = (client as unknown as { $extends: (ext: unknown) => unknown }).$extends({
    name: 'tenancy',
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model?: string;
          operation: string;
          args: Record<string, unknown>;
          query: (args: Record<string, unknown>) => Promise<unknown>;
        }): Promise<unknown> {
          const decision = applyTenancyGuard(model, operation, args);
          return query(decision.args);
        },
      },
    },
  });
  return extended as T;
}
