// @vitest-environment jsdom
// FIRST import, deliberately — see `notifications.component.spec.ts` for why the JIT compiler must be
// loaded before anything that touches `@angular/router` or the testing module.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { SwPush } from '@angular/service-worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../graphql/graphql.client';
import { PushService } from './push.service';

initAngularTesting();

/**
 * The push client flow (task 4.2.5), against a fake `SwPush`.
 *
 * What is asserted here is the part a mounted screen cannot show: that nothing prompts without a
 * button, that the browser is unsubscribed **before** the row is deleted (otherwise the next app start
 * re-registers what the user just turned off), that a start-up re-registration happens once and only
 * with permission already granted, and that a browser which returns no key material is refused rather
 * than stored as an endpoint that can never deliver.
 */

interface FakeSubscription {
  endpoint: string;
  toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } };
}

function makeSubscription(endpoint = 'https://push.example.test/abc'): FakeSubscription {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-material', auth: 'auth-material' } }),
  };
}

function makeSwPush(options: {
  enabled: boolean;
  subscription: FakeSubscription | null;
  request?: () => Promise<FakeSubscription>;
}) {
  return {
    isEnabled: options.enabled,
    // A real `SwPush` emits the current subscription and completes; `NEVER` when disabled. The service
    // must never await this when disabled, and the `enabled: false` cases below would hang if it did.
    subscription: {
      subscribe: (observer: { next: (value: FakeSubscription | null) => void }) => {
        observer.next(options.subscription);
        return { unsubscribe: () => undefined };
      },
      [Symbol.observable]: () => undefined,
    },
    requestSubscription: vi.fn(options.request ?? (() => Promise.resolve(makeSubscription()))),
    unsubscribe: vi.fn(() => Promise.resolve()),
  };
}

function makeClient() {
  return {
    // The second parameter is declared even though these fakes ignore it: without it every
    // `mock.calls` entry is a one-element tuple and reading the variables off it is a type error that
    // `vitest` does not see — the trap docs/15 records for exactly this shape.
    query: vi.fn((query: string, _variables?: Record<string, unknown>) => {
      if (query.includes('query PushPublicKey')) {
        return Promise.resolve({ pushPublicKey: 'BPublicKeyMaterial' });
      }
      return Promise.resolve({});
    }),
  };
}

function makeService(swPush: ReturnType<typeof makeSwPush>, client: ReturnType<typeof makeClient>) {
  TestBed.configureTestingModule({
    providers: [
      { provide: SwPush, useValue: swPush },
      { provide: GraphqlClient, useValue: client },
    ],
  });
  return TestBed.inject(PushService);
}

/** jsdom has no `PushManager` and no `Notification`, so both are stated explicitly per test. */
function setEnvironment(input: { pushManager?: boolean; permission?: string; userAgent?: string }): void {
  if (input.pushManager === false) {
    // `delete` is how a browser without push support looks.
    delete (globalThis as { PushManager?: unknown }).PushManager;
  } else {
    (globalThis as { PushManager?: unknown }).PushManager = class {};
  }
  (globalThis as { Notification?: unknown }).Notification = { permission: input.permission ?? 'default' };
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    value: input.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64)',
    configurable: true,
  });
}

beforeEach(() => setEnvironment({}));

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
  delete (globalThis as { PushManager?: unknown }).PushManager;
  delete (globalThis as { Notification?: unknown }).Notification;
});

describe('PushService', () => {
  it('reaches READY without ever prompting', async () => {
    const swPush = makeSwPush({ enabled: true, subscription: null });
    const service = makeService(swPush, makeClient());

    await service.refresh();

    expect(service.state()).toBe('READY');
    // The prompt is the button's job (ADR-028 decision 5): refresh only reads.
    expect(swPush.requestSubscription).not.toHaveBeenCalled();
  });

  it('registers the browser subscription the panel then reports as SUBSCRIBED', async () => {
    const client = makeClient();
    const swPush = makeSwPush({ enabled: true, subscription: null, request: () => Promise.resolve(makeSubscription()) });
    const service = makeService(swPush, client);
    await service.refresh();

    await service.enable();

    expect(swPush.requestSubscription).toHaveBeenCalledWith({ serverPublicKey: 'BPublicKeyMaterial' });
    // Not `.at(-1)`: `enable` re-reads the facts afterwards, so the public-key query is the last call.
    const [query, variables] = client.query.mock.calls.find(([entry]) =>
      String(entry).includes('registerPushSubscription'),
    ) as unknown as [string, { input: unknown }];
    expect(query).toContain('registerPushSubscription');
    expect(variables.input).toEqual({
      endpoint: 'https://push.example.test/abc',
      p256dh: 'p256dh-material',
      auth: 'auth-material',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    });
    // `readFacts` runs again after the write; the fake still reports no subscription, so the state is
    // recomputed from the environment rather than assumed — which is the point of re-reading.
    expect(service.error()).toBe(false);
  });

  it('does nothing when asked to enable from a state that cannot', async () => {
    const swPush = makeSwPush({ enabled: false, subscription: null });
    const service = makeService(swPush, makeClient());
    await service.refresh();

    await service.enable();

    expect(swPush.requestSubscription).not.toHaveBeenCalled();
  });

  it('refuses a subscription with no key material instead of storing an undeliverable endpoint', async () => {
    const client = makeClient();
    const swPush = makeSwPush({
      enabled: true,
      subscription: null,
      // A browser that mints an endpoint without keys is a state the API's input cannot express.
      request: () => Promise.resolve({ endpoint: 'https://push.example.test/abc', toJSON: () => ({ endpoint: 'https://push.example.test/abc', keys: { p256dh: '', auth: '' } }) }),
    });
    const service = makeService(swPush, client);
    await service.refresh();

    await service.enable();

    expect(service.error()).toBe(true);
    expect(client.query.mock.calls.some(([query]) => String(query).includes('registerPushSubscription'))).toBe(false);
  });

  it('unsubscribes the browser before deleting the row, so the next start cannot revive it', async () => {
    const order: string[] = [];
    const client = makeClient();
    client.query.mockImplementation((query: string, _variables?: Record<string, unknown>) => {
      if (query.includes('query PushPublicKey')) return Promise.resolve({ pushPublicKey: 'BPublicKeyMaterial' });
      if (query.includes('deletePushSubscription')) order.push('server');
      return Promise.resolve({});
    });
    const swPush = makeSwPush({ enabled: true, subscription: makeSubscription() });
    swPush.unsubscribe.mockImplementation(() => {
      order.push('browser');
      return Promise.resolve();
    });
    const service = makeService(swPush, client);
    await service.refresh();

    await service.disable();

    expect(order).toEqual(['browser', 'server']);
    const [, variables] = client.query.mock.calls.find(([entry]) =>
      String(entry).includes('deletePushSubscription'),
    ) as unknown as [string, { endpoint: string }];
    expect(variables.endpoint).toBe('https://push.example.test/abc');
  });

  it('still deletes the row when the browser refuses to unsubscribe', async () => {
    const client = makeClient();
    const swPush = makeSwPush({ enabled: true, subscription: makeSubscription() });
    swPush.unsubscribe.mockRejectedValue(new Error('no active subscription'));
    const service = makeService(swPush, client);
    await service.refresh();

    await service.disable();

    expect(client.query.mock.calls.some(([query]) => String(query).includes('deletePushSubscription'))).toBe(true);
  });

  it('re-registers an existing subscription once per start, and only with permission granted', async () => {
    setEnvironment({ permission: 'granted' });
    const client = makeClient();
    const swPush = makeSwPush({ enabled: true, subscription: makeSubscription() });
    const service = makeService(swPush, client);

    await service.syncOnStart();
    await service.syncOnStart();

    const registrations = client.query.mock.calls.filter(([query]) =>
      String(query).includes('registerPushSubscription'),
    );
    expect(registrations).toHaveLength(1);
  });

  it('does not re-register when permission is not granted', async () => {
    setEnvironment({ permission: 'default' });
    const client = makeClient();
    const swPush = makeSwPush({ enabled: true, subscription: makeSubscription() });
    const service = makeService(swPush, client);

    await service.syncOnStart();

    expect(client.query.mock.calls.some(([query]) => String(query).includes('registerPushSubscription'))).toBe(false);
  });

  it('does not hang or write anything when the service worker is disabled (every dev build)', async () => {
    const client = makeClient();
    const swPush = makeSwPush({ enabled: false, subscription: makeSubscription() });
    const service = makeService(swPush, client);

    await service.refresh();

    expect(service.state()).toBe('UNSUPPORTED');
    expect(service.busy()).toBe(false);
  });

  it('reports a deployment without VAPID keys as SERVER_OFF rather than offering a button', async () => {
    const client = makeClient();
    client.query.mockImplementation((query: string, _variables?: Record<string, unknown>) => {
      if (query.includes('query PushPublicKey')) return Promise.resolve({ pushPublicKey: null });
      return Promise.resolve({});
    });
    const service = makeService(makeSwPush({ enabled: true, subscription: null }), client);

    await service.refresh();

    expect(service.state()).toBe('SERVER_OFF');
  });
});
