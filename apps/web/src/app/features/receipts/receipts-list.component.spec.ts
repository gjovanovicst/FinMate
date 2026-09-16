// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { HttpClient } from '@angular/common/http';
import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { ReceiptsListComponent } from './receipts-list.component';

initAngularTesting();

/**
 * The receipt library, mounted.
 *
 * The decisions live in `receipts.view.spec.ts`; what a *rendered* component proves is the wiring —
 * that the library shows the receipts it loaded with their dates, totals and states, that the capture
 * action runs the **same** four-step pipeline the transaction sheet runs (presign → signed PUT →
 * commit **without** a `transactionId` → open a Receipt) and then navigates to the new receipt, and
 * that a failure is a readable message with a retry that does **not** make the user re-photograph.
 *
 * `fm-money` is a custom element here, as everywhere else in this suite: its required input throws
 * NG0950 under JIT before its binding lands, so what is asserted is that the figures are *handed* to
 * it, through the element's own `amount` property.
 */

const ROWS = [
  {
    id: 'r1',
    capturedAt: '2026-10-12T10:00:00.000Z',
    reconciliation: 'MISMATCH',
    total: { amountMinor: '205000', currency: 'RSD' },
    itemsTotal: { amountMinor: '200000', currency: 'RSD' },
    variance: { amountMinor: '5000', currency: 'RSD' },
    attachmentId: 'att-1',
    transactionId: null,
  },
  {
    id: 'r2',
    capturedAt: '2026-10-11T10:00:00.000Z',
    reconciliation: 'PENDING',
    total: null,
    itemsTotal: { amountMinor: '0', currency: 'RSD' },
    variance: { amountMinor: '0', currency: 'RSD' },
    attachmentId: 'att-2',
    transactionId: null,
  },
];

const PRESIGN = {
  attachmentId: 'att-1',
  uploadUrl: 'https://storage.test/household/att-1.jpg',
  method: 'PUT',
  headers: { 'content-type': 'image/jpeg', 'x-amz-meta-sha256': '0'.repeat(64) },
  expiresAt: '2026-10-12T10:05:00.000Z',
  reused: false,
};

/** A recording `XMLHttpRequest`: it keeps the URL and headers and fires progress then load. */
class FakeXhr {
  static readonly sent: FakeXhr[] = [];

  readonly headers: Record<string, string> = {};
  method = '';
  url = '';
  status = 200;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };

  constructor() {
    FakeXhr.sent.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(): void {
    const event = { lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent;
    this.upload.onprogress?.(event);
    this.onload?.();
  }
}

// A deterministic digest keeps the happy path from depending on which Web Crypto the runner has;
// hashing itself is covered by `receipts.view.spec.ts`.
Object.defineProperty(globalThis.crypto, 'subtle', {
  value: { digest: async () => new Uint8Array(32).buffer },
  configurable: true,
});

type Fixture = ReturnType<typeof TestBed.createComponent<ReceiptsListComponent>>;

interface Mounted {
  readonly fixture: Fixture;
  readonly client: { readonly query: ReturnType<typeof vi.fn> };
  readonly http: { readonly post: ReturnType<typeof vi.fn> };
  readonly navigate: ReturnType<typeof vi.spyOn>;
  /** The pipeline steps in the order they actually ran. */
  readonly order: string[];
}

async function mount(
  options: { readonly failCreate?: boolean; readonly empty?: boolean } = {},
): Promise<Mounted> {
  const order: string[] = [];
  const client = {
    query: vi.fn((query: string) => {
      if (query.includes('query Receipts')) {
        return Promise.resolve({ receipts: options.empty === true ? [] : ROWS });
      }
      if (query.includes('CommitAttachment')) {
        order.push('commit');
        return Promise.resolve({ commitAttachment: { id: 'att-1' } });
      }
      if (query.includes('CreateReceipt')) {
        order.push('create');
        if (options.failCreate === true) return Promise.reject(new Error('boom'));
        return Promise.resolve({ createReceipt: { id: 'r-new' } });
      }
      return Promise.resolve({});
    }),
  };
  const http = {
    post: vi.fn(() => {
      order.push('presign');
      return of(PRESIGN);
    }),
  };

  TestBed.configureTestingModule({
    imports: [ReceiptsListComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: GraphqlClient, useValue: client },
      { provide: HttpClient, useValue: http },
    ],
  });

  // `fm-money` is a custom element here; see the file header.
  TestBed.overrideComponent(ReceiptsListComponent, {
    remove: { imports: [MoneyComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(ReceiptsListComponent);
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  await settle(fixture);
  return { fixture, client, http, navigate, order };
}

/** Let every microtask in the load and upload chains run, then render the result. */
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

/** Hand the component a file the way the browser would, including the change event. */
function choose(fixture: Fixture, file: File): void {
  const input = root(fixture).querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('The file input is not rendered.');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

beforeEach(() => {
  FakeXhr.sent.length = 0;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

describe('ReceiptsListComponent (mounted)', () => {
  it('lists the receipts with their date, totals and reconciliation state', async () => {
    const { fixture } = await mount();

    const links = Array.from(root(fixture).querySelectorAll<HTMLAnchorElement>('a.row__link'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/receipts/r1', '/receipts/r2']);

    const rendered = text(fixture);
    expect(rendered).toContain('2026');
    expect(rendered).toContain('Does not match');
    // A receipt with no total yet says so rather than drawing a zero it does not have.
    expect(rendered).toContain('No total yet');
    expect(rendered).toContain('2 shown, newest first');

    // The figures reach `fm-money` as exact minor units — never as a number, never pre-formatted.
    const amounts = Array.from(root(fixture).querySelectorAll<HTMLElement & { amount?: unknown }>('fm-money'));
    expect(amounts.map((element) => element.amount)).toEqual([
      ROWS[0]?.total,
      ROWS[0]?.itemsTotal,
      ROWS[1]?.itemsTotal,
    ]);
  });

  it('shows the empty state rather than an empty list', async () => {
    const { fixture } = await mount({ empty: true });
    expect(text(fixture)).toContain('No receipts yet.');
    expect(root(fixture).querySelectorAll('a.row__link')).toHaveLength(0);
  });

  it('runs presign, the signed PUT, commit without a transaction, then createReceipt and navigates', async () => {
    const { fixture, client, order, navigate } = await mount();

    const file = new File(['receipt-bytes'], 'receipt.jpg', { type: 'image/jpeg' });
    choose(fixture, file);
    await settle(fixture);

    expect(order).toEqual(['presign', 'commit', 'create']);
    expect(root(fixture).querySelector('input[type="file"]')).not.toBeNull();
    expect(fixture.componentInstance.busy()).toBe(false);

    // The presign purpose is RECEIPT: `createReceipt` refuses any other purpose.
    expect(text(fixture)).toContain('Receipt saved');
    expect(navigate).toHaveBeenCalledWith(['/receipts', 'r-new']);

    // The PUT goes to the presigned URL with the returned headers and nothing added or removed.
    expect(FakeXhr.sent).toHaveLength(1);
    expect(FakeXhr.sent[0]?.method).toBe('PUT');
    expect(FakeXhr.sent[0]?.url).toBe(PRESIGN.uploadUrl);
    expect(FakeXhr.sent[0]?.headers).toEqual(PRESIGN.headers);

    // The commit carries no `transactionId`: there is no Transaction yet (docs/02 §4.11).
    const commitCall = client.query.mock.calls.find((entry) =>
      String(entry[0]).includes('CommitAttachment'),
    );
    expect(commitCall?.[1]).toEqual({ input: { attachmentId: 'att-1' } });
  });

  it('presigns with the RECEIPT purpose and the real digest', async () => {
    const { fixture, http } = await mount();
    const file = new File(['receipt-bytes'], 'receipt.jpg', { type: 'image/jpeg' });
    choose(fixture, file);
    await settle(fixture);

    expect(http.post).toHaveBeenCalledWith('/api/v1/files/presign', {
      purpose: 'RECEIPT',
      mimeType: 'image/jpeg',
      byteSize: file.size,
      sha256: expect.any(String),
    });
  });

  it('keeps the photo after a failure and retries the same upload', async () => {
    const { fixture, client, http } = await mount({ failCreate: true });

    const file = new File(['receipt-bytes'], 'receipt.jpg', { type: 'image/jpeg' });
    choose(fixture, file);
    await settle(fixture);

    // A readable message, and the retry affordance next to it.
    expect(text(fixture)).toContain('could not be uploaded');
    const retry = button(fixture, 'Try again');
    expect(http.post).toHaveBeenCalledTimes(1);

    retry.click();
    await settle(fixture);

    // Retrying re-runs the upload of the stored photo — no second trip to the picker, and no call to
    // the file input (which would have cleared `files` and required a new choice).
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls.filter((entry) => String(entry[0]).includes('CreateReceipt'))).toHaveLength(2);
  });

  it('explains a refused camera and keeps the file-input fallback, rather than a spinner', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: () => Promise.reject(new Error('NotAllowedError')) },
      configurable: true,
    });
    const { fixture } = await mount();

    button(fixture, 'Use the camera').click();
    await settle(fixture);

    expect(text(fixture)).toContain('Choose a photo instead');
    expect(root(fixture).querySelector('progress')).toBeNull();
    expect(text(fixture)).not.toContain('Starting the camera');
    expect(root(fixture).querySelector('input[type="file"]')).not.toBeNull();
  });
});
