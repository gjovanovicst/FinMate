import { describe, expect, it } from 'vitest';

import {
  ALLOWED_MIME_TYPES,
  MAX_BYTE_SIZE,
  clientHeaders,
  extensionFor,
  storageKeyFor,
  validatePresignInput,
} from './files.service';

/** A valid request the boundary tests perturb one field at a time. */
const valid = {
  purpose: 'RECEIPT',
  mimeType: 'image/jpeg',
  byteSize: 2_481_632,
  sha256: '9f2c'.padEnd(64, '0'),
} as const;

describe('validatePresignInput', () => {
  it('accepts every allowlisted type at the size ceiling', () => {
    for (const mimeType of ALLOWED_MIME_TYPES) {
      expect(validatePresignInput({ ...valid, mimeType })).toBeNull();
    }
    expect(validatePresignInput({ ...valid, byteSize: MAX_BYTE_SIZE })).toBeNull();
  });

  it('refuses a type, a size and a hash the storage could not honour', () => {
    expect(validatePresignInput({ ...valid, mimeType: 'image/gif' })).toMatch(/Unsupported file type/);
    // The ceiling is exclusive: one byte over is a phone photo the product cannot store.
    expect(validatePresignInput({ ...valid, byteSize: MAX_BYTE_SIZE + 1 })).toMatch(/limit is/);
    expect(validatePresignInput({ ...valid, byteSize: 0 })).toMatch(/positive whole number/);
    expect(validatePresignInput({ ...valid, byteSize: 1.5 })).toMatch(/positive whole number/);
    expect(validatePresignInput({ ...valid, purpose: 'NOPE' })).toMatch(/Unknown purpose/);
  });

  it('requires a real lower-case hex sha256, because it is matched literally', () => {
    expect(validatePresignInput({ ...valid, sha256: '9F2C'.padEnd(64, '0') })).toMatch(/lower-case/);
    expect(validatePresignInput({ ...valid, sha256: 'abc' })).toMatch(/64 lower-case/);
    expect(validatePresignInput({ ...valid, sha256: 'z'.repeat(64) })).toMatch(/64 lower-case/);
  });
});

describe('extensionFor', () => {
  it('names the extension a key carries, and never guesses beyond the allowlist', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/heic')).toBe('heic');
    expect(extensionFor('image/webp')).toBe('webp');
    expect(extensionFor('application/pdf')).toBe('pdf');
  });
});

describe('storageKeyFor', () => {
  it('scopes the key to the Household and makes it unguessable', () => {
    const first = storageKeyFor('h-1', 'image/jpeg');
    const second = storageKeyFor('h-1', 'image/jpeg');
    expect(first).toMatch(/^household\/h-1\/[0-9a-f-]{36}\.jpg$/);
    // Two uploads of the same bytes must not collide: the suffix is random, not derived from content.
    expect(first).not.toBe(second);
  });
});

describe('clientHeaders', () => {
  it('drops host, which the runtime sets, and keeps every signed header', () => {
    expect(
      clientHeaders({
        host: 'localhost:9000',
        'content-type': 'image/jpeg',
        'x-amz-meta-sha256': valid.sha256,
      }),
    ).toEqual({ 'content-type': 'image/jpeg', 'x-amz-meta-sha256': valid.sha256 });
  });
});
