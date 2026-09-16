// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting, setSignalInput } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { AiEgressEntry, ConsentKind } from '../../../core/consent/consent.view';
import { I18nService } from '../../../core/i18n/i18n.service';
import type { TranslationKey } from '../../../core/i18n/translations';
import { ConsentPurposeComponent } from '../consent-purpose/consent-purpose.component';
import { ConsentSheetComponent } from './consent-sheet.component';

initAngularTesting();

/** A route for the purpose under test; the sheet never reads it, it hands it to the card. */
const ROUTE: AiEgressEntry = {
  purpose: 'AI_DATA_PROCESSING',
  task: 'CLASSIFY',
  endpoint: 'DEEPSEEK_GLOBAL',
  provider: 'DEEPSEEK',
  region: 'NON_EEA',
  requiresConsent: true,
};

/**
 * The first-use sheet — docs/08 §6.6, task 5.2a.
 *
 * The disclosure sentences inside it belong to the purpose card and are pinned in that component's own
 * spec; this one owns the *question* — why it is being asked now, the three verbs, and the fact that the
 * verbs are the sheet's and not the card's.
 *
 * The child is deliberately opaque here (`CUSTOM_ELEMENTS_SCHEMA`, no import). The JIT test runner cannot
 * render a signal-input child inside a parent template (`setSignalInput`'s doc, docs/15), and making the
 * child opaque means this spec proves the sheet's own contract instead of accidentally re-testing the
 * card's. The price is that `[showActions]="false"` cannot be read off the DOM here — the card's spec
 * proves that input, and the sheet passes a literal `false` written once, three lines from the heading.
 */
function mount(inputs: {
  readonly kind: ConsentKind;
  readonly routes?: readonly AiEgressEntry[];
  readonly mayChange?: boolean;
  readonly saving?: boolean;
}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ConsentSheetComponent],
    providers: [provideZonelessChangeDetection()],
  });
  // The purpose card is a custom element here; see the file header. Removing the import matters — leaving
  // it in place still instantiates the real component, whose required input the JIT renderer cannot bind.
  TestBed.overrideComponent(ConsentSheetComponent, {
    remove: { imports: [ConsentPurposeComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });
  const fixture = TestBed.createComponent(ConsentSheetComponent);
  const component = fixture.componentInstance;
  setSignalInput(component, 'kind', inputs.kind);
  setSignalInput(component, 'routes', inputs.routes ?? [ROUTE]);
  setSignalInput(component, 'mayChange', inputs.mayChange ?? true);
  setSignalInput(component, 'saving', inputs.saving ?? false);

  const decided: string[] = [];
  let dismissed = 0;
  component.decide.subscribe((state) => decided.push(state));
  component.dismiss.subscribe(() => (dismissed += 1));

  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const text = (): string => root.textContent ?? '';
  const button = (label: string): HTMLButtonElement | undefined =>
    Array.from(root.querySelectorAll('button')).find((entry) => entry.textContent?.includes(label));

  return {
    fixture,
    component,
    decided,
    dismissals: () => dismissed,
    text,
    button,
    root,
    t: (key: TranslationKey) => TestBed.inject(I18nService).t(key),
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('ConsentSheetComponent', () => {
  it('asks the question, and labels the region by its own heading', () => {
    const { text, root, component, t } = mount({ kind: 'AI_DATA_PROCESSING' });

    const heading = root.querySelector('h2');
    expect(heading?.textContent).toContain(t('consent.ask.title'));
    // A region whose label is "whatever heading happens to be nearby" is not labelled at all.
    expect(root.querySelector('section')?.getAttribute('aria-labelledby')).toBe(heading?.getAttribute('id'));
    expect(heading?.getAttribute('id')).toBe('consent-ask-ai_data_processing');
    expect(component.headingId()).toBe(heading?.getAttribute('id'));
    expect(text()).toContain(t('consent.ask.title'));
  });

  it('says why it is asking now, per purpose', () => {
    const cases: readonly (readonly [ConsentKind, TranslationKey])[] = [
      ['AI_DATA_PROCESSING', 'consent.ask.whyText'],
      ['CLOUD_OCR', 'consent.ask.whyOcr'],
      ['EVAL_DATASET', 'consent.ask.whyEval'],
    ];

    for (const [kind, key] of cases) {
      const { text, t } = mount({ kind });
      expect(text()).toContain(t(key));
    }
  });

  it('carries the same never-sent and trade sentences the settings card does', () => {
    // docs/08 §6.4's list and §6.1's trade are what make the ask informed; they are asserted by key so a
    // copy change cannot silently drop one of them.
    const { text, t } = mount({ kind: 'AI_DATA_PROCESSING' });

    expect(text()).toContain(t('consent.neverSent'));
    expect(text()).toContain(t('consent.trade'));
  });

  it('delegates the disclosure rather than restating it', () => {
    const { root } = mount({ kind: 'AI_DATA_PROCESSING' });

    expect(root.querySelector('fm-consent-purpose')).not.toBeNull();
  });

  it('offers a real Decline beside Allow, plus a third answer that decides nothing', () => {
    const { button, decided, dismissals } = mount({ kind: 'AI_DATA_PROCESSING' });

    button('Allow')?.click();
    button('Decline')?.click();
    button('Not now')?.click();

    expect(decided).toEqual(['GRANTED', 'DECLINED']);
    // "Not now" is a dismissal, never a consent state: writing a row for it would be evidence of a
    // decision nobody made (the sheet's own doc).
    expect(dismissals()).toBe(1);
  });

  it('tells a Member whose decision it is, and leaves them the way out', () => {
    const { button, text, dismissals, t } = mount({ kind: 'AI_DATA_PROCESSING', mayChange: false });

    expect(text()).toContain(t('consent.ownerOnly'));
    expect(button('Allow')).toBeUndefined();
    expect(button('Decline')).toBeUndefined();
    button('Not now')?.click();
    expect(dismissals()).toBe(1);
  });

  it('disables all three answers while a decision is in flight', () => {
    const { button } = mount({ kind: 'AI_DATA_PROCESSING', saving: true });

    expect(button('Allow')?.disabled).toBe(true);
    expect(button('Decline')?.disabled).toBe(true);
    expect(button('Not now')?.disabled).toBe(true);
  });

  it('names the purpose it is asking about', () => {
    // The heading is the shared question; the purpose's own name is what tells three sheets apart.
    const { component } = mount({ kind: 'CLOUD_OCR' });
    expect(component.nameKey()).toBe('consent.kind.CLOUD_OCR.name');
  });
});
