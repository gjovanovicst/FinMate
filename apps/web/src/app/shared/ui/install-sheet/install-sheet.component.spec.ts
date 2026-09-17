// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting, setSignalInput } from '@web-test/angular-testing';

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { InstallPromptKind } from '../../../core/install/install.view';
import { InstallSheetComponent } from './install-sheet.component';

initAngularTesting();

/**
 * The Add-to-Home-Screen sheet — docs/07 §4.7, task 4.3.2b.
 *
 * What is asserted here is the difference between the two platforms, because it is the difference
 * between a button that installs and a button that would have to lie: Chromium gets a real *Install*
 * verb plus *Not now*, iOS gets the three Share steps and a single *Got it*. It is also the only place
 * that can read the copy, which DoD requires to come from the catalogue rather than the template.
 */
function mount(inputs: { kind: InstallPromptKind; busy?: boolean; failed?: boolean }) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InstallSheetComponent],
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(InstallSheetComponent);
  const component = fixture.componentInstance;
  setSignalInput(component, 'kind', inputs.kind);
  setSignalInput(component, 'busy', inputs.busy ?? false);
  setSignalInput(component, 'failed', inputs.failed ?? false);

  let installs = 0;
  let dismissals = 0;
  component.install.subscribe(() => (installs += 1));
  component.dismiss.subscribe(() => (dismissals += 1));

  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const text = (): string => root.textContent ?? '';
  const button = (label: string): HTMLButtonElement | undefined =>
    Array.from(root.querySelectorAll('button')).find((entry) => entry.textContent?.includes(label));

  return {
    fixture,
    text,
    button,
    installs: () => installs,
    dismissals: () => dismissals,
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('InstallSheetComponent', () => {
  it('offers Chromium a real install button and a way out', () => {
    const sheet = mount({ kind: 'NATIVE' });

    expect(sheet.text()).toContain('Install FinMate');
    // docs/07 §4.7's honest CTA, verbatim in the catalogue's Serbian too.
    expect(sheet.text()).toContain('Add it to the Home Screen — and you get notifications.');

    sheet.button('Install')?.click();
    expect(sheet.installs()).toBe(1);

    sheet.button('Not now')?.click();
    expect(sheet.dismissals()).toBe(1);
  });

  it('gives iOS the three steps and no button that claims to have installed anything', () => {
    const sheet = mount({ kind: 'IOS_INSTRUCTIONS' });

    expect(sheet.text()).toContain('Add FinMate to the Home Screen');
    // The steps, in order, because that is the whole mechanism Safari offers.
    expect(sheet.text()).toContain('Tap Share in the Safari toolbar.');
    expect(sheet.text()).toContain('Choose “Add to Home Screen”.');
    expect(sheet.text()).toContain('Tap “Add”.');
    // There is no install API on iOS: an *Install* verb here would be a control that cannot work
    // (docs/02 §2), so the only verb is the acknowledgement.
    expect(sheet.button('Install')).toBeUndefined();
    expect(sheet.installs()).toBe(0);

    sheet.button('Got it')?.click();
    expect(sheet.dismissals()).toBe(1);
  });

  it('labels the region by its own heading, so it is announced rather than crossing the page', () => {
    const sheet = mount({ kind: 'NATIVE' });
    const section = (sheet.fixture.nativeElement as HTMLElement).querySelector('[role="region"]');
    const heading = section?.getAttribute('aria-labelledby');

    expect(heading).toBe('install-sheet-title');
    expect(section?.querySelector(`#${heading}`)?.textContent).toContain('Install FinMate');
  });

  it('says the browser refused, instead of closing and pretending', () => {
    const sheet = mount({ kind: 'NATIVE', failed: true });

    expect(sheet.text()).toContain('The browser did not open its install prompt');
    const alert = (sheet.fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
  });

  it('holds both verbs while the browser is prompting', () => {
    const sheet = mount({ kind: 'NATIVE', busy: true });

    expect(sheet.text()).toContain('Opening…');
    expect(sheet.button('Opening…')?.disabled).toBe(true);
    expect(sheet.button('Not now')?.disabled).toBe(true);
  });
});
