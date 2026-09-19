import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { AvatarLoaderComponent } from '../../shared/ui/avatar-loader/avatar-loader.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import {
  actionsOf,
  bucketRules,
  clausesOf,
  readabilityOf,
  type ResolveValue,
  type RuleActionSummary,
  type RuleClauseGroup,
} from './rules.view';

/**
 * `/rules` — the user's own rule set, and the first place it is visible at all.
 *
 * docs/04 §8.2 asks for exactly this: *"a 'your rules' screen shows hits/misses so the user can
 * prune"*. Until now a rule could only be created (by accepting a proposal) and never seen, renamed,
 * switched off or deleted, which makes the learning loop a one-way door.
 *
 * ## What it emphasises, and why in that order
 *
 * The rules that **need attention** come first: one shadowed by a higher-precedence rule will never
 * fire (docs/04 §8.2 — "shadowing rules is how rule sets rot"), and one that has not fired in 90 days
 * is a candidate for pruning. Those are the two states that make a rule set rot, and a screen that
 * buries them under the healthy ones is decorative. `bucketRules` decides, not the template.
 *
 * ## It is honest about what it cannot draw
 *
 * Conditions nest to depth 3. A single-level tree renders as a sentence; anything deeper shows the
 * raw document, because flattening `all(A, any(B))` into "A and B" would misstate the rule. The
 * decision comes from `readabilityOf`, the same function the renderer uses, so the fallback cannot
 * drift from what the renderer handles.
 *
 * ## Rules hold no money, so writes are last-write-wins
 *
 * `rules` has no `version` column (docs/03 §4), so unlike a Transaction an edit here cannot be
 * refused for being stale. Acceptable — a rule holds no money, and the worst case is re-applying a
 * rename (docs/06 §5.3.1).
 */
@Component({
  selector: 'fm-rules',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `NgTemplateOutlet` keeps ONE definition of a rule row while three groups render it. The
  // alternative — the same forty lines three times — is how the groups start drifting apart.
  imports: [NgTemplateOutlet, IconComponent, AvatarLoaderComponent],
  template: `
    <div class="fm-page">
    <header class="fm-page__head">
      <div>
        <h1 class="fm-page__title">{{ i18n.t('rules.title') }}</h1>
        <p class="fm-page__sub">{{ i18n.t('rules.subtitle') }}</p>
      </div>
    </header>

    @if (error(); as message) {
      <p class="alert" role="alert">{{ message }}</p>
    }
    <p class="fm-visually-hidden" aria-live="polite">{{ announcement() }}</p>

    @if (loading()) {
      <fm-avatar-loader [rows]="6" />
    } @else if (rules().length === 0) {
      <div class="empty">
        <p class="empty__title">{{ i18n.t('rules.empty') }}</p>
        <p class="empty__body">{{ i18n.t('rules.emptyBody') }}</p>
      </div>
    } @else {
      @if (buckets().needsAttention.length > 0) {
        <section class="group">
          <div class="group__head">
            <div class="fm-card__head">
              <h2 class="fm-card__title">
                <fm-icon name="alert" [size]="18" />
                {{ i18n.t('rules.attentionTitle') }}
              </h2>
            </div>
            <p class="group__sub">{{ i18n.t('rules.attentionBody') }}</p>
          </div>
          @for (rule of buckets().needsAttention; track rule.id) {
            <ng-container *ngTemplateOutlet="row; context: { $implicit: rule }" />
          }
        </section>
      }

      <section class="group">
        <div class="fm-card__head">
          <h2 class="fm-card__title">
            <fm-icon name="rules" [size]="18" />
            {{ i18n.t('rules.activeTitle', { count: buckets().active.length }) }}
          </h2>
        </div>
        @for (rule of buckets().active; track rule.id) {
          <ng-container *ngTemplateOutlet="row; context: { $implicit: rule }" />
        }
      </section>

      @if (buckets().inactive.length > 0) {
        <section class="group">
          <div class="fm-card__head">
            <h2 class="fm-card__title">
              <fm-icon name="close" [size]="18" />
              {{ i18n.t('rules.inactiveTitle', { count: buckets().inactive.length }) }}
            </h2>
          </div>
          @for (rule of buckets().inactive; track rule.id) {
            <ng-container *ngTemplateOutlet="row; context: { $implicit: rule }" />
          }
        </section>
      }
    }
    </div>

    <ng-template #row let-rule>
      <article class="fm-card fm-card--tight rule" [class.rule--off]="!rule.isActive">
        <div class="rule__head">
          <h3 class="rule__name">{{ rule.name }}</h3>
          <span class="rule__meta">
            <span class="badge" [attr.data-origin]="rule.origin">
              {{ originLabel(rule.origin) }}
            </span>
            <span class="badge">{{ i18n.t('rules.priority', { priority: rule.priority }) }}</span>
            @if (rule.hitCount !== '0') {
              <span class="badge">{{ i18n.t('rules.hits', { count: rule.hitCount }) }}</span>
            } @else if (rule.isStale) {
              <span class="badge badge--warn">{{ i18n.t('rules.stale') }}</span>
            } @else {
              <span class="badge">{{ i18n.t('rules.noHits') }}</span>
            }
            @if (!rule.isActive) {
              <span class="badge">{{ i18n.t('rules.off') }}</span>
            }
          </span>
        </div>

        @if (rule.conflictsWith.length > 0) {
          <p class="warn">
            {{
              i18n.t('rules.shadowed', {
                rule: rule.conflictsWith[0].ruleName,
                category: categoryOf(rule.conflictsWith[0].existingValue)
              })
            }}
          </p>
        }

        @if (conditionsFor(rule); as group) {
          <p class="rule__body">
            <span class="rule__label">{{ i18n.t('rules.when') }}</span>
            <span class="rule__text">{{ clauseText(group) }}</span>
          </p>
          <p class="rule__body">
            <span class="rule__label">{{ i18n.t('rules.then') }}</span>
            <span class="rule__text">{{ actionText(actionsFor(rule)) }}</span>
          </p>
        } @else {
          <p class="rule__raw-label">{{ i18n.t('rules.rawDocument') }}</p>
          <pre class="rule__raw">{{ rawDocument(rule) }}</pre>
        }

        <div class="rule__actions">
          <button class="fm-btn" type="button" [disabled]="busy()" (click)="toggle(rule)">
            {{ rule.isActive ? i18n.t('rules.switchOff') : i18n.t('rules.switchOn') }}
          </button>
          <button class="fm-btn fm-btn--danger" type="button" [disabled]="busy()" (click)="remove(rule)">
            {{ i18n.t('rules.delete') }}
          </button>
        </div>
      </article>
    </ng-template>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .alert {
        margin: 0;
        padding: var(--space-3);
        border-radius: var(--radius-md);
        background: var(--color-danger-soft);
        color: var(--color-danger);
        font-size: var(--text-sm);
      }
      .muted {
        color: var(--color-text-muted);
      }
      .empty {
        margin-block-start: var(--space-5);
        text-align: center;
        color: var(--color-text-muted);
      }
      .empty__title {
        margin: 0;
        font-size: var(--text-lg);
      }
      .empty__body {
        margin: var(--space-1) 0 0;
      }
      /* A group is a heading plus its rule cards; the page's own gap separates one group from the
         next, so this one only has to space the head from the cards. */
      .group {
        display: grid;
        gap: var(--space-3);
      }
      .group__head {
        display: grid;
        gap: var(--space-1);
      }
      .group__sub {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      /* The rule card's body, radius, padding and shadow come from .fm-card--tight; the denser gap is
         this screen's, because a rule is a short list of short lines. */
      .rule {
        gap: var(--space-2);
      }
      .rule--off {
        opacity: 0.65;
      }
      .rule__head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .rule__name {
        margin: 0;
        font-size: var(--text-base);
        overflow-wrap: anywhere;
      }
      .rule__meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .badge {
        padding: 0 var(--space-2);
        font-size: var(--text-xs);
        color: var(--color-text-muted);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
      }
      /* --color-primary-text, not --color-primary: the fill is 3.78:1 as text on a card and this badge is
         12 px (found by the ADR-039 audit). styles.css states the rule; this is the one place that broke
         it. */
      .badge[data-origin='LEARNED'] {
        color: var(--color-primary-text);
        border-color: var(--color-primary-text);
      }
      .badge--warn {
        color: var(--color-warning);
        border-color: var(--color-warning);
      }
      .warn {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--color-warning);
      }
      .rule__body {
        margin: 0;
        font-size: var(--text-sm);
        overflow-wrap: anywhere;
      }
      .rule__label {
        color: var(--color-text-subtle);
        margin-inline-end: var(--space-1);
      }
      .rule__raw-label {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .rule__raw {
        margin: 0;
        padding: var(--space-2);
        overflow-x: auto;
        font-size: var(--text-xs);
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
      }
      .rule__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
    `,
  ],
})
export class RulesComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);

  readonly rules = signal<readonly RuleNode[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly announcement = signal('');

  /** Id → display name, for the three things a rule can point at. */
  private readonly names = signal<ReadonlyMap<string, string>>(new Map());

  /** The resolver the renderer asks about identifiers; unknown ids come back raw and marked. */
  private readonly resolve: ResolveValue = (field, value) => {
    const label = this.names().get(`${field}:${value}`);
    return label === undefined ? { label: value, known: false } : { label, known: true };
  };

  readonly buckets = computed(() => bucketRules(this.rules()));

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [rules, categories, merchants, counterparties] = await Promise.all([
        this.graphql.query<{ rules: RuleNode[] }>(RULES_QUERY),
        this.graphql.query<{ categories: { id: string; path: readonly string[] }[] }>(
          CATEGORY_NAMES_QUERY,
        ),
        this.graphql.query<{ merchants: { edges: { node: { id: string; name: string } }[] } }>(
          MERCHANT_NAMES_QUERY,
        ),
        this.graphql.query<{
          counterparties: { edges: { node: { id: string; name: string } }[] };
        }>(COUNTERPARTY_NAMES_QUERY),
      ]);

      const names = new Map<string, string>();
      // `path` is `[String!]!` on the wire (docs/06 §3) — a list of names, root first. Typing it as a
      // `string` and setting it directly made the label a comma-joined array ("Hrana,Supermarket")
      // rather than the breadcrumb every other screen renders. Join it like they do.
      for (const category of categories.categories) {
        names.set(`categoryId:${category.id}`, category.path.join(' › '));
      }
      for (const edge of merchants.merchants.edges) names.set(`merchant:${edge.node.id}`, edge.node.name);
      for (const edge of counterparties.counterparties.edges) {
        names.set(`counterparty:${edge.node.id}`, edge.node.name);
        names.set(`counterpartyId:${edge.node.id}`, edge.node.name);
      }
      for (const edge of merchants.merchants.edges) {
        names.set(`merchantId:${edge.node.id}`, edge.node.name);
      }

      this.names.set(names);
      this.rules.set(rules.rules);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

  originLabel(origin: RuleNode['origin']): string {
    const keys: Record<RuleNode['origin'], TranslationKey> = {
      USER: 'rules.origin.USER',
      LEARNED: 'rules.origin.LEARNED',
      SYSTEM: 'rules.origin.SYSTEM',
      IMPORT: 'rules.origin.IMPORT',
    };
    return this.i18n.t(keys[origin]);
  }

  conditionsFor(rule: RuleNode): RuleClauseGroup | null {
    // The same function the template's fallback is decided by, so the two cannot disagree.
    return readabilityOf(rule.conditions, this.resolve) === 'RAW'
      ? null
      : clausesOf(rule.conditions, this.resolve);
  }

  actionsFor(rule: RuleNode): RuleActionSummary {
    return actionsOf(rule.actions, this.resolve);
  }

  /** One sentence per group: the quantifier word, then the clauses. */
  clauseText(group: RuleClauseGroup): string {
    const joiner =
      group.quantifier === 'all'
        ? this.i18n.t('rules.join.all')
        : group.quantifier === 'any'
          ? this.i18n.t('rules.join.any')
          : this.i18n.t('rules.join.none');

    return group.clauses
      .map((clause) => {
        const field = this.i18n.t(`rules.field.${clause.field}` as TranslationKey);
        const op = this.i18n.t(`rules.op.${clause.op}` as TranslationKey);
        return `${field} ${op} ${clause.value}`.replace(/\s+/g, ' ').trim();
      })
      .join(` ${joiner} `);
  }

  actionText(actions: RuleActionSummary): string {
    const parts: string[] = [];
    if (actions.setCategory) {
      parts.push(this.i18n.t('rules.action.setCategory', { category: actions.setCategory.label }));
    }
    if (actions.clearsCategory) parts.push(this.i18n.t('rules.action.clearCategory'));
    if (actions.setMerchant) {
      parts.push(this.i18n.t('rules.action.setMerchant', { merchant: actions.setMerchant.label }));
    }
    if (actions.setCounterparty) {
      parts.push(
        this.i18n.t('rules.action.setCounterparty', { counterparty: actions.setCounterparty.label }),
      );
    }
    if (actions.setDescription) {
      parts.push(this.i18n.t('rules.action.setDescription', { description: actions.setDescription }));
    }
    if (actions.addTags.length > 0) {
      parts.push(this.i18n.t('rules.action.addTags', { count: actions.addTags.length }));
    }
    return parts.length === 0 ? this.i18n.t('rules.action.none') : parts.join(', ');
  }

  /** The document verbatim, for the case the renderer refuses to describe. */
  rawDocument(rule: RuleNode): string {
    return JSON.stringify(rule.conditions, null, 2);
  }

  categoryOf(id: string | null): string {
    if (id === null) return this.i18n.t('transactions.noCategory');
    return this.names().get(`categoryId:${id}`) ?? id;
  }

  async toggle(rule: RuleNode): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(UPDATE_RULE, { id: rule.id, isActive: !rule.isActive });
      this.announcement.set(
        rule.isActive
          ? this.i18n.t('rules.switchedOff', { name: rule.name })
          : this.i18n.t('rules.switchedOn', { name: rule.name }),
      );
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async remove(rule: RuleNode): Promise<void> {
    if (this.busy()) return;
    // A rule is a decision the user made, and deleting it changes how future entries are categorised
    // — worth one confirmation, unlike a rename.
    if (!globalThis.confirm(this.i18n.t('rules.deleteConfirm', { name: rule.name }))) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(DELETE_RULE, { id: rule.id });
      this.announcement.set(this.i18n.t('rules.deleted', { name: rule.name }));
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }
}

interface RuleNode {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly isActive: boolean;
  readonly stopOnMatch: boolean;
  readonly conditions: unknown;
  readonly actions: unknown;
  readonly origin: 'USER' | 'LEARNED' | 'SYSTEM' | 'IMPORT';
  readonly sourceCorrectionId: string | null;
  readonly hitCount: string;
  readonly lastHitAt: string | null;
  readonly isStale: boolean;
  readonly conflictsWith: readonly {
    readonly ruleId: string;
    readonly ruleName: string;
    readonly priority: number;
    readonly overlappingField: string;
    readonly existingValue: string | null;
    readonly proposedValue: string | null;
  }[];
}

const RULES_QUERY = /* GraphQL */ `
  query Rules {
    rules {
      id
      name
      priority
      isActive
      stopOnMatch
      conditions
      actions
      origin
      sourceCorrectionId
      hitCount
      lastHitAt
      isStale
      conflictsWith {
        ruleId
        ruleName
        priority
        overlappingField
        existingValue
        proposedValue
      }
    }
  }
`;

const CATEGORY_NAMES_QUERY = /* GraphQL */ `
  query RuleCategoryNames {
    categories {
      id
      path
    }
  }
`;

const MERCHANT_NAMES_QUERY = /* GraphQL */ `
  query RuleMerchantNames {
    merchants(first: 200) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

const COUNTERPARTY_NAMES_QUERY = /* GraphQL */ `
  query RuleCounterpartyNames {
    counterparties(first: 200) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

const UPDATE_RULE = /* GraphQL */ `
  mutation UpdateRule($id: ID!, $isActive: Boolean) {
    updateRule(id: $id, isActive: $isActive) {
      id
      isActive
    }
  }
`;

const DELETE_RULE = /* GraphQL */ `
  mutation DeleteRule($id: ID!) {
    deleteRule(id: $id)
  }
`;
