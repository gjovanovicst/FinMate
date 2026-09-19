// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and the partially compiled Angular packages
// used below need the JIT compiler to already be present (see `capture.component.spec.ts`).
import { initAngularTesting, setSignalInput } from '@web-test/angular-testing';

import {
  CUSTOM_ELEMENTS_SCHEMA,
  provideZonelessChangeDetection,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ReceiptAttachmentComponent } from './receipt-attachment.component';
import { MAX_RECEIPT_BYTES } from './receipts.view';

initAngularTesting();

/**
 * The receipt widget, mounted.
 *
 * The decisions live in `receipts.view.spec.ts`; what is asserted here is only what a *rendered*
 * component proves — that the attach affordance exists, that a chosen photo really runs
 * presign → PUT → commit and announces the change, that a file the API would refuse is stopped locally
 * with the right message and **no** network call, and that a refused camera leaves an explanation and
 * the file-input fallback rather than a spinner.
 *
 * The transport is faked twice on purpose: `HttpClient` is a stub because presign is a request, and
 * `XMLHttpRequest` is a recording class because the signed headers and the progress callback are the
 * parts that are silently wrong (a dropped header is a 403 that looks like a permission problem).
 *
 * ## Why {@link setSignalInput} exists
 *
 * Angular's **JIT** compiler cannot discover `input()` signal inputs: only the AOT build emits the
 * `inputs` metadata with `InputFlags.SignalBased`, so in this test runner `ComponentRef.setInput`
 * warns `NG0303`, writes nothing, and reading the input then throws `NG0950` (the same limitation
 * `capture.component.spec.ts` records for `fm-money`). The component is correct in the production
 * build; the spec writes the value onto the input's own signal node so the mounted pipeline can run.
 * This is test-only shim code and it is the reason it is a named function with a comment rather than
 * `setInput` calls scattered through the tests.
 */

const ATTACHMENT = {
  id: 'att-1',
  downloadUrl: 'https://storage.test/household/att-1.jpg',
  scanState: 'SKIPPED',
  mimeType: 'image/jpeg',
  byteSize: 13,
};

const PRESIGN = {
  attachmentId: 'att-1',
  uploadUrl: 'https://storage.test/household/att-1.jpg',
  method: 'PUT',
  headers: { 'content-type': 'image/jpeg', 'x-amz-meta-sha256': '0'.repeat(64) },
  expiresAt: '2026-09-20T08:05:00.000Z',
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

// jsdom has no Web Crypto on some versions and Node's on others; a deterministic digest keeps the
// happy path from depending on which one is present, and hashing itself is covered by its own spec.
Object.defineProperty(globalThis.crypto, 'subtle', {
  value: { digest: async () => new Uint8Array(32).buffer },
  configurable: true,
});

type Fixture = ReturnType<typeof TestBed.createComponent<ReceiptAttachmentComponent>>;

/**
 * Write a value onto a signal input, bypassing Angular's input machinery.
 *
 * The implementation now lives in `@web-test/angular-testing`, because three specs need it — see its
 * doc for why the JIT runner cannot register `input()` signal inputs.
 */

interface Mounted {
  readonly fixture: Fixture;
  readonly client: { readonly query: ReturnType<typeof vi.fn> };
  readonly http: { readonly post: ReturnType<typeof vi.fn> };
  /** Presign and commit in the order they actually ran. */
  readonly order: string[];
}

async function mount(
  options: { readonly attachmentId?: string | null } = {},
): Promise<Mounted> {
  const order: string[] = [];
  const client = {
    query: vi.fn((query: string) => {
      if (query.includes('query Attachment')) return Promise.resolve({ attachment: ATTACHMENT });
      if (query.includes('CommitAttachment')) {
        order.push('commit');
        return Promise.resolve({ commitAttachment: ATTACHMENT });
      }
      if (query.includes('DeleteAttachment')) return Promise.resolve({ deleteAttachment: true });
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
    imports: [ReceiptAttachmentComponent],
    providers: [
      provideZonelessChangeDetection(),
      { provide: GraphqlClient, useValue: client },
      { provide: HttpClient, useValue: http },
    ],
  });
  // `fm-icon`'s required `name` input throws NG0950 under JIT before its binding lands, exactly as
  // `fm-money` does; the icon is a custom element here, as in every other mounted spec.
  TestBed.overrideComponent(ReceiptAttachmentComponent, {
    remove: { imports: [IconComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(ReceiptAttachmentComponent);
  setSignalInput(fixture.componentInstance, 'transactionId', 'tx-1');
  if (options.attachmentId !== undefined) {
    setSignalInput(fixture.componentInstance, 'attachmentId', options.attachmentId);
  }
  await settle(fixture);
  return { fixture, client, http, order };
}

/** Let every microtask in the upload chain run, then render the result. */
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

describe('ReceiptAttachmentComponent (mounted)', () => {
  it('renders the camera button and the file-input fallback', async () => {
    const { fixture } = await mount();
    const input = root(fixture).querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute('accept')).toBe('image/*');
    expect(input?.getAttribute('capture')).toBe('environment');
    expect(button(fixture, 'Use the camera')).toBeDefined();
  });

  it('runs presign, then the signed PUT, then commit, and announces the change', async () => {
    const { fixture, client, http, order } = await mount();
    let emitted = 0;
    fixture.componentInstance.changed.subscribe(() => {
      emitted += 1;
    });

    const file = new File(['receipt-bytes'], 'receipt.jpg', { type: 'image/jpeg' });
    choose(fixture, file);
    await settle(fixture);

    expect(order).toEqual(['presign', 'commit']);
    expect(http.post).toHaveBeenCalledWith('/api/v1/files/presign', {
      purpose: 'TRANSACTION',
      mimeType: 'image/jpeg',
      byteSize: file.size,
      sha256: expect.any(String),
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('CommitAttachment'), {
      input: { attachmentId: 'att-1', transactionId: 'tx-1' },
    });
    expect(emitted).toBe(1);
    expect(text(fixture)).toContain('Receipt attached.');

    // The PUT goes to the presigned URL with the returned headers and nothing added or removed: they
    // are part of the AWS signature, so a change here is a 403.
    expect(FakeXhr.sent).toHaveLength(1);
    expect(FakeXhr.sent[0]?.method).toBe('PUT');
    expect(FakeXhr.sent[0]?.url).toBe(PRESIGN.uploadUrl);
    expect(FakeXhr.sent[0]?.headers).toEqual(PRESIGN.headers);
  });

  it('refuses an oversized photo with the size message and makes no network call', async () => {
    const { fixture, client, http } = await mount();
    choose(fixture, new File([new Uint8Array(MAX_RECEIPT_BYTES + 1)], 'big.jpg', { type: 'image/jpeg' }));
    await settle(fixture);

    expect(text(fixture)).toContain('larger than 12 MiB');
    expect(http.post).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(FakeXhr.sent).toHaveLength(0);
  });

  it('explains a refused camera and keeps the fallback, rather than leaving a spinner', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: () => Promise.reject(new Error('NotAllowedError')) },
      configurable: true,
    });
    const { fixture } = await mount();

    button(fixture, 'Use the camera').click();
    await settle(fixture);

    expect(text(fixture)).toContain('Choose a photo instead');
    // The upload bar is `.fm-progress`, not a bare progress element (ADR-039).
    expect(root(fixture).querySelector('.fm-progress')).toBeNull();
    expect(text(fixture)).not.toContain('Starting the camera');
    expect(root(fixture).querySelector('input[type="file"]')).not.toBeNull();
  });

  it('labels the loaded preview and removes the attachment it was given', async () => {
    const { fixture, client } = await mount({ attachmentId: 'att-1' });
    let emitted = 0;
    fixture.componentInstance.changed.subscribe(() => {
      emitted += 1;
    });

    // `SKIPPED` means *not scanned* in this build and must be said out loud (docs/08 §9.4).
    expect(text(fixture)).toContain('Not virus-scanned');
    expect(root(fixture).querySelector('img')?.getAttribute('aria-label')).toBe(
      'Receipt attached to this transaction',
    );

    button(fixture, 'Remove receipt').click();
    await settle(fixture);

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('DeleteAttachment'), {
      id: 'att-1',
    });
    expect(emitted).toBe(1);
  });
});
