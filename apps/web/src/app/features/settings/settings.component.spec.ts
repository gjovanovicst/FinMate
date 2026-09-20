// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IconComponent } from '../../shared/ui/icon/icon.component';
import { AccountSettingsComponent } from './account-settings.component';
import { AiSettingsComponent } from './ai-settings.component';
import { SecuritySettingsComponent } from './security-settings.component';
import { SettingsComponent, readSection } from './settings.component';

initAngularTesting();

/**
 * The account shell (docs/02 §4.18, task 0.6.7).
 *
 * What matters here is the **shell**: that the URL decides the section, that an unknown one falls back
 * rather than blanking, and that the widget is a real tablist a keyboard and a screen reader can use.
 * The panes' own contents are their components' specs; the shell spec removes them so it tests its own
 * contract and nothing else.
 */

function mount(initial: Record<string, string> = {}) {
  const params = new BehaviorSubject(convertToParamMap(initial));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { queryParamMap: params.asObservable() } },
    ],
  });
  // The panes are opaque here: each pulls a different service, and none of that is this spec's subject.
  TestBed.overrideComponent(SettingsComponent, {
    remove: { imports: [IconComponent, AccountSettingsComponent, SecuritySettingsComponent, AiSettingsComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });
  const fixture = TestBed.createComponent(SettingsComponent);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, params, router: TestBed.inject(Router) };
}

function tabs(fixture: { nativeElement: unknown }): readonly HTMLAnchorElement[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>('[role="tab"]'),
  );
}

function text(fixture: { nativeElement: unknown }): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('readSection', () => {
  it('accepts every known section', () => {
    for (const section of ['account', 'security', 'ai', 'notifications']) {
      expect(readSection(section)).toBe(section);
    }
  });

  it('falls back to the first section for an absent or unknown value', () => {
    // A stale link or a typo must not blank the page.
    expect(readSection(null)).toBe('account');
    expect(readSection('')).toBe('account');
    expect(readSection('nope')).toBe('account');
  });
});

describe('SettingsComponent — the section shell', () => {
  it('renders a tablist with one tab per section', () => {
    const { fixture } = mount();
    const strip = (fixture.nativeElement as HTMLElement).querySelector('[role="tablist"]');

    expect(strip).not.toBeNull();
    expect(tabs(fixture)).toHaveLength(4);
    expect(text(fixture)).toContain('Account');
    expect(text(fixture)).toContain('Security');
    expect(text(fixture)).toContain('AI and privacy');
    expect(text(fixture)).toContain('Notifications');
  });

  it('opens the Account section when the URL names none', () => {
    const { fixture, component } = mount();
    expect(component.section()).toBe('account');
    expect(tabs(fixture)[0]?.getAttribute('aria-selected')).toBe('true');
    expect((fixture.nativeElement as HTMLElement).querySelector('#panel-account')).not.toBeNull();
  });

  it('follows ?section, so a section can be linked and survives a refresh', () => {
    const { fixture, component } = mount({ section: 'ai' });

    expect(component.section()).toBe('ai');
    const ai = tabs(fixture).find((tab) => tab.id === 'tab-ai');
    expect(ai?.getAttribute('aria-selected')).toBe('true');
    expect((fixture.nativeElement as HTMLElement).querySelector('#panel-ai')).not.toBeNull();
    // Only the selected panel is in the document: a hidden-but-present pane would duplicate every id.
    expect((fixture.nativeElement as HTMLElement).querySelector('#panel-account')).toBeNull();
  });

  it('falls back to Account for an unknown section instead of showing nothing', () => {
    const { component } = mount({ section: 'not-a-section' });
    expect(component.section()).toBe('account');
  });

  it('roves the tabindex, so Tab reaches the strip once and arrows do the rest', () => {
    const { fixture } = mount({ section: 'security' });
    const byId = new Map(tabs(fixture).map((tab) => [tab.id, tab]));

    expect(byId.get('tab-security')?.getAttribute('tabindex')).toBe('0');
    for (const id of ['tab-account', 'tab-ai', 'tab-notifications']) {
      expect(byId.get(id)?.getAttribute('tabindex')).toBe('-1');
    }
  });

  it('wires each tab to its panel with aria-controls', () => {
    const { fixture } = mount();
    for (const tab of tabs(fixture)) {
      const panelId = tab.getAttribute('aria-controls');
      expect(panelId).toBe(`panel-${tab.id.replace('tab-', '')}`);
    }
  });

  it('navigates to the section that was chosen', () => {
    const { component, router } = mount();
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    // What `[routerLink]="[]" [queryParams]="{section}"` calls under the hood.
    void component.onTabsKeydown({ key: 'ArrowRight', preventDefault: vi.fn() } as unknown as KeyboardEvent);

    expect(navigate).toHaveBeenCalledWith([], { queryParams: { section: 'security' } });
  });

  it('moves with arrow keys, wraps, and jumps with Home and End', () => {
    const { component, router } = mount();
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const key = (value: string) =>
      ({ key: value, preventDefault: vi.fn() }) as unknown as KeyboardEvent;

    component.section.set('account');
    component.onTabsKeydown(key('ArrowLeft'));
    expect(navigate).toHaveBeenLastCalledWith([], { queryParams: { section: 'notifications' } });

    component.section.set('security');
    component.onTabsKeydown(key('ArrowRight'));
    expect(navigate).toHaveBeenLastCalledWith([], { queryParams: { section: 'ai' } });

    component.section.set('ai');
    component.onTabsKeydown(key('Home'));
    expect(navigate).toHaveBeenLastCalledWith([], { queryParams: { section: 'account' } });

    component.section.set('account');
    component.onTabsKeydown(key('End'));
    expect(navigate).toHaveBeenLastCalledWith([], { queryParams: { section: 'notifications' } });
  });

  it('ignores keys that are not tab navigation', () => {
    const { component, router } = mount();
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    component.onTabsKeydown({
      key: 'a',
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    expect(navigate).not.toHaveBeenCalled();
  });

  it('renders the notifications section as content, with the way to the centre', () => {
    const { fixture } = mount({ section: 'notifications' });
    const root = fixture.nativeElement as HTMLElement;

    expect(text(fixture)).toContain('What you get told');
    expect(root.querySelector('a[href="/notifications"]')).not.toBeNull();
  });
});
