import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { loadConfig, type AppConfig } from '../../config/config';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { BudgetingModule } from '../budgeting/budgeting.module';
import { InsightsService } from '../insights/insights.service';
import { InsightsModule } from '../insights/insights.module';
import { MailService } from '../mail/mail.service';
import { NotificationsModule } from './notifications.module';
import { NotificationsService } from './notifications.service';
import {
  UNCONFIGURED_WEB_PUSH,
  WEB_PUSH,
  WebPushSendError,
  type WebPushSender,
  type WebPushSubscription,
} from './web-push-sender';

/**
 * The `WEB_PUSH` sender's dispatch path and the subscription operations, against a real database —
 * ADR-028, task 4.2.9.
 *
 * The push **transport** is a fake and the database is not, for the same reason `files` stubs its
 * bucket: CI has Postgres but no push service, and what only Postgres can answer is what happens to
 * the **rows** — that a `404`/`410` retires exactly one subscription and still counts the
 * notification delivered, that a live sender fans out to every live endpoint, that an inert one
 * leaves rows `QUEUED` with a reason, and that one Household cannot read, revive or delete another's
 * endpoint (ADR-008).
 *
 * The VAPID key pair in this suite is nonsense: `WEB_PUSH` is overridden below, so no network call is
 * ever made. It exists so `pushPublicKey` has a configured value to return.
 */
class FakeWebPushSender implements WebPushSender {
  available = true;
  unavailableReason: string | null = null;
  readonly sent: { subscription: WebPushSubscription; payload: string }[] = [];

  private handler: (subscription: WebPushSubscription, payload: string) => Promise<void> = () =>
    Promise.resolve();

  sendNotification(subscription: WebPushSubscription, payload: string): Promise<void> {
    this.sent.push({ subscription, payload });
    return this.handler(subscription, payload);
  }

  reply(handler: (subscription: WebPushSubscription, payload: string) => Promise<void>): void {
    this.handler = handler;
  }

  reset(): void {
    this.sent.length = 0;
    this.available = true;
    this.unavailableReason = null;
    this.handler = () => Promise.resolve();
  }
}

describe('web push (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let sender: FakeWebPushSender;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'webpush-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'webpush-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  const config: AppConfig = loadConfig({
    ...process.env,
    VAPID_PUBLIC_KEY: 'test-vapid-public-key',
    VAPID_PRIVATE_KEY: 'test-vapid-private-key',
    VAPID_SUBJECT: 'mailto:push@example.test',
  });

  async function createSubscription(
    endpoint: string,
    options: { readonly household?: 'A' | 'B'; readonly deletedAt?: Date } = {},
  ): Promise<string> {
    const id = uuidv7();
    const other = options.household === 'B';
    await runWithTenant(other ? otherContext : context, () =>
      prisma.client.push_subscriptions.create({
        data: {
          id,
          household_id: other ? otherHouseholdId : householdId,
          user_id: other ? otherUserId : userId,
          endpoint,
          p256dh: 'p256dh-material',
          auth: 'auth-material',
          deleted_at: options.deletedAt ?? null,
        },
      }),
    );
    return id;
  }

  async function createQueuedNotification(
    channel: 'PUSH' | 'WEB_PUSH',
    stamp: string,
  ): Promise<string> {
    const id = uuidv7();
    await asTenant(() =>
      prisma.client.notifications.create({
        data: {
          id,
          household_id: householdId,
          user_id: userId,
          channel,
          // Loud on purpose: whatever the payload ends up being, none of this may appear in it.
          title: 'Budget overrun ahead: Supermarket',
          body: 'Projected 45000.00 RSD against a 10000.00 limit at Lidl',
          dedupe_key: `${channel}:${stamp}`,
          status: 'QUEUED',
        },
      }),
    );
    return id;
  }

  async function notificationStatus(id: string): Promise<string | null> {
    const row = await asTenant(() =>
      prisma.client.notifications.findFirst({ where: { id }, select: { status: true } }),
    );
    return row?.status ?? null;
  }

  async function subscriptionRow(endpoint: string) {
    return asTenant(() =>
      prisma.client.push_subscriptions.findFirst({ where: { endpoint } }),
    );
  }

  /** Every test starts from an empty push state: dispatch drains *all* queued rows for a Household. */
  async function resetPushState(): Promise<void> {
    sender.reset();
    for (const [ctx, id] of [
      [context, householdId],
      [otherContext, otherHouseholdId],
    ] as const) {
      await runWithTenant(ctx, async () => {
        await prisma.client.notifications.deleteMany({ where: { household_id: id } });
        await prisma.client.push_subscriptions.deleteMany({ where: { household_id: id } });
      });
    }
  }

  beforeAll(async () => {
    sender = new FakeWebPushSender();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(config),
        PrismaModule,
        AuthModule,
        BudgetingModule,
        InsightsModule,
        NotificationsModule,
      ],
    })
      .overrideProvider(MailService)
      .useValue({ sendNotification: () => Promise.resolve() })
      .overrideProvider(WEB_PUSH)
      .useValue(sender)
      .compile();
    prisma = moduleRef.get(PrismaService);
    notifications = moduleRef.get(NotificationsService);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `push-${stamp}@example.com`, display_name: 'Push Test' },
        { id: otherUserId, email: `push-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    for (const [ctx, id, owner] of [
      [context, householdId, userId],
      [otherContext, otherHouseholdId, otherUserId],
    ] as const) {
      await runWithTenant(ctx, () =>
        prisma.client.households.create({
          data: { id, name: 'Push Test', owner_user_id: owner, ledger_currency: 'RSD' },
        }),
      );
    }
  });

  afterAll(async () => {
    for (const [ctx, id] of [
      [context, householdId],
      [otherContext, otherHouseholdId],
    ] as const) {
      await runWithTenant(ctx, async () => {
        await prisma.client.notifications.deleteMany({ where: { household_id: id } });
        await prisma.client.push_subscriptions.deleteMany({ where: { household_id: id } });
        await prisma.client.households.deleteMany({ where: { id } });
      });
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef?.close();
  });

  beforeEach(async () => {
    await resetPushState();
  });

  // ---- dispatch -----------------------------------------------------------------------------

  it('sends a WEB_PUSH row to every live subscription and marks it SENT', async () => {
    await createSubscription('https://push.example.test/live-one');
    await createSubscription('https://push.example.test/live-two');
    // A retired endpoint is never a delivery target (ADR-028 decision 3).
    await createSubscription('https://push.example.test/tombstone', { deletedAt: new Date() });
    const id = await createQueuedNotification('WEB_PUSH', 'fanout');

    const result = await asTenant(() => notifications.dispatch(householdId));

    expect(result.failed).toBe(0);
    expect(result.sent).toBe(1);
    expect(sender.sent.map((call) => call.subscription.endpoint).sort()).toEqual([
      'https://push.example.test/live-one',
      'https://push.example.test/live-two',
    ]);
    expect(await notificationStatus(id)).toBe('SENT');

    // SENT means "the push service accepted it", and the payload it accepted is the minimal one.
    const payload = JSON.parse(sender.sent[0]!.payload) as Record<string, unknown>;
    expect(payload['notificationId']).toBe(id);
    expect(Object.keys(payload).sort()).toEqual(['deepLink', 'kind', 'notificationId']);
    expect(sender.sent[0]!.payload).not.toContain('Supermarket');
    expect(sender.sent[0]!.payload).not.toContain('45000');
  });

  it('treats PUSH as the same channel from the client\'s point of view', async () => {
    await createSubscription('https://push.example.test/push-channel');
    const id = await createQueuedNotification('PUSH', 'push-channel');

    const result = await asTenant(() => notifications.dispatch(householdId));

    expect(result.sent).toBe(1);
    expect(await notificationStatus(id)).toBe('SENT');
  });

  it('prunes a 410 subscription and still counts the notification delivered', async () => {
    const subscriptionId = await createSubscription('https://push.example.test/dead');
    const id = await createQueuedNotification('WEB_PUSH', 'gone');
    sender.reply(async () => {
      throw new WebPushSendError('push service said the subscription is gone', 410);
    });

    const result = await asTenant(() => notifications.dispatch(householdId));

    expect(result.failed).toBe(0);
    expect(result.sent).toBe(1);
    // A dead endpoint is retired, not failed: there is nothing left to retry.
    const row = await subscriptionRow('https://push.example.test/dead');
    expect(row?.id).toBe(subscriptionId);
    expect(row?.deleted_at).not.toBeNull();
    expect(await notificationStatus(id)).toBe('SENT');
  });

  it('sets FAILED with a reason when the push service rejects for any other reason', async () => {
    await createSubscription('https://push.example.test/flaky');
    const id = await createQueuedNotification('WEB_PUSH', 'network');
    sender.reply(async () => {
      throw new Error('socket hang up');
    });

    const result = await asTenant(() => notifications.dispatch(householdId));

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(await notificationStatus(id)).toBe('FAILED');
    expect(result.reasons.some((reason) => reason.includes('socket hang up'))).toBe(true);
    // Nothing was accepted and nothing was pruned, so the row is genuinely undelivered.
    expect(result.reasons.some((reason) => reason.includes(id))).toBe(true);
  });

  it('leaves rows QUEUED and reports skipped with a reason when no sender is configured', async () => {
    await createSubscription('https://push.example.test/never-used');
    const id = await createQueuedNotification('WEB_PUSH', 'unconfigured');
    sender.available = false;
    sender.unavailableReason = UNCONFIGURED_WEB_PUSH.unavailableReason;

    const result = await asTenant(() => notifications.dispatch(householdId));

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await notificationStatus(id)).toBe('QUEUED');
    expect(sender.sent).toHaveLength(0);
    expect(result.reasons.some((reason) => reason.includes('VAPID_PUBLIC_KEY'))).toBe(true);
  });

  it('reports skipped with a reason when the owner has no live subscription', async () => {
    const id = await createQueuedNotification('WEB_PUSH', 'no-endpoint');

    const result = await asTenant(() => notifications.dispatch(householdId));

    expect(result.skipped).toBe(1);
    expect(await notificationStatus(id)).toBe('QUEUED');
    expect(
      result.reasons.some((reason) => reason.includes('no live push subscription')),
    ).toBe(true);
  });

  // ---- the operations the client half calls (4.2.5) -----------------------------------------

  it('returns the configured VAPID public key, and null when there is none', () => {
    expect(notifications.pushPublicKey()).toBe('test-vapid-public-key');

    const withoutPush = new NotificationsService(
      prisma,
      moduleRef.get(InsightsService),
      moduleRef.get(MailService),
      loadConfig({ ...process.env }),
      UNCONFIGURED_WEB_PUSH,
    );
    expect(withoutPush.pushPublicKey()).toBeNull();
  });

  it('registers, re-registers without duplicating, revives and soft-deletes', async () => {
    const endpoint = 'https://push.example.test/register-me';
    const first = await asTenant(() =>
      notifications.registerPushSubscription(householdId, userId, {
        endpoint,
        p256dh: 'public-one',
        auth: 'auth-one',
        userAgent: 'TestBrowser/1.0',
      }),
    );
    expect((await subscriptionRow(endpoint))?.id).toBe(first.id);
    expect(
      await asTenant(() =>
        prisma.client.push_subscriptions.count({ where: { endpoint } }),
      ),
    ).toBe(1);

    // A re-subscribe updates the key material and the heartbeat rather than minting a second row.
    const second = await asTenant(() =>
      notifications.registerPushSubscription(householdId, userId, {
        endpoint,
        p256dh: 'public-two',
        auth: 'auth-two',
      }),
    );
    expect(second.id).toBe(first.id);
    expect(
      await asTenant(() =>
        prisma.client.push_subscriptions.count({ where: { endpoint } }),
      ),
    ).toBe(1);
    const updated = await subscriptionRow(endpoint);
    expect(updated?.p256dh).toBe('public-two');
    // An omitted `userAgent` leaves the stored one alone rather than blanking it.
    expect(updated?.user_agent).toBe('TestBrowser/1.0');
    expect(updated!.last_seen_at.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());

    // A re-subscribe also brings back a row a 404/410 retired.
    await asTenant(() =>
      prisma.client.push_subscriptions.updateMany({ where: { endpoint }, data: { deleted_at: new Date() } }),
    );
    const revived = await asTenant(() =>
      notifications.registerPushSubscription(householdId, userId, {
        endpoint,
        p256dh: 'public-three',
        auth: 'auth-three',
      }),
    );
    expect(revived.id).toBe(first.id);
    expect((await subscriptionRow(endpoint))?.deleted_at).toBeNull();

    expect(await asTenant(() => notifications.deletePushSubscription(householdId, endpoint))).toBe(
      true,
    );
    expect((await subscriptionRow(endpoint))?.deleted_at).not.toBeNull();
    // Already gone is not an error, and it is not a second tombstone either.
    expect(await asTenant(() => notifications.deletePushSubscription(householdId, endpoint))).toBe(
      false,
    );
  });

  it('cannot read, revive or delete another Household\'s endpoint', async () => {
    const endpoint = 'https://push.example.test/foreign';
    await runWithTenant(otherContext, () =>
      notifications.registerPushSubscription(otherHouseholdId, otherUserId, {
        endpoint,
        p256dh: 'their-public-key',
        auth: 'their-auth',
      }),
    );

    // A's unregister does not reach B's row.
    expect(await asTenant(() => notifications.deletePushSubscription(householdId, endpoint))).toBe(
      false,
    );

    // A's register cannot steal it: the endpoint is globally unique, so the database refuses and the
    // service answers CONFLICT rather than moving a device between Households.
    await expect(
      asTenant(() =>
        notifications.registerPushSubscription(householdId, userId, {
          endpoint,
          p256dh: 'stolen',
          auth: 'stolen',
        }),
      ),
    ).rejects.toBeInstanceOf(ApiError);

    const foreign = await runWithTenant(otherContext, () =>
      prisma.client.push_subscriptions.findMany({ where: { household_id: otherHouseholdId } }),
    );
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.p256dh).toBe('their-public-key');
    expect(foreign[0]?.deleted_at).toBeNull();
  });
});
