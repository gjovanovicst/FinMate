// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and the partially compiled Angular
// packages used below need the JIT compiler to already be present (see `capture.component.spec.ts`).
import { initAngularTesting, setSignalInput } from '@web-test/angular-testing';

import {
  CUSTOM_ELEMENTS_SCHEMA,
  provideZonelessChangeDetection,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { ReceiptDetailComponent } from './receipt-detail.component';

initAngularTesting();

/**
 * The mismatch screen, mounted.
 *
 * The decisions live in `receipts.view.spec.ts`; what a *rendered* component proves is the wiring —
 * that the banner states the **exact difference in money** and never a percentage, that the post
 * button is disabled by the two API gates with the reason said out loud, that the confidence badge
 * shows its icon *and* its words, that a reconcile is sent with the **absolute** total rather than a
 * delta, and that a refused commit shows an error instead of a success.
 *
 * `fm-money` is a custom element here for the reason recorded in the other component specs: its
 * `amount` input is required and JIT cannot register signal inputs, so the element's own `amount`
 * property is what the assertions read.
 *
 * ## Why {@link setSignalInput} exists
 *
 * The `id` input arrives from the route in the real app (`withComponentInputBinding`), but Angular's
 * JIT compiler cannot discover `input()` signal inputs, so `ComponentRef.setInput` warns `NG0303`,
 * writes nothing, and reading the input then throws `NG0950`. The value is written onto the input's
 * own signal node here instead. Test-only shim code, which is why it is a named function.
 */

type Fixture = ReturnType<typeof TestBed.createComponent<ReceiptDetailComponent>>;


const CATEGORIES = [
  { id: 'c1', name: 'Hrana', kind: 'EXPENSE', path: ['Hrana'] },
  { id: 'c2', name: 'Higijena', kind: 'EXPENSE', path: ['Kuća', 'Higijena'] },
  { id: 'c3', name: 'Plata', kind: 'INCOME', path: ['Plata'] },
];

/** A mismatch: the receipt claims 2 050,00 and the lines add up to 2 000,00. */
const MISMATCH = {
  id: 'r1',
  capturedAt: '2026-10-12T10:00:00.000Z',
  reconciliation: 'MISMATCH',
  total: { amountMinor: '205000', currency: 'RSD' },
  itemsTotal: { amountMinor: '200000', currency: 'RSD' },
  variance: { amountMinor: '5000', currency: 'RSD' },
  attachmentId: 'att-1',
  transactionId: null,
  ocrConfidence: null,
  items: [
    { id: 'i1', lineNo: 1, rawText: 'Meso', amount: { amountMinor: '80000', currency: 'RSD' }, categoryId: 'c1', confidence: 0.95, needsReview: false },
    { id: 'i2', lineNo: 2, rawText: 'Šampon', amount: { amountMinor: '50000', currency: 'RSD' }, categoryId: 'c2', confidence: 0.7, needsReview: false },
    { id: 'i3', lineNo: 3, rawText: 'Nepoznato', amount: { amountMinor: '70000', currency: 'RSD' }, categoryId: null, confidence: 0.2, needsReview: true },
    { id: 'i4', lineNo: 4, rawText: 'Bez predloga', amount: { amountMinor: '1000', currency: 'RSD' }, categoryId: null, confidence: null, needsReview: true },
  ],
};

/** The same lines, reconciled and fully categorised: the only state *Napravi transakciju* accepts. */
const MATCHED = {
  ...MISMATCH,
  reconciliation: 'MATCHED',
  itemsTotal: { amountMinor: '205000', currency: 'RSD' },
  variance: { amountMinor: '0', currency: 'RSD' },
  items: MISMATCH.items.map((item) => ({ ...item, categoryId: item.categoryId ?? 'c1', needsReview: false })),
};

interface Mounted {
  readonly fixture: Fixture;
  readonly client: { readonly query: ReturnType<typeof vi.fn> };
  /** Every `reconcileReceipt` call's variables, in order. */
  readonly reconciles: Record<string, unknown>[];
  /** Every `extractReceipt` call's variables, in order. */
  readonly extracts: Record<string, unknown>[];
}

/** What `extractReceipt` answers, as ADR-037's screen has to handle it. */
interface ExtractFixture {
  readonly extracted: boolean;
  readonly itemsWritten: number;
  readonly reason: string | null;
  readonly linesWithoutAmount: number;
}

/** The Receipt as the mock serves it — loose on the wire shapes, strict on the fields the screen reads. */
interface ReceiptFixture {
  readonly id: string;
  readonly capturedAt: string;
  readonly reconciliation: string;
  readonly total: unknown;
  readonly itemsTotal: unknown;
  readonly variance: unknown;
  readonly attachmentId: string | null;
  readonly transactionId: string | null;
  readonly ocrConfidence: number | null;
  readonly items: readonly unknown[];
}

async function mount(
  options: {
    readonly receipt?: ReceiptFixture;
    readonly failCommit?: boolean;
    /** What the reader answers. The default is the shipped deployment: no provider configured. */
    readonly extract?: ExtractFixture;
  } = {},
): Promise<Mounted> {
  const reconciles: Record<string, unknown>[] = [];
  const extracts: Record<string, unknown>[] = [];
  // Mutable so a successful commit is reflected by the next read: the server would return the link,
  // and a mock that kept returning `transactionId: null` would test a state the API cannot produce.
  let receipt: ReceiptFixture = options.receipt ?? MISMATCH;

  const client = {
    query: vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('query Receipt')) return Promise.resolve({ receipt });
      if (query.includes('query Taxonomy')) {
        return Promise.resolve({
          accounts: { edges: [{ node: { id: 'a1', name: 'Kartica', currency: 'RSD' } }] },
          categories: CATEGORIES,
        });
      }
      if (query.includes('query Attachment')) {
        return Promise.resolve({
          attachment: {
            id: 'att-1',
            downloadUrl: 'https://storage.test/att-1.jpg',
            scanState: 'SKIPPED',
          },
        });
      }
      if (query.includes('mutation Reconcile')) {
        reconciles.push(variables ?? {});
        return Promise.resolve({ reconcileReceipt: { id: 'r1' } });
      }
      if (query.includes('mutation CommitReceipt')) {
        if (options.failCommit === true) return Promise.reject(new Error('boom'));
        receipt = { ...receipt, transactionId: 'tx-9', reconciliation: 'MATCHED' };
        return Promise.resolve({
          commitReceipt: { id: 'r1', transactionId: 'tx-9', reconciliation: 'MATCHED' },
        });
      }
      if (query.includes('mutation ExtractReceipt')) {
        extracts.push(variables ?? {});
        const answer = options.extract ?? {
          extracted: false,
          itemsWritten: 0,
          reason: 'AI_UNAVAILABLE:no-provider-configured',
          linesWithoutAmount: 0,
        };
        if (answer.extracted) {
          // The server wrote lines, so the next read has to show them: a count on screen with no rows
          // under it is exactly the lie this screen would tell if the refresh were skipped.
          receipt = {
            ...receipt,
            items: [
              ...receipt.items,
              {
                id: 'i9',
                lineNo: 5,
                rawText: 'Kafa',
                amount: { amountMinor: '18000', currency: 'RSD' },
                categoryId: 'c1',
                confidence: 0.88,
                needsReview: false,
              },
            ],
          };
        }
        return Promise.resolve({ extractReceipt: answer });
      }
      if (query.includes('mutation AddItem')) return Promise.resolve({ addReceiptItem: { id: 'r1' } });
      if (query.includes('mutation UpdateItem')) {
        return Promise.resolve({ updateReceiptItem: { id: 'r1' } });
      }
      if (query.includes('mutation RemoveItem')) {
        return Promise.resolve({ removeReceiptItem: { id: 'r1' } });
      }
      return Promise.resolve({});
    }),
  };

  TestBed.configureTestingModule({
    imports: [ReceiptDetailComponent],
    providers: [
      provideZonelessChangeDetection(),
      // `RouterLink` is in the template (the back link and the posted transaction).
      provideRouter([]),
      { provide: GraphqlClient, useValue: client },
    ],
  });

  // `fm-money` is a custom element here; see the file header.
  // `fm-icon` joins `fm-money` in the removal list for the reason `@web-test/angular-testing` documents:
  // the JIT runner cannot bind a signal input from a parent template, so a mounted child with a required
  // `name` throws NG0950 before the component renders.
  TestBed.overrideComponent(ReceiptDetailComponent, {
    remove: { imports: [MoneyComponent, IconComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(ReceiptDetailComponent);
  setSignalInput(fixture.componentInstance, 'id', 'r1');
  await settle(fixture);
  return { fixture, client, reconciles, extracts };
}

async function settle(fixture: Fixture): Promise<void> {
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
}

function root(fixture: Fixture): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function text(fixture: Fixture): string {
  return root(fixture).textContent ?? '';
}

function button(fixture: Fixture, label: string): HTMLButtonElement {
  const found = Array.from(root(fixture).querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`No button labelled "${label}".`);
  return found;
}

/** The Money handed to the banner's `fm-money`, or `null` when the banner has none. */
function bannerAmount(fixture: Fixture): unknown {
  const element = root(fixture).querySelector<HTMLElement & { amount?: unknown }>(
    '.banner__amount',
  );
  return element?.amount ?? null;
}

function type(fixture: Fixture, selector: string, value: string): void {
  const element = root(fixture).querySelector<HTMLInputElement>(selector);
  if (element === null) throw new Error(`No input for ${selector}.`);
  element.value = value;
  element.dispatchEvent(new Event('input'));
}

afterEach(() => TestBed.resetTestingModule());

describe('ReceiptDetailComponent (mounted)', () => {
  it('states the exact difference in money, and never a percentage', async () => {
    const { fixture } = await mount();

    const rendered = text(fixture);
    expect(rendered).toContain('Does not match');
    expect(rendered).toContain('The receipt claims more than its lines by');
    // A percentage of an unknown total is not an answer, and cannot be reconciled.
    expect(rendered).not.toContain('%');
    expect(bannerAmount(fixture)).toEqual({ amountMinor: '5000', currency: 'RSD' });
  });

  it('reads a negative variance the other way round, as a magnitude', async () => {
    const { fixture } = await mount({
      receipt: { ...MISMATCH, variance: { amountMinor: '-5000', currency: 'RSD' } },
    });

    expect(text(fixture)).toContain('The lines add up to more than the receipt by');
    // The sentence carries the direction; the amount beside it is the size of the difference.
    expect(bannerAmount(fixture)).toEqual({ amountMinor: '5000', currency: 'RSD' });
  });

  it('says a matched receipt matches, without drawing a difference', async () => {
    const { fixture } = await mount({ receipt: MATCHED });
    expect(text(fixture)).toContain('Matched');
    expect(text(fixture)).toContain('The lines add up to the total.');
    expect(bannerAmount(fixture)).toBeNull();
  });

  it('shows the category a line already carries, rather than "no category"', async () => {
    // A rendered bug found by looking at the page at 320 px: the select's `value` binding runs before
    // its `@for` options exist, so every saved category displayed as "no category". The fix binds
    // `selected` on the option, which has no ordering problem — this test is what keeps it fixed.
    const { fixture } = await mount();
    const selects = root(fixture).querySelectorAll<HTMLSelectElement>(
      '.items__row select.items__select',
    );

    expect([...selects].map((select) => select.value)).toEqual(['c1', 'c2', '', '']);
    const chosen = selects[0]?.querySelector<HTMLOptionElement>('option:checked');
    expect(chosen?.textContent?.trim()).toBe('Hrana');
  });

  it('says there is no total yet rather than showing a mismatch', async () => {
    const { fixture } = await mount({
      receipt: { ...MISMATCH, reconciliation: 'PENDING', total: null },
    });
    expect(text(fixture)).toContain('No total yet');
    expect(text(fixture)).toContain('there is nothing to compare');
    expect(bannerAmount(fixture)).toBeNull();
  });

  it('draws every confidence badge with its icon and its words', async () => {
    const { fixture } = await mount();
    const rendered = text(fixture);

    // The **words** are asserted, because they are the answer; the glyph is `fm-icon`'s business and is a
    // custom element here. It used to assert the emoji (🟢🟡🔴⚪) that the badge returned before the
    // ADR-039 audit — an emoji the platform drew in its own colours, which the reserved ADR-009 band tints
    // could not reach.
    expect(rendered).toContain('Confident');
    expect(rendered).toContain('Check it');
    expect(rendered).toContain('Not sure');
    // A line nobody measured is worded as unknown, never "0 %".
    expect(rendered).toContain('No suggestion');
    // A hand-typed line with no category is flagged for review.
    expect(rendered).toContain('Needs review');
    // And every badge carries an icon element, so the band is drawn as well as spoken.
    expect(root(fixture).querySelectorAll('fm-icon').length).toBeGreaterThan(0);
  });

  it('disables the post button on a mismatch and says which gate is closed', async () => {
    const { fixture } = await mount();
    const post = button(fixture, 'Create a transaction');

    expect(post.disabled).toBe(true);
    expect(text(fixture)).toContain('once the lines add up to the total');
  });

  it('disables the post button when a line has no category, and says so', async () => {
    const { fixture } = await mount({ receipt: { ...MATCHED, items: [{ ...MATCHED.items[0]!, categoryId: null }] } });
    const post = button(fixture, 'Create a transaction');

    expect(post.disabled).toBe(true);
    expect(text(fixture)).toContain('Every line needs a category');
  });

  it('posts a reconciled receipt and links to the created transaction', async () => {
    const { fixture, client } = await mount({ receipt: MATCHED });
    const post = button(fixture, 'Create a transaction');
    expect(post.disabled).toBe(false);

    post.click();
    await settle(fixture);

    const call = client.query.mock.calls.find((entry) =>
      String(entry[0]).includes('mutation CommitReceipt'),
    );
    expect(call?.[1]).toEqual({ input: { receiptId: 'r1', accountId: 'a1', locale: 'en' } });
    expect(text(fixture)).toContain('Posted as one transaction.');
    // The link opens the row itself (`/transactions/:id`), not the unfiltered list.
    expect(root(fixture).querySelector('a[href="/transactions/tx-9"]')).not.toBeNull();
  });

  it('shows the failure instead of a false success when the commit is refused', async () => {
    const { fixture, client } = await mount({ receipt: MATCHED, failCommit: true });

    button(fixture, 'Create a transaction').click();
    await settle(fixture);

    expect(text(fixture)).toContain('Nothing was saved');
    expect(text(fixture)).not.toContain('Posted as one transaction.');
    expect(root(fixture).querySelector('a[href^="/transactions/"]')).toBeNull();
    // The state still says MATCHED — the screen did not invent a transaction.
    expect(fixture.componentInstance.receipt()?.transactionId).toBeNull();
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('mutation CommitReceipt'), expect.anything());
  });

  it('sends the absolute new total for ADJUST_TOTAL, never a delta', async () => {
    const { fixture, reconciles } = await mount({ receipt: MATCHED });

    type(fixture, '.actions .field__input[inputmode="decimal"]', '2050');
    button(fixture, 'Set the total').click();
    await settle(fixture);

    expect(reconciles).toEqual([
      {
        input: {
          receiptId: 'r1',
          action: 'ADJUST_TOTAL',
          // The reader's language travels with the write (ADR-040), so the stored fallback description
          // and rounding line are written in it.
          locale: 'en',
          amount: { amountMinor: '205000', currency: 'RSD' },
        },
      },
    ]);
  });

  it('offers the absorbing line only while the receipt claims more than its lines', async () => {
    const { fixture, reconciles } = await mount();
    const rounding = button(fixture, 'Absorb the difference');
    expect(rounding.disabled).toBe(false);

    rounding.click();
    await settle(fixture);
    expect(reconciles[0]).toEqual({ input: { receiptId: 'r1', action: 'ADD_ROUNDING_LINE', locale: 'en' } });
  });

  it('does not offer the absorbing line when the lines overshoot the total', async () => {
    const { fixture } = await mount({
      receipt: { ...MISMATCH, variance: { amountMinor: '-5000', currency: 'RSD' } },
    });
    // A receipt line cannot be negative, so there is no legal line to add (docs/03 §4).
    expect(button(fixture, 'Absorb the difference').disabled).toBe(true);
  });

  it('detaches a posted receipt without claiming the transaction was deleted', async () => {
    const { fixture, reconciles } = await mount({
      receipt: { ...MATCHED, transactionId: 'tx-1' },
    });

    expect(text(fixture)).toContain('Posted as one transaction.');
    expect(root(fixture).querySelector('a[href="/transactions/tx-1"]')).not.toBeNull();
    button(fixture, 'Detach').click();
    await settle(fixture);

    expect(reconciles[0]).toEqual({ input: { receiptId: 'r1', action: 'DETACH_TRANSACTION', locale: 'en' } });
    expect(text(fixture)).toContain('The transaction itself is unchanged');
  });

  it('adds a line by hand with the amount as a string of minor units', async () => {
    const { fixture, client } = await mount();

    button(fixture, '+ Add a line').click();
    fixture.detectChanges();

    const inputs = root(fixture).querySelectorAll<HTMLInputElement>('.items__row--add input.items__input');
    inputs[0]!.value = 'Mleko';
    inputs[0]!.dispatchEvent(new Event('input'));
    inputs[1]!.value = '150';
    inputs[1]!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    button(fixture, 'Add').click();
    await settle(fixture);

    const call = client.query.mock.calls.find((entry) =>
      String(entry[0]).includes('mutation AddItem'),
    );
    expect(call?.[1]).toEqual({
      receiptId: 'r1',
      input: { rawText: 'Mleko', amount: { amountMinor: '15000', currency: 'RSD' } },
    });
  });

  it('refuses a line whose amount cannot be read before it queries anything', async () => {
    const { fixture, client } = await mount();

    button(fixture, '+ Add a line').click();
    fixture.detectChanges();
    const inputs = root(fixture).querySelectorAll<HTMLInputElement>('.items__row--add input.items__input');
    inputs[0]!.value = 'Mleko';
    inputs[0]!.dispatchEvent(new Event('input'));
    inputs[1]!.value = 'nema';
    inputs[1]!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    button(fixture, 'Add').click();
    await settle(fixture);

    expect(text(fixture)).toContain('That amount could not be read.');
    expect(
      client.query.mock.calls.some((entry) => String(entry[0]).includes('mutation AddItem')),
    ).toBe(false);
  });

  it('saves a category chosen on a line through updateReceiptItem', async () => {
    const { fixture, client } = await mount();

    const select = root(fixture).querySelectorAll<HTMLSelectElement>('.items__row select.items__select')[0]!;
    select.value = 'c2';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);

    const call = client.query.mock.calls.find((entry) =>
      String(entry[0]).includes('mutation UpdateItem'),
    );
    expect(call?.[1]).toEqual({ input: { receiptItemId: 'i1', categoryId: 'c2' } });
  });
});

describe('ReceiptDetailComponent reads the photograph (ADR-037)', () => {
  it('asks the server to read the photo, and reports a missing reader as a state, not an error', async () => {
    // The shipped deployment: `extractReceipt` answers `AI_UNAVAILABLE:no-provider-configured`. Before
    // this screen called it at all, a person saw an empty list and no explanation — the defect that
    // produced this task. The copy and the machine code are both asserted, because the code is what an
    // operator acts on and the sentence is what the reader sees.
    const { fixture, client } = await mount();

    button(fixture, 'Read the photo').click();
    await settle(fixture);

    const call = client.query.mock.calls.find((entry) =>
      String(entry[0]).includes('mutation ExtractReceipt'),
    );
    expect(call?.[1]).toEqual({ receiptId: 'r1' });

    const rendered = text(fixture);
    expect(rendered).toContain('no receipt reader configured');
    expect(rendered).toContain('AI_UNAVAILABLE:no-provider-configured');
    // The manual path is still there, and it is what the copy points at.
    expect(rendered).toContain('+ Add a line');
  });

  it('shows the lines a successful read wrote, and how many were left out', async () => {
    const { fixture, extracts } = await mount({
      extract: { extracted: true, itemsWritten: 2, reason: null, linesWithoutAmount: 1 },
    });

    button(fixture, 'Read the photo').click();
    await settle(fixture);

    const rendered = text(fixture);
    expect(rendered).toContain('Lines read from the photo: 2');
    expect(rendered).toContain('left out: 1');
    // The row the server wrote is on screen: the count and the table cannot disagree.
    expect(rendered).toContain('Kafa');
    expect(extracts).toEqual([{ receiptId: 'r1' }]);
    // A reader that answered leaves no machine code to explain away.
    expect(rendered).not.toContain('Reader answer');
  });
});
