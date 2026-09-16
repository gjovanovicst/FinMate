import { describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../../config/config';
import {
  isGoneError,
  makeWebPushSender,
  RfcWebPushSender,
  UNCONFIGURED_WEB_PUSH,
  WebPushSendError,
  type WebPushSubscription,
} from './web-push-sender';

/**
 * The `WEB_PUSH` seam — ADR-028 decisions 1 and 2.
 *
 * What is asserted here is the **selection** and the error classification, which are the two things
 * the dispatch path relies on. No test sends anything: a real `sendNotification` would need a live
 * push service, and the point of the seam is that the whole path works without one.
 */
function config(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: 'postgresql://finmate:finmate@localhost:5433/finmate?schema=public',
    JWT_SECRET: 'test-secret-value-long-enough-for-validation',
    ...overrides,
  });
}

const SUBSCRIPTION: WebPushSubscription = {
  endpoint: 'https://push.example.test/subscription/abc',
  keys: { p256dh: 'public-key-material', auth: 'auth-secret' },
};

describe('the web-push sender seam (ADR-028)', () => {
  it('is inert without VAPID keys, and gives a reason a human can act on', async () => {
    const sender = makeWebPushSender(config());

    expect(sender).toBe(UNCONFIGURED_WEB_PUSH);
    expect(sender.available).toBe(false);
    expect(sender.unavailableReason).toContain('VAPID_PUBLIC_KEY');
    expect(sender.unavailableReason).toContain('VAPID_PRIVATE_KEY');
    await expect(sender.sendNotification(SUBSCRIPTION, '{}')).rejects.toBeInstanceOf(
      WebPushSendError,
    );
  });

  it('treats a half-configured key pair as none, because it could only produce rejects', () => {
    const sender = makeWebPushSender(config({ VAPID_PUBLIC_KEY: 'only-the-public-half' }));
    expect(sender.available).toBe(false);
    expect(sender.unavailableReason).not.toBeNull();
  });

  it('is configured — and never throws — once both keys are present', () => {
    const sender = makeWebPushSender(
      config({
        VAPID_PUBLIC_KEY: 'BPublicKeyMaterialForTests',
        VAPID_PRIVATE_KEY: 'PrivateKeyMaterialForTests',
        VAPID_SUBJECT: 'mailto:push@example.test',
      }),
    );

    expect(sender).toBeInstanceOf(RfcWebPushSender);
    expect(sender.available).toBe(true);
    expect(sender.unavailableReason).toBeNull();
    // No VAPID subject is a hard requirement of the protocol, so config always supplies one.
    expect(config().VAPID_SUBJECT).toBe('mailto:noreply@localhost');
  });

  it('calls a 404/410 dead and everything else a failure', () => {
    expect(isGoneError(new WebPushSendError('gone', 410))).toBe(true);
    expect(isGoneError(new WebPushSendError('gone', 404))).toBe(true);
    expect(isGoneError(new WebPushSendError('server error', 500))).toBe(false);
    expect(isGoneError(new WebPushSendError('socket', null))).toBe(false);
    expect(isGoneError(new Error('socket hang up'))).toBe(false);
    expect(isGoneError('not an error at all')).toBe(false);
  });
});
