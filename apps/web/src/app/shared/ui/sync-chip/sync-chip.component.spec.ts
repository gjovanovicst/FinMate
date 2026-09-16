// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler that the partially compiled `@angular/router`
// needs (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';

import { SyncService } from '../../../core/offline/sync.service';
import { SyncChipComponent } from './sync-chip.component';

initAngularTesting();

/**
 * The header chip, mounted.
 *
 * ADR-026 decision 1 makes this the queue's only bit of always-visible chrome, and docs/02 §2.3 makes
 * "hidden at zero" the rule — so the two things worth asserting are that it renders nothing while the
 * queue is empty, and that it is a real link to `/pending` when it does render.
 */
async function mount(count: number): Promise<ReturnType<typeof TestBed.createComponent<SyncChipComponent>>> {
  TestBed.configureTestingModule({
    imports: [SyncChipComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: SyncService, useValue: { pendingCount: signal(count) } },
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

  it('renders nothing while the queue is empty', async () => {
    const fixture = await mount(0);
    const host = fixture.nativeElement as HTMLElement;

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
  });

  it('uses the singular wording for one queued entry', async () => {
    const fixture = await mount(1);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Waiting to send (1)');
  });
});
