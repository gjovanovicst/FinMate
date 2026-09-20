import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import type { IconName } from '../../shared/ui/icon/icon-paths';
import { AccountSettingsComponent } from './account-settings.component';
import { AiSettingsComponent } from './ai-settings.component';
import { SecuritySettingsComponent } from './security-settings.component';

/**
 * The account shell — docs/02 §4.18 recorded as *"Podešavanja"*.
 *
 * The document draws a section list beside a pane, and for a long time this route was a plain stack
 * of cards instead: a *Profile* card that only linked elsewhere, the app lock, the AI consent
 * purposes, and a *Notifications* card that also only linked elsewhere — while a **second** screen,
 * `/profile`, held six more cards of the same subject. Ten cards across two pages answering one
 * question, and two of the four cards on this page were navigation dressed as content.
 *
 * The shell now owns every section, and `/profile` redirects here.
 *
 * ## The tabs are links, and they are in the URL
 *
 * Each tab is an `<a>` carrying `?section=`, not a button toggling local state. That keeps the four
 * things links give for free — the address bar, refresh, back/forward, open-in-a-new-tab — and makes
 * a section reachable from elsewhere in the app (the header's account block sends you straight to
 * `?section=account`). `role="tablist"`/`tab`/`tabpanel` is layered on top for screen readers, with
 * arrow-key navigation per the ARIA authoring practice; because the elements are anchors, Enter and
 * Space already do the obvious thing.
 *
 * @module apps/web/src/app/features/settings
 */
export const SETTINGS_SECTIONS = ['account', 'security', 'ai', 'notifications'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

interface SettingsTab {
  readonly id: SettingsSection;
  readonly labelKey: TranslationKey;
  readonly icon: IconName;
}

@Component({
  selector: 'fm-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IconComponent,
    AccountSettingsComponent,
    SecuritySettingsComponent,
    AiSettingsComponent,
  ],
  template: `
    <div class="fm-page wrap">
      <h1>{{ i18n.t('settings.title') }}</h1>

      <!-- A wrapping strip rather than a scrolling one: four short labels fit two rows at 320 px, and
           nothing is hidden off-screen where a thumb cannot reach it (docs/02 §9). -->
      <div
        class="tabs"
        role="tablist"
        [attr.aria-label]="i18n.t('settings.tabs.label')"
        (keydown)="onTabsKeydown($event)"
      >
        @for (tab of tabs; track tab.id) {
          <a
            class="tab"
            role="tab"
            [id]="'tab-' + tab.id"
            [routerLink]="[]"
            [queryParams]="{ section: tab.id }"
            [class.tab--active]="section() === tab.id"
            [attr.aria-selected]="section() === tab.id"
            [attr.aria-controls]="'panel-' + tab.id"
            [attr.tabindex]="section() === tab.id ? 0 : -1"
          >
            <fm-icon [name]="tab.icon" [size]="18" />
            <span>{{ i18n.t(tab.labelKey) }}</span>
          </a>
        }
      </div>

      @switch (section()) {
        @case ('account') {
          <section
            class="panel"
            role="tabpanel"
            id="panel-account"
            aria-labelledby="tab-account"
            tabindex="0"
          >
            <fm-account-settings />
          </section>
        }
        @case ('security') {
          <section
            class="panel"
            role="tabpanel"
            id="panel-security"
            aria-labelledby="tab-security"
            tabindex="0"
          >
            <fm-security-settings />
          </section>
        }
        @case ('ai') {
          <section class="panel" role="tabpanel" id="panel-ai" aria-labelledby="tab-ai" tabindex="0">
            <fm-ai-settings />
          </section>
        }
        @default {
          <section
            class="panel"
            role="tabpanel"
            id="panel-notifications"
            aria-labelledby="tab-notifications"
            tabindex="0"
          >
            <section class="fm-card">
              <div class="fm-card__head">
                <h2 class="fm-card__title">
                  <fm-icon name="bell" [size]="18" />
                  {{ i18n.t('nav.notifications') }}
                </h2>
              </div>
              <p class="muted">{{ i18n.t('settings.notifications.body') }}</p>
              <!-- The toggles live beside the list they describe, deliberately: a channel is a lot
                   easier to judge next to the alert it would have carried (docs/02 §4.17). -->
              <p class="muted small">{{ i18n.t('settings.notifications.why') }}</p>
              <a class="fm-btn open" routerLink="/notifications">
                {{ i18n.t('settings.notifications.open') }}
              </a>
            </section>
          </section>
        }
      }
    </div>
  `,
  styles: `
    /* A custom element is display: inline until it is told otherwise, and this one's only child is a
       block. That block-in-inline split gives the host a phantom line box — measured on /settings, the
       pane's scroll height came out 64 px taller than the content it held. Every other screen
       sidesteps it by rooting at a plain <div class="fm-page">; this rule is the fix, and the panes
       inside carry the same one for the same reason. (The page's *second* scrollbar was a separate
       defect — the screen-reader-only span in the Language card, docs/15 — not this split.) */
    :host {
      display: block;
    }
    .wrap {
      /* The reading measure is deliberately **not** capped. Every other screen fills the content pane,
         and the 46rem column this used to carry made /settings visibly narrower than the page beside
         it. Prose and text fields are capped where they occur, not the page as a whole. */
      max-inline-size: 100%;
    }
    h1 {
      font-size: var(--text-2xl);
      font-weight: var(--weight-bold);
      letter-spacing: var(--tracking-tight);
      margin: 0;
    }
    p {
      margin: 0;
    }
    .muted {
      color: var(--color-text-muted);
    }
    .small {
      font-size: var(--text-sm);
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    /* A pill, so the strip reads as one control rather than four links. The active state is the pair
       4.3.4b landed for the nav — brand text on the brand tint, which is 6.47:1 — not the brand colour
       as text, which was 3.85:1. */
    .tab {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      min-block-size: var(--control-size);
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-pill);
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      text-decoration: none;
      white-space: nowrap;
    }
    .tab:hover {
      background: var(--color-surface-raised);
      color: var(--color-text);
    }
    .tab--active {
      color: var(--color-primary-text);
      background: var(--color-primary-soft);
      border-color: var(--color-primary);
      font-weight: var(--weight-semibold);
    }
    .tab:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The pane is focusable so a keyboard user lands on its content after choosing a tab; the ring is
       suppressed because the tab they came from is the focus cue, and the browser would otherwise
       draw a box around the whole panel. */
    .panel {
      display: grid;
      gap: var(--space-4);
      outline: none;
    }
    /* A shared button is inline-flex and shrink-to-fit, but as a grid child it stretches to the
       column, which drew a full-width empty bar around one short label. */
    .open {
      justify-self: start;
    }
  `,
})
export class SettingsComponent {
  readonly i18n = inject(I18nService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly document = inject(DOCUMENT);

  readonly tabs: readonly SettingsTab[] = [
    { id: 'account', labelKey: 'settings.section.account', icon: 'people' },
    { id: 'security', labelKey: 'settings.section.security', icon: 'lock' },
    { id: 'ai', labelKey: 'settings.section.ai', icon: 'sparkles' },
    { id: 'notifications', labelKey: 'settings.section.notifications', icon: 'bell' },
  ];

  /**
   * The active section, read from `?section=`.
   *
   * The URL is the single source of truth rather than a signal a click also writes: two copies of
   * "which tab is open" is how a back button ends up disagreeing with the highlight.
   */
  readonly section = signal<SettingsSection>('account');

  constructor() {
    this.route.queryParamMap.subscribe((params) => {
      this.section.set(readSection(params.get('section')));
    });
  }

  /**
   * Arrow keys move between tabs, per the ARIA tabs pattern.
   *
   * Automatic activation — the arrow both selects and focuses — because a pane here is cheap and
   * there is nothing to lose by showing it; a manual-activation widget would make the reader press
   * Enter for no reason.
   */
  onTabsKeydown(event: KeyboardEvent): void {
    const order = SETTINGS_SECTIONS;
    const index = order.indexOf(this.section());

    let next: SettingsSection | null = null;
    if (event.key === 'ArrowRight') next = order[(index + 1) % order.length]!;
    else if (event.key === 'ArrowLeft') next = order[(index - 1 + order.length) % order.length]!;
    else if (event.key === 'Home') next = order[0]!;
    else if (event.key === 'End') next = order[order.length - 1]!;
    if (next === null) return;

    event.preventDefault();
    void this.router.navigate([], { queryParams: { section: next } });
    // The tab elements keep their ids, so focus can move now rather than waiting for the navigation
    // promise: what changes is the highlight, which the query-param subscription applies.
    this.document.getElementById(`tab-${next}`)?.focus();
  }
}

/** `?section=` as a section, falling back to the first for anything unrecognised or absent. */
export function readSection(value: string | null): SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value ?? '')
    ? (value as SettingsSection)
    : 'account';
}
