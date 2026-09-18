import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import type { RedisService } from '../../common/redis/redis.service';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { TagsService } from '../taxonomy/tags.service';
import { AssistantModule } from './assistant.module';
import { AssistantResolver } from './assistant.resolver';
import { PendingActionStore } from './pending-action.store';

/**
 * `ADD_TAG` against a real Postgres — task B-4c, docs/16 B.4.
 *
 * The smallest of the five actions, and its one interesting property is a **difference between two
 * actions' duplicate rules**. `TagsService.assertNameFree` compares by the **fold**
 * (`normaliseForMatching`) while a Category's `categories_unique_name` index compares `lower(name)`.
 * A propose-time check copied from the category action would offer a confirm button for a Tag the write
 * refuses — the lie ADR-035 decision 5 exists to prevent — so this suite asserts the *fold* is the rule
 * that runs, with a pair whose two rules disagree: `Путовања` and `Putovanja` are one name to the fold
 * (which transliterates) and two to `lower()`.
 */
describe('assistant ADD_TAG (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let tags: TagsService;
  let resolver: AssistantResolver;

  const householdId = uuidv7();
  const userId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'tag-it' };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  function memoryStore(): PendingActionStore {
    const store = new Map<string, string>();
    const client = {
      set: async (key: string, value: string): Promise<'OK'> => {
        store.set(key, value);
        return 'OK';
      },
      getdel: async (key: string): Promise<string | null> => {
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      },
      get: async (key: string): Promise<string | null> => store.get(key) ?? null,
    };
    return new PendingActionStore({ client } as unknown as RedisService);
  }

  const propose = (question: string) =>
    asTenant(() => resolver.assistantProposeAction(context, question, undefined, undefined, 'sr-Latn'));

  const execute = (proposalId: string, key: string = uuidv7()) =>
    asTenant(() => resolver.assistantExecuteAction(context, proposalId, key));

  const tagsOf = () => asTenant(() => tags.list(householdId));

  /** Propose and confirm in one step, for the tests that only need the row to exist. */
  const create = async (question: string): Promise<void> => {
    const proposal = await propose(question);
    if (!proposal.proposed || proposal.proposalId === null) {
      throw new Error(`expected a proposal for ${question}`);
    }
    await execute(proposal.proposalId);
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, AuthModule, AssistantModule],
    })
      .overrideProvider(PendingActionStore)
      .useValue(memoryStore())
      .compile();
    prisma = moduleRef.get(PrismaService);
    tags = moduleRef.get(TagsService);
    resolver = moduleRef.get(AssistantResolver);

    const stamp = Date.now();
    await prisma.client.users.create({
      data: { id: userId, email: `tag-${stamp}@example.com`, display_name: 'Tag Test' },
    });
    await asTenant(() =>
      prisma.client.households.create({
        data: {
          id: householdId,
          name: 'Tag Test',
          owner_user_id: userId,
          ledger_currency: 'RSD',
          iana_timezone: 'Europe/Belgrade',
        },
      }),
    );
  });

  afterAll(async () => {
    await asTenant(() => prisma.client.households.deleteMany({ where: { id: householdId } }));
    await prisma.client.users.deleteMany({ where: { id: userId } });
    await moduleRef.close();
  });

  it('proposes a tag by name, and writes nothing', async () => {
    const before = await tagsOf();
    const proposal = await propose('dodaj tag Odmor');

    expect(proposal.proposed).toBe(true);
    expect(proposal.action).toBe('ADD_TAG');
    expect(proposal.preview?.sentence).toContain('Odmor');
    // A tag is one field, so the diff is one row — and it is the name, not a filled default.
    expect(proposal.preview?.diff).toHaveLength(1);
    expect(proposal.preview?.diff[0]?.slot).toBe('name');
    expect(proposal.preview?.diff[0]?.defaulted).toBe(false);
    expect(await tagsOf()).toHaveLength(before.length);
  });

  it('writes the tag through the same service /tags uses, with no colour', async () => {
    const proposal = await propose('dodaj tag Odmor');
    if (!proposal.proposed || proposal.proposalId === null) throw new Error('expected a proposal');

    const executed = await execute(proposal.proposalId);
    expect(executed.undo).toBe('SOFT_DELETE');
    expect(executed.sentence).toContain('Odmor');

    const rows = (await tagsOf()).filter((tag) => tag.id === executed.createdId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Odmor');
    // The colour `/tags` can set is deliberately not filled: the question never states one, and a colour
    // has no consequence the reader needs to confirm.
    expect(rows[0]?.color).toBeNull();
  });

  it('keeps a Cyrillic name Cyrillic, and refuses its Latin spelling as the same tag', async () => {
    await create('додај tag Путовања');
    expect((await tagsOf()).find((tag) => tag.name === 'Путовања')?.name).toBe('Путовања');

    // ⚠️ This pair is what tells the **fold** apart from `lower()`, which is the whole point of the
    // check: `lower('Путовања') !== lower('Putovanja')`, while `normaliseForMatching` makes them one
    // string — two scripts, one name, which is exactly what the fold is for. A propose-time check copied
    // from the category action would offer a button for a write `createTag` refuses.
    //
    // (A diacritic pair would do as well — `Čaj`/`caj` — but not `Rođendan`/`Rodjendan`: the fold maps
    // `đ` → `d` and leaves the digraph `dj` alone, which is the `đ`/`ђ` inconsistency `AGENTS.md`
    // records as a Phase 2 gap.)
    await expect(propose('dodaj tag Putovanja')).rejects.toMatchObject({ code: 'CONFLICT' });

    // …and a name whose fold differs proposes without complaint.
    expect((await propose('dodaj tag Posao')).proposed).toBe(true);
  });

  it('refuses a request that does not say what to call it', async () => {
    const proposal = await propose('dodaj tag');

    expect(proposal.proposed).toBe(false);
    expect(proposal.reason).toBe('UNRUNNABLE:name');
  });

  it('answers a repeated idempotency key with the same row, and writes nothing twice', async () => {
    const proposal = await propose('dodaj tag Teretana');
    if (!proposal.proposed || proposal.proposalId === null) throw new Error('expected a proposal');
    const key = uuidv7();

    const first = await execute(proposal.proposalId, key);
    const retry = await execute(proposal.proposalId, key);

    expect(retry.replayed).toBe(true);
    expect(retry.createdId).toBe(first.createdId);
    expect((await tagsOf()).filter((tag) => tag.id === first.createdId)).toHaveLength(1);
  });
});
