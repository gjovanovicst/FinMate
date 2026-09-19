// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting, setSignalInput } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { ReceiptAttachmentComponent } from '../receipts/receipt-attachment.component';
import { TransactionDetailComponent } from './transaction-detail.component';
import { DRAG_DISMISS_PX } from '../../shared/ui/sheet-drag';

initAngularTesting();

/**
 * The edit sheet, mounted — task 4.3.1b.
 *
 * This is the first spec to mount it at all: `transactions.component.spec.ts` replaces it with a custom
 * element (the JIT signal-input limitation, docs/15 §9), so until now its own behaviour — including the
 * dirty guard added here — had no component-level test.
 *
 * **What a jsdom spec can and cannot see here**, because the line is unusually sharp:
 *
 *  - jsdom implements **no `<dialog>` at all** — `showModal` and `close` are `undefined` — and Angular's
 *    JIT does not discover `viewChild()` signal queries either (NG0951), so the component's `dialog()`
 *    never resolves under test. Both are recorded in docs/15 §9.
 *  - So this spec asserts the **decision** — `close()` is spied on, and every dismissal route is checked
 *    for whether it reached it and whether it asked first — while the platform half (`close()` really
 *    firing the `close` event, and the sheet really sliding under a finger) is verified live in a browser.
 *    That split is deliberate: the decision is what loses data when it is wrong, and it is what a
 *    regression would change.
 */
const ROW = {
  id: 'tx-9',
  kind: 'EXPENSE' as const,
  status: 'CONFIRMED' as const,
  amount: { amountMinor: '200000', currency: 'RSD' },
  description: 'Lidl',
  note: null,
  occurredAt: '2026-09-20T10:00:00.000Z',
  occurredLocalDate: '2026-09-20',
  categoryId: 'c1',
  accountId: 'a1',
  needsReview: false,
  attachmentId: null,
  version: 1,
  splits: [],
};

const CATEGORIES = [
  { id: 'c1', name: 'Hrana', kind: 'EXPENSE' as const, path: ['Hrana'] },
  { id: 'c2', name: 'Auto', kind: 'EXPENSE' as const, path: ['Auto'] },
];

function mount(query = vi.fn(() => Promise.resolve({}))) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TransactionDetailComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: GraphqlClient, useValue: { query } },
    ],
  });
  // `fm-money` and the attachment panel are custom elements here; see the file header.
  TestBed.overrideComponent(TransactionDetailComponent, {
    remove: { imports: [MoneyComponent, ReceiptAttachmentComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });
  const fixture = TestBed.createComponent(TransactionDetailComponent);
  setSignalInput(fixture.componentInstance, 'transaction', ROW);
  setSignalInput(fixture.componentInstance, 'categories', CATEGORIES);
  fixture.detectChanges();

  let closedCount = 0;
  fixture.componentInstance.closed.subscribe(() => (closedCount += 1));
  // The one platform gap the spec has to step around: `dialog()` cannot resolve under jsdom, so the
  // decision to close is observed instead of the close itself (see the file header).
  const close = vi
    .spyOn(fixture.componentInstance as unknown as { close: () => void }, 'close')
    // Replaced, not wrapped: the real one calls `dialog().close()`, and jsdom has no `<dialog>`. What is
    // under test is whether the decision reached the close, which the live pass then completes.
    .mockImplementation(() => undefined);
  const root = fixture.nativeElement as HTMLElement;
  const text = (): string => root.textContent ?? '';
  const button = (label: string): HTMLButtonElement | undefined =>
    Array.from(root.querySelectorAll('button')).find((entry) => entry.textContent?.includes(label));
  /**
   * Esc on a native dialog: `cancel` fires first and the dialog closes unless the handler prevents it.
   * Returns whether the close was prevented, which is the component's half of the contract; the browser
   * refusing to close is what the live pass checks.
   */
  const pressEscape = (): boolean => {
    const event = new Event('cancel', { cancelable: true });
    fixture.componentInstance.onCancel(event);
    if (!event.defaultPrevented) fixture.componentInstance.onClose();
    fixture.detectChanges();
    return event.defaultPrevented;
  };

  return {
    fixture,
    component: fixture.componentInstance,
    close,
    closed: () => closedCount,
    text,
    button,
    pressEscape,
    root,
  };
}

/** Type into a control the way a user does, so Angular marks the form touched/dirty itself. */
function type(fixture: ReturnType<typeof mount>['fixture'], selector: string, value: string): void {
  const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`no control ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

/** Choose a category from the select, the way the sheet's own picker does. */
function choose(fixture: ReturnType<typeof mount>['fixture'], categoryId: string): void {
  const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>(
    'select[formcontrolname="categoryId"]',
  );
  if (select === null) throw new Error('no category select');
  select.value = categoryId;
  select.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

afterEach(() => TestBed.resetTestingModule());

describe('TransactionDetailComponent — the dirty guard (docs/07 §4.2)', () => {
  it('closes straight away while nothing has been edited', () => {
    const m = mount();

    expect(m.component.hasUnsaved()).toBe(false);
    expect(m.root.querySelector('[role="alertdialog"]')).toBeNull();

    // Esc is not prevented, so the browser closes the dialog; the component's half of that contract is
    // reacting to the `close` event, which is what `closed` reports.
    expect(m.pressEscape()).toBe(false);
    expect(m.closed()).toBe(1);
    expect(m.component.confirmingDiscard()).toBe(false);
  });

  it('refuses Esc when a money field is dirty, and asks instead', () => {
    const m = mount();
    type(m.fixture, 'input[formcontrolname="description"]', 'Lidl mesec');

    expect(m.component.hasUnsaved()).toBe(true);
    m.pressEscape();

    // The dialog stays open — that is the whole point: `close()` would take the form with it.
    expect(m.close).not.toHaveBeenCalled();
    expect(m.text()).toContain('Discard your changes?');
    expect(m.root.querySelector('[role="alertdialog"]')).not.toBeNull();
  });

  it('guards the close button through the same path as Esc', () => {
    const m = mount();
    type(m.fixture, 'input[formcontrolname="description"]', 'Lidl mesec');

    m.button('Close')?.click();
    m.fixture.detectChanges();

    expect(m.close).not.toHaveBeenCalled();
    expect(m.component.confirmingDiscard()).toBe(true);
  });

  it('lets "Discard changes" lose the edit, and "Keep editing" keep it', () => {
    const m = mount();
    type(m.fixture, 'input[formcontrolname="description"]', 'Lidl mesec');
    m.pressEscape();

    m.button('Keep editing')?.click();
    m.fixture.detectChanges();
    expect(m.component.confirmingDiscard()).toBe(false);
    expect(m.close).not.toHaveBeenCalled();

    m.pressEscape();
    m.button('Discard changes')?.click();
    m.fixture.detectChanges();
    expect(m.close).toHaveBeenCalledTimes(1);
    // The confirm must not outlive its answer, or a reopened sheet would start mid-question.
    expect(m.component.confirmingDiscard()).toBe(false);
  });

  it('counts a half-typed amount as unsaved, which is the case the guard exists for', () => {
    // `planEdit` compares a *parsed* amount, so `12,` reads as unchanged there; this must not.
    const m = mount();
    type(m.fixture, 'input[formcontrolname="amount"]', '12,');

    expect(m.component.hasUnsaved()).toBe(true);
    expect(m.pressEscape()).toBe(true);
    expect(m.close).not.toHaveBeenCalled();
  });

  it('does not count the "remember" checkbox as unsaved', () => {
    // It is not part of the record, only a modifier of the save (docs/04 §8.2) — dismissing loses the
    // intent to also teach a rule, nothing else. A prompt here would be noise on a clean row.
    const m = mount();
    type(m.fixture, 'input[formcontrolname="description"]', 'Lidl');
    expect(m.component.hasUnsaved()).toBe(false);

    // The tick is only offered once the category differs from the stored one (it can be honoured only
    // then), so enabling it takes a category change — which is then put back, leaving the tick as the
    // only difference. That is the state this asserts about.
    choose(m.fixture, 'c2');
    const remember = m.root.querySelector<HTMLInputElement>('input[formcontrolname="remember"]')!;
    remember.click();
    m.fixture.detectChanges();
    expect(m.component.hasUnsaved()).toBe(true);

    choose(m.fixture, 'c1');
    expect(m.component.hasUnsaved()).toBe(false);
  });
});

/**
 * The learning loop's entry point in this sheet (F-09, ADR-010).
 *
 * Three things were silent here and all three read as "the tick does not work": a tick with no category
 * change (nothing to learn from, and the save never reached the correction at all), a tick whose
 * correction derived no rule (the sheet closed as if it had), and a proposal rendered at the end of the
 * scrolling body, where a second press of Save discarded it.
 */
describe('TransactionDetailComponent — "Zapamti za buduće"', () => {
  /** A correction with a rule already created, a proposal to answer, or nothing derivable at all. */
  function correctionResponse(
    correction: Record<string, unknown>,
    rule: Record<string, unknown> | null,
  ) {
    return { correctTransaction: { transaction: { id: ROW.id, version: 2 }, correction, ruleConflicts: [], synthesisedRule: rule } };
  }

  it('offers the tick only once the category differs from the stored one', () => {
    const m = mount();

    // Nothing changed: the tick could not be honoured, so it is not offered — and the sheet says why
    // rather than leaving a dead control (docs/02 §2). `/review` gates its own copy the same way.
    expect(m.root.querySelector('input[formcontrolname="remember"]')).toBeNull();
    expect(m.text()).toContain('Change the category and the app can learn a rule from it');

    choose(m.fixture, 'c2');

    expect(m.root.querySelector('input[formcontrolname="remember"]')).not.toBeNull();
    expect(m.text()).toContain('Remember this for next time');
    // And the explanation of what the tick will do comes back with it.
    expect(m.text()).toContain('The app learns a rule from the change above');
  });

  it('keeps the sheet open when a ticked correction has nothing to derive a rule from', async () => {
    // `captureParse` on `kupovina 500` after a correction: no merchant, no person, no distinctive word.
    // Verified live against the API, where the mutation answers `ruleCreatedId: null` and
    // `synthesisedRule: null` — the case the sheet used to close on exactly like a success.
    const query = vi.fn((document: string) => {
      if (document.includes('CorrectTransaction')) {
        return Promise.resolve(correctionResponse({ id: 'cor-1', ruleCreatedId: null }, null));
      }
      return Promise.resolve({ updateTransaction: { id: ROW.id, version: 2 } });
    });
    const m = mount(query);

    choose(m.fixture, 'c2');
    m.root.querySelector<HTMLInputElement>('input[formcontrolname="remember"]')!.click();
    m.fixture.detectChanges();
    await m.component.save();
    m.fixture.detectChanges();

    expect(m.component.unlearnable()).toBe(true);
    expect(m.close).not.toHaveBeenCalled();
    expect(m.text()).toContain('Nothing to remember from this one');
    // The way to get the rule anyway, and no false "discard your changes?" on the way out.
    expect(m.button('Rules') ?? m.root.querySelector('a[href="/rules"]')).toBeTruthy();
    expect(m.component.hasUnsaved()).toBe(false);
  });

  it('pins a proposal outside the scrolling body, so it cannot be missed', async () => {
    const proposal = {
      name: 'Naučeno: repro → Hrana',
      priority: 100,
      conditions: { all: [{ field: 'text', op: 'contains', value: 'repro' }] },
      actions: { setCategoryId: 'c2' },
      origin: 'LEARNED',
      explanation: 'Everything with this word goes here.',
      explanationCode: 'RULE_SYNTH_TOKEN',
      trigger: 'DISTINCTIVE_TOKEN',
      confidence: 0.9,
    };
    const query = vi.fn((document: string) => {
      if (document.includes('CorrectTransaction')) {
        return Promise.resolve(correctionResponse({ id: 'cor-2', ruleCreatedId: null }, proposal));
      }
      return Promise.resolve({ updateTransaction: { id: ROW.id, version: 2 } });
    });
    const m = mount(query);

    choose(m.fixture, 'c2');
    m.root.querySelector<HTMLInputElement>('input[formcontrolname="remember"]')!.click();
    m.fixture.detectChanges();
    await m.component.save();
    m.fixture.detectChanges();

    // The prompt stays, and it is **not** inside the sheet's scrollable body: the body's scroll
    // position is what hid it, and a second Save then discarded the proposal.
    expect(m.close).not.toHaveBeenCalled();
    const prompt = m.root.querySelector('.proposal--pinned');
    expect(prompt).not.toBeNull();
    expect(prompt?.closest('.sheet__body')).toBeNull();
    expect(m.text()).toContain('Remember this?');
  });
});

describe('TransactionDetailComponent — swipe-to-dismiss', () => {
  const pointer = (overrides: Record<string, unknown> = {}): PointerEvent =>
    ({ pointerType: 'touch', isPrimary: true, clientY: 0, pointerId: 1, ...overrides }) as PointerEvent;

  it('follows a downward drag and springs back on a short one', () => {
    const m = mount();

    m.component.onDragStart(pointer({ clientY: 100 }));
    m.component.onDragMove(pointer({ clientY: 140 }));
    expect(m.component.dragOffsetPx()).toBe(40);

    m.component.onDragEnd(pointer({ clientY: 140 }));
    expect(m.component.dragOffsetPx()).toBe(0);
    expect(m.close).not.toHaveBeenCalled();
  });

  it('goes through the guard on a dismissal-length drag', () => {
    const m = mount();
    type(m.fixture, 'input[formcontrolname="description"]', 'Lidl mesec');

    m.component.onDragStart(pointer({ clientY: 100 }));
    m.component.onDragEnd(pointer({ clientY: 100 + DRAG_DISMISS_PX }));

    // A flick over an edited row asks; the gesture is not a way around the guard.
    expect(m.close).not.toHaveBeenCalled();
    expect(m.component.confirmingDiscard()).toBe(true);
    // And the sheet is back in place rather than left half-off the screen behind the question.
    expect(m.component.dragOffsetPx()).toBe(0);
  });

  it('closes a clean sheet on a dismissal-length drag', () => {
    const m = mount();

    m.component.onDragStart(pointer({ clientY: 100 }));
    m.component.onDragEnd(pointer({ clientY: 100 + DRAG_DISMISS_PX }));

    expect(m.close).toHaveBeenCalledTimes(1);
  });

  it('ignores a mouse drag and a secondary pointer', () => {
    // The desktop route is the button or Esc; a mouse drag inside a form is a text selection.
    const m = mount();

    m.component.onDragStart(pointer({ pointerType: 'mouse', clientY: 100 }));
    m.component.onDragMove(pointer({ pointerType: 'mouse', clientY: 300 }));
    expect(m.component.dragOffsetPx()).toBe(0);

    m.component.onDragStart(pointer({ isPrimary: false, clientY: 100 }));
    m.component.onDragMove(pointer({ isPrimary: false, clientY: 300 }));
    expect(m.component.dragOffsetPx()).toBe(0);
  });
});
