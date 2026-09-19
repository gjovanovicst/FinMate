// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler` before any partially compiled Angular
// package's module body runs (see `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting, setSignalInput } from '@web-test/angular-testing';

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { TranslationKey } from '../../../core/i18n/translations';
import { AvatarLoaderComponent } from './avatar-loader.component';

initAngularTesting();

interface LoaderInputs {
  readonly rows?: number;
  readonly size?: number;
  readonly variant?: 'plain' | 'card';
  readonly labelKey?: TranslationKey;
}

/**
 * The shared loading skeleton, mounted.
 *
 * What only a mounted component can prove is the **accessibility contract**: the discs are
 * `aria-hidden` pictures, and the only thing a screen reader is told is one polite sentence. A
 * skeleton that announces five rows of nothing is worse than the `<p>Loading…</p>` it replaced, so
 * that is the assertion this spec exists for.
 *
 * Inputs go in through `setSignalInput`, not `ComponentRef.setInput`: Angular's JIT compiler cannot see
 * signal inputs, so the real setter silently no-ops in this runner (see `@web-test/angular-testing`).
 */
async function mount(inputs: LoaderInputs = {}): Promise<ComponentFixture<AvatarLoaderComponent>> {
  TestBed.configureTestingModule({
    imports: [AvatarLoaderComponent],
    providers: [provideZonelessChangeDetection()],
  });

  const fixture = TestBed.createComponent(AvatarLoaderComponent);
  for (const [name, value] of Object.entries(inputs)) {
    if (value !== undefined) setSignalInput(fixture.componentInstance, name, value);
  }

  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe('AvatarLoaderComponent (mounted)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('draws the requested number of rows, each with a disc and two lines', async () => {
    const fixture = await mount({ rows: 4 });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelectorAll('.row')).toHaveLength(4);
    expect(host.querySelectorAll('.disc')).toHaveLength(4);
    expect(host.querySelectorAll('.line')).toHaveLength(8);
  });

  it('announces one polite status and hides the shapes from assistive tech', async () => {
    const fixture = await mount({ rows: 3 });
    const host = fixture.nativeElement as HTMLElement;

    const status = host.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    // The words a screen reader hears, and no more: the discs and lines carry no text.
    expect(status?.textContent?.trim()).toBe('Loading…');
    expect(host.querySelector('.rows')?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelectorAll('.fm-visually-hidden')).toHaveLength(1);
  });

  it('lets a caller keep its own, more specific sentence', async () => {
    const fixture = await mount({ labelKey: 'receipts.library.loading' });
    const host = fixture.nativeElement as HTMLElement;

    // The caller's copy wins; the generic key is a fallback, not a downgrade of existing wording.
    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe('Loading receipts…');
  });

  it('clamps a nonsensical row count instead of drawing a thousand rows', async () => {
    const many = await mount({ rows: 500 });
    expect((many.nativeElement as HTMLElement).querySelectorAll('.row')).toHaveLength(12);

    TestBed.resetTestingModule();
    const none = await mount({ rows: 0 });
    expect((none.nativeElement as HTMLElement).querySelectorAll('.row')).toHaveLength(1);
  });

  it('renders the card variant only when the loaded rows are each their own surface', async () => {
    const plain = await mount({ rows: 2 });
    expect((plain.nativeElement as HTMLElement).querySelectorAll('.row--card')).toHaveLength(0);

    TestBed.resetTestingModule();
    const carded = await mount({ rows: 2, variant: 'card' });
    expect((carded.nativeElement as HTMLElement).querySelectorAll('.row--card')).toHaveLength(2);
  });

  it('gives the rows different widths, so the placeholder reads as content rather than a table', async () => {
    const fixture = await mount({ rows: 3 });
    const widths = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.line'),
    ]
      .map((line) => line.style.inlineSize)
      .filter((width) => width !== '');

    expect(new Set(widths).size).toBeGreaterThan(1);
  });
});
