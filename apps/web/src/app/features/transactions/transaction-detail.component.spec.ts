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

    const remember = m.root.querySelector<HTMLInputElement>('input[formcontrolname="remember"]')!;
    remember.click();
    m.fixture.detectChanges();

    expect(m.component.hasUnsaved()).toBe(false);
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
