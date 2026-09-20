import { describe, expect, it } from 'vitest';

import { qrDataUrl } from './qr';

/**
 * The QR encoder behind the authenticator setup (ADR-042).
 *
 * Tested as a **function**, not by mounting the component: the JIT test harness cannot bind a signal
 * input from a parent template, so a mounted test would prove the workaround rather than the
 * encoding. What matters is that the URI reaches `qrcode-generator` and a real image comes back —
 * the shapes of the code are the library's own subject.
 */
describe('qrDataUrl', () => {
  const URI = 'otpauth://totp/FinMate:a%40b.c?secret=JBSWY3DPEHPK3PXP&issuer=FinMate&digits=6&period=30';

  it('renders a URI as an image data URL', () => {
    const dataUrl = qrDataUrl(URI);
    expect(dataUrl).toMatch(/^data:image\//);
    // Longer than a few hundred bytes: an actual image rather than a placeholder.
    expect(dataUrl.length).toBeGreaterThan(200);
  });

  it('produces a different image for a different secret', () => {
    expect(qrDataUrl(URI)).not.toBe(
      qrDataUrl('otpauth://totp/FinMate:a%40b.c?secret=AAAAAAAA&issuer=FinMate'),
    );
  });

  it('renders nothing for an empty URI, rather than a QR of nothing', () => {
    expect(qrDataUrl('')).toBe('');
  });
});
