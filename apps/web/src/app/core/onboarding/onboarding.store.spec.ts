// @vitest-environment jsdom
// `GraphqlClient` injects `HttpClient`, which needs the browser `DOCUMENT` — so this spec needs a DOM,
// not just the JIT compiler. The pragma has to be the file's first line for Vitest to read it.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../graphql/graphql.client';
import { OnboardingStore } from './onboarding.store';

initAngularTesting();

/**
 * The F-13 redirect's one cached fact.
 *
 * Two properties are the whole reason this is a store rather than a line in the guard:
 *
 *  - **`completedAt` decides, not an empty tree.** A household that finished onboarding and then
 *    deleted its categories is still finished. Inferring from row counts would drag it back in, which
 *    is the trap `needsOnboarding` exists to avoid on the server side too.
 *  - **It fails open.** A guard runs on every navigation; if the state cannot be read, the answer must
 *    be "no redirect". A guard that failed closed here would lock the user out over a network blip, on
 *    a screen that guards nothing.
 */
describe('OnboardingStore', () => {
  let query: ReturnType<typeof vi.fn>;

  function mount(): OnboardingStore {
    TestBed.configureTestingModule({
      providers: [{ provide: GraphqlClient, useValue: { query } as unknown as GraphqlClient }],
    });
    return TestBed.inject(OnboardingStore);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    query = vi.fn();
  });

  it('starts with no redirect, before anything is known', () => {
    const store = mount();
    expect(store.needed()).toBe(false);
    expect(store.isLoaded()).toBe(false);
  });

  it('asks for the redirect when onboarding is unfinished', async () => {
    query.mockResolvedValue({ onboardingState: { step: 3, completedAt: null } });
    const store = mount();

    await store.refresh();

    expect(store.needed()).toBe(true);
    expect(store.isLoaded()).toBe(true);
  });

  it('does NOT ask, even with no tree, once onboarding was completed', async () => {
    query.mockResolvedValue({
      onboardingState: { step: 7, completedAt: '2026-09-15T12:00:00.000Z' },
    });
    const store = mount();

    await store.refresh();

    expect(store.needed()).toBe(false);
  });

  it('does NOT ask for a step past the end, even without a timestamp', async () => {
    // The server writes both together; a half-written settings row must not re-open the wizard.
    query.mockResolvedValue({ onboardingState: { step: 7, completedAt: null } });
    const store = mount();

    await store.refresh();

    expect(store.needed()).toBe(false);
  });

  it('fails OPEN: an unreadable state means "no redirect", and it retries next time', async () => {
    query.mockRejectedValue(new Error('network down'));
    const store = mount();

    await store.refresh();

    expect(store.needed()).toBe(false);
    // Not loaded, so the next navigation tries again rather than caching a wrong answer forever.
    expect(store.isLoaded()).toBe(false);
  });

  it('stops redirecting as soon as the wizard reports completion', async () => {
    query.mockResolvedValue({ onboardingState: { step: 6, completedAt: null } });
    const store = mount();
    await store.refresh();
    expect(store.needed()).toBe(true);

    store.markComplete();

    expect(store.needed()).toBe(false);
    expect(store.isLoaded()).toBe(true);
  });
});
