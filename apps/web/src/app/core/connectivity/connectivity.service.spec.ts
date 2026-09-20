// @vitest-environment jsdom
// Reads `navigator.onLine` and listens on the window, so it needs a DOM.
import { initAngularTesting } from '@web-test/angular-testing';

import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectivityService } from './connectivity.service';

initAngularTesting();

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('ConnectivityService', () => {
  it('seeds from the browser value, because a page loaded offline never gets the event', () => {
    // The failure this guards: the service defaulted to `true` and waited for an `offline` event that a
    // page loaded *while* offline never receives — so a cold start in airplane mode claimed a network.
    const original = window.navigator.onLine;
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    try {
      const service = TestBed.inject(ConnectivityService);
      expect(service.online()).toBe(false);
    } finally {
      Object.defineProperty(window.navigator, 'onLine', { value: original, configurable: true });
    }
  });

  it('follows the online and offline events', () => {
    const service = TestBed.inject(ConnectivityService);

    window.dispatchEvent(new Event('offline'));
    expect(service.online()).toBe(false);

    window.dispatchEvent(new Event('online'));
    expect(service.online()).toBe(true);
  });

  it('reports online when there is no window to listen to', () => {
    // A spec or a non-browser renderer may provide a minimal document. That must degrade to "always
    // online" — a missing event target is not a network state.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: DOCUMENT, useValue: {} }] });

    const service = TestBed.inject(ConnectivityService);
    expect(service.online()).toBe(true);
  });
});
