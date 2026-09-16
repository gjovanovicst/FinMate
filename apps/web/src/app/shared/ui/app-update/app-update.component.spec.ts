// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler` before any partially compiled Angular
// package's module body runs (see `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { DOCUMENT, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwUpdate, type UnrecoverableStateEvent, type VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppUpdateComponent } from './app-update.component';

initAngularTesting();

/**
 * The app-shell update banner — ADR-024.
 *
 * What only a mounted component can prove is the **guarantee the ADR is built on**: a waiting version
 * is announced and *nothing happens* until the user asks for it. `activateUpdate()` reloads the page,
 * and a half-typed capture lives only in the DOM, so a spec that let the component activate on its own
 * would be the defect, not a missing test.
 *
 * `SwUpdate` is a stub: the real one needs a live `ServiceWorkerContainer`, which jsdom does not have.
 * A stub proves the banner's logic and nothing about `ngsw` — the built worker is verified separately
 * (docs/10 §8.3's Playwright pass does not exist yet, which is recorded in the ADR).
 */
interface Stub {
  readonly sw: {
    readonly versionUpdates: Subject<VersionEvent>;
    readonly unrecoverable: Subject<UnrecoverableStateEvent>;
    readonly activateUpdate: ReturnType<typeof vi.fn>;
  };
  readonly reload: ReturnType<typeof vi.fn>;
}

async function mount(): Promise<
  Stub & { component: AppUpdateComponent; text: () => string; flush: () => Promise<void> }
> {
  const versionUpdates = new Subject<VersionEvent>();
  const unrecoverable = new Subject<UnrecoverableStateEvent>();
  const activateUpdate = vi.fn(() => Promise.resolve(true));
  const sw = { versionUpdates, unrecoverable, activateUpdate };

  // The component reloads through the injected `DOCUMENT`, so that token is replaced with the **real**
  // document carrying one substitute: `defaultView.location`. It has to be the real one, because
  // Angular's test renderer injects `DOCUMENT` too and calls `querySelectorAll`/`createElement` on it
  // (a `{ defaultView }` stub fails every mount with "this._doc.querySelectorAll is not a function"),
  // and `defaultView` has to keep the rest of the window, since `I18nService` reads
  // `navigator.languages` from it. Reaching for `globalThis.location.reload` instead is not an option:
  // jsdom defines it non-configurably and only logs "Not implemented: navigation".
  const reload = vi.fn();
  const fakeDocument = new Proxy(document, {
    get: (target, property) => {
      if (property === 'defaultView') {
        const realWindow = target.defaultView as Window;
        return new Proxy(realWindow, {
          get: (win, prop) =>
            prop === 'location' ? { reload } : Reflect.get(win, prop, win),
        });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as Document;

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: SwUpdate, useValue: sw },
      { provide: DOCUMENT, useValue: fakeDocument },
    ],
  });

  const fixture = TestBed.createComponent(AppUpdateComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  return {
    sw,
    reload,
    component: fixture.componentInstance,
    text: () => (fixture.nativeElement as HTMLElement).textContent ?? '',
    // A signal written inside an RxJS subscription marks the OnPush view dirty; the DOM catches up on
    // the next change-detection pass, which under zoneless is not implicit in a synchronous test.
    flush: async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    },
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

describe('AppUpdateComponent (mounted)', () => {
  it('says nothing until the worker has something to say', async () => {
    const { text } = await mount();

    expect(text().trim()).toBe('');
  });

  it('ignores the events that are not a waiting version', async () => {
    const { sw, text, flush } = await mount();

    sw.versionUpdates.next({ type: 'NO_NEW_VERSION_DETECTED', version: { hash: 'aaa' } });
    sw.versionUpdates.next({ type: 'VERSION_DETECTED', version: { hash: 'bbb' } });
    sw.versionUpdates.next({
      type: 'VERSION_INSTALLATION_FAILED',
      version: { hash: 'bbb' },
      error: 'boom',
    });
    await flush();

    expect(text().trim()).toBe('');
  });

  it('announces a waiting version and does NOT activate it (ADR-024)', async () => {
    const { sw, reload, text, flush } = await mount();

    sw.versionUpdates.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'old' },
      latestVersion: { hash: 'new' },
    });
    await flush();

    expect(text()).toContain('A newer version of the app is ready.');
    // The whole point: an installed version waits for a person. No timer, no skipWaiting, no reload.
    expect(sw.activateUpdate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('activates and reloads only when the reload button is pressed', async () => {
    const { sw, reload, flush } = await mount();

    sw.versionUpdates.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'old' },
      latestVersion: { hash: 'new' },
    });
    await flush();

    const button = document.querySelector('button');
    expect(button?.textContent).toContain('Reload');
    button?.click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    expect(sw.activateUpdate).toHaveBeenCalledTimes(1);
  });

  it('says the shell is broken, and reloads rather than activating, on an unrecoverable state', async () => {
    const { sw, reload, text, flush } = await mount();

    sw.unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'missing asset' });
    await flush();
    expect(text()).toContain('Some parts of the app could not be loaded.');

    const button = document.querySelector('button');
    button?.click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    // There may be no newer version at all: a broken cache is fixed by re-installing, not by activating.
    expect(sw.activateUpdate).not.toHaveBeenCalled();
  });

  it('keeps asking when the activation is refused, instead of reloading into the same build', async () => {
    const { sw, reload, component, text, flush } = await mount();

    sw.activateUpdate.mockRejectedValueOnce(new Error('worker replaced'));
    sw.versionUpdates.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'old' },
      latestVersion: { hash: 'new' },
    });
    await flush();

    await component.activate();

    expect(reload).not.toHaveBeenCalled();
    expect(component.applying()).toBe(false);
    expect(text()).toContain('A newer version of the app is ready.');
  });
});
