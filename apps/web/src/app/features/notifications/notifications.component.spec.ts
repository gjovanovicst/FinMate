// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { NotificationStore } from '../../core/notifications/notification.store';
import { PushService } from '../../core/push/push.service';
import type { PushState } from '../../core/push/push.view';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { NotificationsComponent } from './notifications.component';

initAngularTesting();

/**
 * The notification centre, mounted.
 *
 * The decisions live in `notifications.view.spec.ts`; what is asserted here is only what a *rendered*
 * component proves — that the list actually shows the rows it loaded, that the unread filter and the
 * mark-read button agree with each other, that a mark-read applies the count the server returned to
 * the shared bell, and that the preferences form **refuses** a quiet-hours window the API would store
 * as "never quiet" while the user believes the opposite.
 */

const ROWS = [
  {
    id: 'n1',
    insightId: 'i1',
    insightKind: 'BUDGET_PACE',
    insightSeverity: 'CRITICAL',
    channel: 'IN_APP',
    title: 'Budget overrun ahead: Hrana',
    body: 'Projected 600.00 against a 100.00 limit — 500.00 over.',
    status: 'SENT',
    sentAt: '2026-09-20T08:00:00.000Z',
    readAt: null,
    createdAt: '2026-09-20T08:00:00.000Z',
  },
  {
    id: 'n2',
    insightId: 'i2',
    insightKind: 'CATEGORY_SPIKE',
    insightSeverity: 'WARNING',
    channel: 'EMAIL',
    title: 'Spending spike: Hrana',
    body: 'Hrana: open FinMate to see the details.',
    status: 'SENT',
    sentAt: '2026-09-19T08:00:00.000Z',
    readAt: '2026-09-19T09:00:00.000Z',
    createdAt: '2026-09-19T08:00:00.000Z',
  },
];

const RULES = [
  { id: 'r1', kind: 'PACE_OVERRUN', channels: ['IN_APP'], quietHours: null, isActive: true },
];

/**
 * A stand-in for `PushService`.
 *
 * The real one reads `SwPush`, `Notification` and `PushManager`, none of which exist here; the state
 * machine itself is asserted in `core/push/push.view.spec.ts` and the flow in `push.service.spec.ts`.
 * What this file proves is the rendering: the sentence, the one button, and that the button is the
 * only thing that asks for permission.
 */
function fakePush(state: PushState = 'READY', overrides: { busy?: boolean; error?: boolean } = {}) {
  return {
    state: () => state,
    busy: () => overrides.busy ?? false,
    error: () => overrides.error ?? false,
    refresh: vi.fn(() => Promise.resolve()),
    enable: vi.fn(() => Promise.resolve()),
    disable: vi.fn(() => Promise.resolve()),
  };
}

async function mount(push: ReturnType<typeof fakePush> = fakePush()): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<NotificationsComponent>>;
  client: { query: ReturnType<typeof vi.fn> };
  store: NotificationStore;
  push: ReturnType<typeof fakePush>;
}> {
  const client = {
    query: vi.fn((query: string) => {
      if (query.includes('query Notifications')) return Promise.resolve({ notifications: { edges: ROWS.map((node) => ({ node })) } });
      if (query.includes('query Alerts')) return Promise.resolve({ alerts: RULES });
      if (query.includes('query NotificationPreferences')) {
        return Promise.resolve({
          notificationPreferences: {
            channels: ['IN_APP'],
            quietHours: null,
            positiveFeedback: true,
            locale: null,
          },
        });
      }
      if (query.includes('markNotificationRead')) {
        return Promise.resolve({
          markNotificationRead: { notification: { id: 'n1' }, unreadNotificationCount: 0 },
        });
      }
      if (query.includes('markAllNotificationsRead')) {
        return Promise.resolve({ markAllNotificationsRead: 1 });
      }
      return Promise.resolve({});
    }),
  };

  TestBed.configureTestingModule({
    imports: [NotificationsComponent],
    providers: [
      provideZonelessChangeDetection(),
      // `RouterLink` is in the template (the deep link on each row), and it needs a router.
      provideRouter([]),
      { provide: GraphqlClient, useValue: client },
      { provide: PushService, useValue: push },
    ],
  });
  // The chrome icons are custom elements here: JIT cannot discover `input()` signal inputs, so a
  // parent binding one cannot render the child at all (see `@web-test/angular-testing`).
  TestBed.overrideComponent(NotificationsComponent, {
    remove: { imports: [IconComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });
  const fixture = TestBed.createComponent(NotificationsComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, client, store: TestBed.inject(NotificationStore), push };
}

function rows(fixture: { nativeElement: unknown }): HTMLElement[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.row'));
}

function text(fixture: { nativeElement: unknown }): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

afterEach(() => TestBed.resetTestingModule());

describe('NotificationsComponent (mounted)', () => {
  it('renders every notification with its delivery status and channel', async () => {
    const { fixture } = await mount();
    expect(rows(fixture)).toHaveLength(2);
    const rendered = text(fixture);
    expect(rendered).toContain('Budget overrun ahead: Hrana');
    expect(rendered).toContain('500.00 over');
    // The channel that was actually used is on the row, so a user can tell email from in-app.
    expect(rendered).toContain('In the app');
    expect(rendered).toContain('Email');
  });

  it('offers the mark-read action only on an unread row', async () => {
    const { fixture } = await mount();
    const buttons = rows(fixture).map((row) => row.querySelectorAll('button').length);
    const links = rows(fixture).map((row) => row.querySelectorAll('a').length);
    // Every row deep-links to what caused it (docs/02 §4.17)…
    expect(links).toEqual([1, 1]);
    // …and only the unread one has anything left to mark.
    expect(buttons).toEqual([1, 0]);

    const unreadBox = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      '.toolbar input[type="checkbox"]',
    )!;
    unreadBox.click();
    fixture.detectChanges();
    expect(rows(fixture)).toHaveLength(1);
  });

  it('applies the count the server returns to the shared bell', async () => {
    const { fixture, client, store } = await mount();
    store.setCount(2);

    const markRead = Array.from(rows(fixture)[0]!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Mark as read'),
    )!;
    markRead.click();
    await fixture.whenStable();

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('markNotificationRead'), {
      id: 'n1',
    });
    // Not an optimistic decrement: the mutation's authoritative count is what the bell draws.
    expect(store.count()).toBe(0);
  });

  it('refuses to save quiet hours whose ends are equal, because the server would ignore them', async () => {
    const { fixture, client } = await mount();
    // Quiet hours start switched off, so the switch has to be flipped before the times exist.
    const quietToggle = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLLabelElement>('.settings label'),
    ).find((label) => label.textContent?.includes('During this window'))!
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    quietToggle.click();
    fixture.detectChanges();

    const timeInputs = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('input[type="time"]'),
    );
    expect(timeInputs).toHaveLength(2);
    // The API stores `start === end` as "never quiet", so the form must not let it through silently.
    timeInputs[0]!.value = '22:00';
    timeInputs[0]!.dispatchEvent(new Event('change'));
    timeInputs[1]!.value = '22:00';
    timeInputs[1]!.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const save = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Save'))!;
    expect(save.disabled).toBe(true);
    expect(text(fixture)).toContain('must differ');
    save.click();
    await fixture.whenStable();
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('updateNotificationPreferences'), expect.anything());
  });

  it('sends only the changed field when a rule is toggled', async () => {
    const { fixture, client } = await mount();
    const ruleToggle = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('.rule input[type="checkbox"]'),
    )[0]!;
    ruleToggle.click();
    await fixture.whenStable();

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('updateAlertRule'), {
      input: { id: 'r1', isActive: false },
    });
  });

  describe('the push panel (task 4.2.5)', () => {
    function pushButton(fixture: { nativeElement: unknown }): HTMLButtonElement | undefined {
      return Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.devpush button'),
      )[0];
    }

    it('explains what push does and offers the one action that state allows', async () => {
      const { fixture } = await mount(fakePush('READY'));

      expect(text(fixture)).toContain('Notifications on this device');
      // The explanation is what the permission prompt is asked *after* (ADR-028 decision 5).
      expect(text(fixture)).toContain('never shows amounts or names');
      expect(pushButton(fixture)?.textContent).toContain('Turn on notifications');
      // Reading the facts must not prompt: nothing was asked for by rendering the screen.
      expect(text(fixture)).not.toContain('Turn off notifications');
    });

    it('offers Turn off, and no email nudge, once the device is subscribed', async () => {
      const { fixture } = await mount(fakePush('SUBSCRIBED'));

      expect(text(fixture)).toContain('receives push notifications');
      expect(pushButton(fixture)?.textContent).toContain('Turn off notifications');
      expect(text(fixture)).not.toContain('Email is the reliable alternative');
    });

    it('states the iOS install requirement instead of offering a button that cannot work', async () => {
      const { fixture } = await mount(fakePush('IOS_INSTALL'));

      expect(text(fixture)).toContain('Home Screen');
      expect(pushButton(fixture)).toBeUndefined();
      // docs/07 §4.8's binding consequence: offer email where push cannot be established.
      expect(text(fixture)).toContain('Email is the reliable alternative');
    });

    it('says the deployment has no push rather than blaming the device', async () => {
      const { fixture } = await mount(fakePush('SERVER_OFF'));

      expect(text(fixture)).toContain('has not set up push');
      expect(pushButton(fixture)).toBeUndefined();
    });

    it('asks for permission only when the button is pressed, then calls the service', async () => {
      const push = fakePush('READY');
      const { fixture } = await mount(push);

      expect(push.enable).not.toHaveBeenCalled();
      pushButton(fixture)!.click();
      await fixture.whenStable();

      expect(push.enable).toHaveBeenCalledTimes(1);
      expect(push.disable).not.toHaveBeenCalled();
    });

    it('turns the device off from the subscribed state', async () => {
      const push = fakePush('SUBSCRIBED');
      const { fixture } = await mount(push);

      pushButton(fixture)!.click();
      await fixture.whenStable();

      expect(push.disable).toHaveBeenCalledTimes(1);
      expect(push.enable).not.toHaveBeenCalled();
    });

    it('shows the failure and the working state without touching the list', async () => {
      const push = fakePush('READY', { busy: true, error: true });
      const { fixture } = await mount(push);

      expect(text(fixture)).toContain('Working…');
      expect(text(fixture)).toContain('Could not change the notification setting');
      // A failed push toggle is not a failed load: the notification rows are still on screen.
      expect(rows(fixture)).toHaveLength(2);
    });
  });
});
