// @vitest-environment jsdom
// FIRST import, deliberately: the JIT compiler must be loaded before the testing module is used.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { I18nService } from '../i18n/i18n.service';
import { ErrorMessageService } from './error-message.service';

initAngularTesting();

/**
 * What the user is told when something fails (task reported by the human: signing in against a dev
 * API that was not running showed *"Something went wrong. Please try again."*, which is neither true
 * — retrying cannot help — nor actionable).
 *
 * The distinction this pins: an API **code** is localised by code, a transport failure gets its own
 * message, and anything unrecognised still says something truthful rather than blank.
 */
describe('ErrorMessageService', () => {
  let errors: ErrorMessageService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [I18nService] });
    errors = TestBed.inject(ErrorMessageService);
  });

  it('localises a typed API code by code, not by the server message', () => {
    // The server's message is English and the client is what knows the reader's language.
    expect(errors.for({ code: 'UNAUTHENTICATED', message: 'Invalid credentials' })).toBe(
      'Incorrect email or password.',
    );
    expect(errors.for({ status: 409, error: { error: { code: 'RATE_LIMITED' } } })).toBe(
      'Too many attempts. Please try again in a few minutes.',
    );
  });

  it('says the server is unreachable when the request never arrived', () => {
    // Angular reports status 0 for a failed request; a proxy with no upstream answers 502/503/504.
    // None of these have an API code, and "please try again" would be a lie.
    for (const status of [0, 502, 503, 504]) {
      expect(errors.for({ status, message: 'Http failure response for /api/auth/login: 0 Unknown Error' }))
        .toBe('The server is not reachable. Check your connection and try again.');
    }
  });

  it('does NOT claim unreachability for a real API error', () => {
    // 401/500 came from the API, so the connection is fine and the code path must win.
    expect(errors.for({ status: 401, error: { error: { code: 'UNAUTHENTICATED' } } })).toBe(
      'Incorrect email or password.',
    );
    // A 500 with a readable message shows it (the API never returns internals); one without falls
    // back to the generic sentence rather than to the unreachable one.
    expect(errors.for({ status: 500, message: 'Internal error' })).toBe(
      'Something went wrong. Please try again.',
    );
    expect(errors.for(Object.assign(new Error('Internal error'), { status: 500 }))).toBe('Internal error');
  });

  it('falls back to the server message, then to the generic one', () => {
    expect(errors.for(new Error('Projected over the limit'))).toBe('Projected over the limit');
    // Angular's own transport text is not user-facing, so it must not leak into the banner.
    expect(errors.for(new Error('Http failure response for /api/x: 0 Unknown Error'))).toBe(
      'Something went wrong. Please try again.',
    );
    expect(errors.for(new Error(''))).toBe('Something went wrong. Please try again.');
    expect(errors.for(null)).toBe('Something went wrong. Please try again.');
  });
});
