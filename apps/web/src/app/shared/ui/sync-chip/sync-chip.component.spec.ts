// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler that the partially compiled `@angular/router`
// needs (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';

import { SnapshotService } from '../../../core/offline/snapshot.service';
import { SyncService } from '../../../core/offline/sync.service';
import { SyncChipComponent } from './sync-chip.component';

initAngularTesting();

/**
 * The header chip, mounted.
 *
 * ADR-026 decision 1 makes the pending half the queue's only bit of always-visible chrome, and
 * ADR-027 decision 5 completes it: the **same** element carries `podaci od <time>` while the figures
 * on screen came from a snapshot. So the four states worth asserting are none, pending only, stale
 * only, and both — with the pending half a link to `/pending` and the stale half plain text.
 */
async function mount(
  count: number,
  staleAt: string | null = null,
): Promise<ReturnType<typeof TestBed.createComponent<SyncChipComponent>>> {
  TestBed.configureTestingModule({
    imports: [SyncChipComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: SyncService, useValue: { pendingCount: signal(count) } },
      { provide: SnapshotService, useValue: { staleAt: signal(staleAt) } },
    ],
  });

  const fixture = TestBed.createComponent(SyncChipComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe('SyncChipComponent (mounted)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders nothing while the queue is empty and the figures are live', async () => {
    const fixture = await mount(0);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.chip')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
    expect((host.textContent ?? '').trim()).toBe('');
  });

  it('shows the count and links to the tray while something is queued', async () => {
    const fixture = await mount(3);
    const host = fixture.nativeElement as HTMLElement;
    const link = host.querySelector('a');

    expect(link?.getAttribute('href')).toBe('/pending');
    expect(link?.textContent).toContain('Waiting to send (3)');
    // The count is spoken, not only drawn (docs/02 §2.3).
    expect(link?.getAttribute('aria-label')).toBe('Waiting to send, 3 entries');
    expect(host.querySelector('.chip__stale')).toBeNull();
  });

  it('uses the singular wording for one queued entry', async () => {
    const fixture = await mount(1);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Waiting to send (1)');
  });

  it('discloses a stale snapshot without linking anywhere (ADR-027 decision 5)', async () => {
    const fixture = await mount(0, '2026-09-14T10:00:00.000Z');
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('a')).toBeNull();
    expect(host.querySelector('.chip__stale')?.textContent).toContain('as of');
    // The stale half says when, it does not offer a destination.
    expect((host.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('carries both states in one element, with the count still the link', async () => {
    const fixture = await mount(2, '2026-09-14T10:00:00.000Z');
    const host = fixture.nativeElement as HTMLElement;
    const text = host.textContent ?? '';

    expect(host.querySelector('a')?.getAttribute('href')).toBe('/pending');
    expect(text).toContain('Waiting to send (2)');
    expect(text).toContain('as of');
    expect(host.querySelectorAll('.chip')).toHaveLength(1);
  });
});
