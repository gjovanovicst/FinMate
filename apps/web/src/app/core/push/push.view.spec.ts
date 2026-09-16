import { describe, expect, it } from 'vitest';

import {
  isIos,
  isStandalone,
  offersEmailFallback,
  pushActionKey,
  pushMessageKey,
  pushState,
  subscriptionInput,
  type PushFacts,
} from './push.view';

/**
 * The push state machine (task 4.2.5, docs/07 §4.8).
 *
 * Every case here is one a screen could get wrong while looking fine: offering an enable button where
 * `PushManager` does not exist, telling an iPhone in a Safari tab that its browser is unsupported
 * instead of telling it to install, or claiming a device is subscribed when permission was revoked.
 */
describe('push availability', () => {
  const capable: PushFacts = {
    serviceWorkerEnabled: true,
    pushManagerSupported: true,
    serverPublicKey: 'BPublicKeyMaterial',
    permission: 'default',
    hasSubscription: false,
    ios: false,
    standalone: false,
  };

  it('is READY on a capable device with permission not yet asked', () => {
    expect(pushState(capable)).toBe('READY');
    expect(pushActionKey('READY')).toBe('notifications.push.enable');
    expect(offersEmailFallback('READY')).toBe(false);
  });

  it('is SUBSCRIBED once the browser holds a subscription, and offers only Turn off', () => {
    expect(pushState({ ...capable, permission: 'granted', hasSubscription: true })).toBe('SUBSCRIBED');
    expect(pushActionKey('SUBSCRIBED')).toBe('notifications.push.disable');
    expect(offersEmailFallback('SUBSCRIBED')).toBe(false);
  });

  it('does not promise push where the deployment has no VAPID keys', () => {
    // The server key wins over a perfectly capable device: nothing the user does would deliver one.
    expect(pushState({ ...capable, serverPublicKey: null })).toBe('SERVER_OFF');
    expect(offersEmailFallback('SERVER_OFF')).toBe(true);
    expect(pushActionKey('SERVER_OFF')).toBeNull();
  });

  it('tells iOS in a Safari tab to install, not that the browser is unsupported', () => {
    // In a tab `PushManager` is absent, so a capability-first order would report UNSUPPORTED — true,
    // and useless. docs/07 §4.8's actionable sentence is "add it to the Home Screen".
    const tab: PushFacts = { ...capable, ios: true, standalone: false, pushManagerSupported: false };
    expect(pushState(tab)).toBe('IOS_INSTALL');
    expect(pushMessageKey('IOS_INSTALL')).toBe('notifications.push.iosInstall');
    expect(offersEmailFallback('IOS_INSTALL')).toBe(true);
  });

  it('lets an installed iOS PWA through to the normal states', () => {
    const installed: PushFacts = { ...capable, ios: true, standalone: true };
    expect(pushState(installed)).toBe('READY');
    expect(pushState({ ...installed, permission: 'granted', hasSubscription: true })).toBe('SUBSCRIBED');
  });

  it('reports BLOCKED when permission was denied, even if a subscription is left over', () => {
    // Revoking permission kills the subscription; offering "Turn off" would be a control that lies.
    expect(pushState({ ...capable, permission: 'denied', hasSubscription: true })).toBe('BLOCKED');
    expect(pushActionKey('BLOCKED')).toBeNull();
    expect(offersEmailFallback('BLOCKED')).toBe(true);
  });

  it('is UNSUPPORTED without a service worker or without PushManager on a non-iOS device', () => {
    expect(pushState({ ...capable, serviceWorkerEnabled: false })).toBe('UNSUPPORTED');
    expect(pushState({ ...capable, pushManagerSupported: false })).toBe('UNSUPPORTED');
    expect(pushState({ ...capable, permission: 'unsupported' })).toBe('UNSUPPORTED');
    expect(offersEmailFallback('UNSUPPORTED')).toBe(true);
  });

  it('prefers the deployment state to device advice when push is off server-side', () => {
    // An iPhone in a tab on a server with no keys: "install it" would be an unkeepable promise.
    const facts: PushFacts = {
      ...capable,
      serverPublicKey: null,
      ios: true,
      standalone: false,
      pushManagerSupported: false,
    };
    expect(pushState(facts)).toBe('SERVER_OFF');
  });

  it('gives every state a message and at most one action', () => {
    const states = ['UNSUPPORTED', 'SERVER_OFF', 'IOS_INSTALL', 'BLOCKED', 'SUBSCRIBED', 'READY'] as const;
    for (const state of states) {
      expect(pushMessageKey(state)).toMatch(/^notifications\.push\./);
    }
    expect(states.filter((state) => pushActionKey(state) !== null)).toEqual(['SUBSCRIBED', 'READY']);
  });

  it('recognises iPadOS, which reports itself as a Mac', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 5, 'iPhone')).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5, 'MacIntel')).toBe(true);
    // A real Mac has no touch points, so it must not be mistaken for an iPad.
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0, 'MacIntel')).toBe(false);
    expect(isIos('Mozilla/5.0 (X11; Linux x86_64)', 0, 'Linux x86_64')).toBe(false);
  });

  it('treats either standalone signal as installed', () => {
    expect(isStandalone(true, false)).toBe(true);
    expect(isStandalone(false, true)).toBe(true);
    expect(isStandalone(false, false)).toBe(false);
  });
});

describe('subscription input', () => {
  it('maps a browser subscription onto the API input', () => {
    expect(
      subscriptionInput(
        { endpoint: 'https://push.example.test/1', keys: { p256dh: 'key', auth: 'secret' } },
        'agent',
      ),
    ).toEqual({ endpoint: 'https://push.example.test/1', p256dh: 'key', auth: 'secret', userAgent: 'agent' });
  });

  it('refuses a subscription with no key material rather than storing one that cannot be used', () => {
    // The API requires both keys; empty strings would store an endpoint `dispatch` counts as live.
    expect(subscriptionInput({ endpoint: 'https://push.example.test/1' }, 'agent')).toBeNull();
    expect(
      subscriptionInput({ endpoint: 'https://push.example.test/1', keys: { p256dh: 'key' } }, 'agent'),
    ).toBeNull();
    expect(
      subscriptionInput({ endpoint: '', keys: { p256dh: 'key', auth: 'secret' } }, 'agent'),
    ).toBeNull();
  });
});
