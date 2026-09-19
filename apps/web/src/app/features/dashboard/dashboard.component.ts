import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { changeRatio, shareOfTotal } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import { SnapshotService, type DashboardFigures } from '../../core/offline/snapshot.service';
import { syncedAtLabel } from '../../core/offline/sync.view';
import { moneyText, overrunText, overspendText } from '../../shared/money-text';
import { AvatarComponent } from '../../shared/ui/avatar/avatar.component';
import { BarChartComponent, type BarBucket, type BarSeries } from '../../shared/ui/bar-chart/bar-chart.component';
import { DonutComponent, type DonutSegment } from '../../shared/ui/donut/donut.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MoneyComponent, type MoneyWire } from '../../shared/ui/money/money.component';
import { ProgressComponent } from '../../shared/ui/progress/progress.component';
import { SparklineComponent } from '../../shared/ui/sparkline/sparkline.component';
import {
  amountText,
  categoryTint,
  deltaLabel,
  deltaTone,
  greetingKey,
  percentLabel,
  seriesFromBuckets,
  type AlertRow,
  type CategoryRow,
  type GoalRow,
  type RecentRow,
} from './dashboard.view';

/**
 * The KPI query.
 *
 * Its own round trip because **the panels need the period the server means**: spendByCategory and
 * spendOverTime take a range, and that range has to be the Household's own month, which only the server
 * knows (docs/03 §3.2 — a month boundary is a local-calendar question, and the browser's calendar is not
 * the Household's). So the figures land first and the range they carry is what the second query is built
 * from. Guessing the period from new Date() would be right in one timezone and wrong in the next.
 */
const DASHBOARD_QUERY = /* GraphQL */ `
  query Dashboard {
    dashboard {
      today
      periodStart
      periodEnd
      daysElapsed
      daysInMonth
      safeToSpendToday
      available
      isOverspent
      spentThisMonth
      incomeThisMonth
      monthlyBudget
      projectedTotal
      projectedOverrun
      paceIsReliable
      needsReviewCount
    }
  }
`;

/** Everything below the KPI row, in one round trip once the period is known. */
const PANELS_QUERY = /* GraphQL */ `
  query DashboardPanels($range: DateRangeInput!, $history: DateRangeInput!) {
    # includeSubcategories: false, deliberately. With subtrees included, a parent's figure contains its
    # children's and the ring's shares overlap — the live capture showed six rows summing to 122 % with
    # overlapping arcs. Direct spend per Category cannot overlap, and the uncategorised row is in the
    # same list, so the shares of a month add up to the whole of it.
    spendByCategory(range: $range, includeSubcategories: false) {
      categoryId
      total
      shareOfTotal
      category {
        id
        name
        icon
        color
      }
    }
    spendOverTime(bucket: DAY, range: $range) {
      bucketStart
      expenseTotal
      incomeTotal
    }
    cashflow(bucket: MONTH, range: $history) {
      bucketStart
      income
      expense
    }
    categories {
      id
      name
      icon
    }
    savingGoals {
      id
      name
      target
      contributed
      progress
      requiredPerMonth
      monthsRemaining
    }
    transactions(first: 6) {
      edges {
        node {
          id
          description
          amount
          kind
          occurredLocalDate
          categoryId
        }
      }
    }
    notifications(first: 3) {
      edges {
        node {
          id
          title
          body
          insightSeverity
          createdAt
          readAt
        }
      }
    }
    assistantSuggestions
  }
`;

interface Panels {
  readonly spendByCategory: readonly {
    categoryId: string | null;
    total: MoneyWire;
    shareOfTotal: number;
    category: { id: string; name: string; icon: string | null; color: string | null } | null;
  }[];
  readonly spendOverTime: readonly {
    bucketStart: string;
    expenseTotal: MoneyWire;
    incomeTotal: MoneyWire;
  }[];
  readonly cashflow: readonly { bucketStart: string; income: MoneyWire; expense: MoneyWire }[];
  readonly categories: readonly { id: string; name: string; icon: string | null }[];
  readonly savingGoals: readonly GoalRow[];
  readonly transactions: { edges: readonly { node: RecentRowRaw }[] };
  readonly notifications: {
    edges: readonly {
      node: {
        id: string;
        title: string;
        body: string;
        insightSeverity: string | null;
        createdAt: string;
        readAt: string | null;
      };
    }[];
  };
  readonly assistantSuggestions: readonly string[];
}

interface RecentRowRaw {
  readonly id: string;
  readonly description: string;
  readonly amount: MoneyWire;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly occurredLocalDate: string;
  readonly categoryId: string | null;
}

/**
 * The dashboard (docs/02 §4.2, ADR-039).
 *
 * Every figure comes from the backend's deterministic calculators (ADR-001) — including safe-to-spend,
 * the product's headline number — and every derived figure on this screen is either the server's own
 * (shareOfTotal, progress) or computed by a pure function in @finmate/domain (changeRatio,
 * shareOfTotal). Nothing here adds, divides or rounds money.
 *
 * The UI's job is to present them and to be honest about their confidence:
 *
 *  - With no budget set, the month figures are meaningless, so the hero invites the user to set one
 *    rather than showing a zero that looks like advice.
 *  - Before enough days have elapsed, the projection is withheld as "too early" instead of presenting a
 *    straight line extrapolated from one shopping trip as a forecast.
 *  - A month with no prior month to compare against renders **no** change chip at all: changeRatio's
 *    null is "no basis", which is not "no change" and has no honest arrow.
 *  - Offline, the last successful read is served from the snapshot with one podaci od <time> line
 *    (ADR-027, docs/02 §4.2). The panels below the KPI row are **not** cached — a spending analysis has no
 *    honest offline form (ADR-027's 4.2.8b amendment) — so they are replaced by one sentence saying so,
 *    never by an empty chart that reads as "you spent nothing".
 */
@Component({
  selector: 'fm-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MoneyComponent,
    IconComponent,
    ProgressComponent,
    SparklineComponent,
    DonutComponent,
    BarChartComponent,
    AvatarComponent,
  ],
  template: `
    <div class="fm-page">
      <header class="fm-page__head">
        <div>
          <h1 class="fm-page__title">{{ greeting() }}</h1>
          <p class="fm-page__sub">{{ i18n.t('dashboard.subtitle') }}</p>
        </div>
        <div class="fm-page__actions">
          @if (data(); as d) {
            <span class="fm-chip fm-chip--static">
              <fm-icon name="calendar" [size]="16" />
              {{ rangeLabel(d.periodStart, d.periodEnd) }}
            </span>
          }
          <a class="fm-chip" routerLink="/analytics">{{ i18n.t('dashboard.viewAnalytics') }}</a>
        </div>
      </header>

      @if (error()) {
        <p class="alert" role="alert">{{ error() }}</p>
      }

      @if (loading()) {
        <p class="muted">{{ i18n.t('accounts.loading') }}</p>
      } @else if (data(); as d) {
        @if (staleLabel(); as asOf) {
          <!-- ADR-027 decision 4: ONE label for the serving mode, covering every figure on the screen.
               A per-tile label would be five ways to forget one. -->
          <p class="asof">{{ i18n.t('money.asOf', { time: asOf }) }}</p>
        }

        <div class="grid">
          <section class="kpis" [attr.aria-label]="i18n.t('dashboard.summaryLabel')">
            <!-- The one filled card, and the product's headline: what is left of the month. -->
            <article class="fm-card fm-card--brand hero" [class.hero--over]="d.isOverspent">
              @if (d.monthlyBudget) {
                <p class="hero__label">{{ i18n.t('dashboard.availableToSpend') }}</p>
                <fm-money class="hero__amount" [amount]="d.available" />
                <p class="hero__of">{{ i18n.t('dashboard.of', { budget: budgetText() }) }}</p>
                <fm-progress
                  tone="hero"
                  [value]="usedRatio()"
                  [label]="i18n.t('dashboard.budgetUsed', { percent: usedPercent() })"
                />
                <p class="hero__meta">
                  <fm-icon name="alert" [size]="15" />
                  {{ i18n.t('dashboard.dayOf', { day: d.daysElapsed, total: d.daysInMonth }) }}
                  @if (overrunText(); as over) {
                    <span class="hero__sep" aria-hidden="true">·</span>
                    {{ i18n.t('dashboard.overspent', { amount: over }) }}
                  } @else {
                    <span class="hero__sep" aria-hidden="true">·</span>
                    {{ i18n.t('dashboard.safeToday', { amount: safeTodayText() }) }}
                  }
                </p>
              } @else {
                <p class="hero__label">{{ i18n.t('dashboard.noBudgetTitle') }}</p>
                <p class="hero__of">{{ i18n.t('dashboard.noBudgetBody') }}</p>
                <a class="hero__cta" routerLink="/budgets">{{ i18n.t('budgets.setBudget') }}</a>
              }
            </article>

            <article class="fm-card kpi">
              <div class="kpi__head">
                <span class="kpi__icon kpi__icon--income"><fm-icon name="arrowUp" [size]="18" /></span>
                <p class="kpi__label">{{ i18n.t('dashboard.incomeThisMonth') }}</p>
              </div>
              <fm-money class="kpi__value" [amount]="d.incomeThisMonth" direction="INCOME" />
              @if (incomeDelta(); as delta) {
                <p class="kpi__delta" [class]="'kpi__delta--' + incomeTone()">
                  <fm-icon [name]="deltaIcon(incomeTone())" [size]="14" />
                  {{ i18n.t('dashboard.vsLastMonth', { percent: delta }) }}
                </p>
              } @else {
                <p class="kpi__delta kpi__delta--flat">{{ i18n.t('dashboard.noComparison') }}</p>
              }
              <fm-sparkline
                class="kpi__chart"
                variant="bars"
                fill="--chart-2"
                [points]="incomeSeries()"
                [summary]="i18n.t('dashboard.incomeTrend')"
              />
            </article>

            <article class="fm-card kpi">
              <div class="kpi__head">
                <span class="kpi__icon kpi__icon--expense"><fm-icon name="arrowDown" [size]="18" /></span>
                <p class="kpi__label">{{ i18n.t('dashboard.spentThisMonth') }}</p>
              </div>
              <fm-money class="kpi__value" [amount]="d.spentThisMonth" direction="EXPENSE" />
              @if (spentDelta(); as delta) {
                <p class="kpi__delta" [class]="'kpi__delta--' + spentTone()">
                  <fm-icon [name]="deltaIcon(spentTone())" [size]="14" />
                  {{ i18n.t('dashboard.vsLastMonth', { percent: delta }) }}
                </p>
              } @else {
                <p class="kpi__delta kpi__delta--flat">{{ i18n.t('dashboard.noComparison') }}</p>
              }
              <fm-sparkline
                class="kpi__chart"
                variant="bars"
                fill="--chart-3"
                [points]="spentSeries()"
                [summary]="i18n.t('dashboard.spentTrend')"
              />
            </article>

            <article class="fm-card kpi">
              <div class="kpi__head">
                <span class="kpi__icon kpi__icon--projected">
                  <fm-icon name="trending" [size]="18" />
                </span>
                <p class="kpi__label">{{ i18n.t('dashboard.projected') }}</p>
              </div>
              <fm-money class="kpi__value" [amount]="d.projectedTotal" />
              @if (!d.paceIsReliable) {
                <p class="kpi__delta kpi__delta--flat">{{ i18n.t('dashboard.notEnoughData') }}</p>
              } @else if (projectedOverText(); as over) {
                <p class="kpi__delta kpi__delta--down">
                  <fm-icon name="arrowUp" [size]="14" />
                  {{ i18n.t('dashboard.projectedOverrun', { amount: over }) }}
                </p>
              } @else {
                <p class="kpi__delta kpi__delta--up">{{ i18n.t('dashboard.insideBudget') }}</p>
              }
              <fm-sparkline
                class="kpi__chart"
                variant="line"
                fill="--chart-5"
                [points]="historySeries()"
                [summary]="i18n.t('dashboard.historyTrend')"
              />
            </article>
          </section>

          <div class="panels">
            <section class="fm-card panel panel--donut">
              <div class="fm-card__head">
                <h2 class="fm-card__title">
                  <fm-icon name="chartPie" [size]="18" />
                  {{ i18n.t('dashboard.spendingByCategory') }}
                </h2>
                <a class="fm-card__action" routerLink="/analytics">
                  {{ i18n.t('dashboard.viewAll') }}
                </a>
              </div>

              @if (panelsUnavailable()) {
                <p class="empty">{{ i18n.t('dashboard.panelsOffline') }}</p>
              } @else if (categoryRows().length > 0) {
                <div class="donut">
                  <fm-donut
                    [segments]="donutSegments()"
                    [centerLabel]="i18n.t('dashboard.totalSpent')"
                    [centerValue]="spentText()"
                    [summary]="i18n.t('dashboard.categorySummary')"
                  />
                  <ul class="legend">
                    @for (row of categoryRows(); track row.id) {
                      <li class="legend__row">
                        <span class="legend__icon" [style.background]="row.tint">{{ row.icon ?? '•' }}</span>
                        <span class="legend__name">{{ row.name }}</span>
                        <span class="legend__pct">{{ percentLabel(row.share) ?? '' }}</span>
                        <fm-money class="legend__amount" [amount]="row.total" />
                      </li>
                    }
                  </ul>
                </div>
              } @else {
                <p class="empty">{{ i18n.t('dashboard.noSpending') }}</p>
              }
            </section>

            <section class="fm-card panel panel--chart">
              <div class="fm-card__head">
                <h2 class="fm-card__title">
                  <fm-icon name="chartBars" [size]="18" />
                  {{ i18n.t('dashboard.monthlyOverview') }}
                </h2>
                <a class="fm-card__action" routerLink="/analytics">
                  {{ i18n.t('dashboard.viewAll') }}
                </a>
              </div>
              @if (panelsUnavailable()) {
                <p class="empty">{{ i18n.t('dashboard.panelsOffline') }}</p>
              } @else {
                <fm-bar-chart [buckets]="barBuckets()" [series]="barSeries()" [height]="190" />
              }
            </section>

            <section class="fm-card panel">
              <div class="fm-card__head">
                <h2 class="fm-card__title">
                  <fm-icon name="piggy" [size]="18" />
                  {{ i18n.t('dashboard.savingGoals') }}
                </h2>
                <a class="fm-card__action" routerLink="/goals">
                  {{ i18n.t('dashboard.viewAll') }}
                </a>
              </div>

              @if (panelsUnavailable()) {
                <p class="empty">{{ i18n.t('dashboard.panelsOffline') }}</p>
              } @else if (goalRows().length > 0) {
                <ul class="rows">
                  @for (goal of goalRows(); track goal.id) {
                    <li class="row">
                      <fm-avatar [name]="goal.name" [size]="38" />
                      <div class="row__body">
                        <p class="row__title">{{ goal.name }}</p>
                        <p class="row__figures">
                          <fm-money [amount]="goal.contributed" />
                          <span class="row__of" aria-hidden="true">/</span>
                          <fm-money [amount]="goal.target" />
                          <span class="row__pct">{{ percentLabel(goal.progress) }}</span>
                        </p>
                        <fm-progress
                          [value]="goal.progress"
                          [tone]="goal.progress >= 1 ? 'success' : 'brand'"
                          [label]="i18n.t('dashboard.goalProgressLabel', { name: goal.name })"
                        />
                        <p class="row__foot">
                          {{ goalFootnote(goal) }}
                        </p>
                      </div>
                      <a
                        class="fm-icon-btn"
                        routerLink="/goals"
                        [attr.aria-label]="i18n.t('dashboard.contributeTo', { name: goal.name })"
                      >
                        <fm-icon name="capture" [size]="18" />
                      </a>
                    </li>
                  }
                </ul>
              } @else {
                <p class="empty">{{ i18n.t('dashboard.noGoals') }}</p>
              }
            </section>

            <section class="fm-card panel">
              <div class="fm-card__head">
                <h2 class="fm-card__title">
                  <fm-icon name="transactions" [size]="18" />
                  {{ i18n.t('dashboard.recentTransactions') }}
                </h2>
                <a class="fm-card__action" routerLink="/transactions">
                  {{ i18n.t('dashboard.viewAll') }}
                </a>
              </div>

              @if (panelsUnavailable()) {
                <p class="empty">{{ i18n.t('dashboard.panelsOffline') }}</p>
              } @else if (recentRows().length > 0) {
                <ul class="rows rows--tight">
                  @for (row of recentRows(); track row.id) {
                    <li class="row row--link">
                      <fm-avatar [name]="row.description" [size]="36" />
                      <div class="row__body">
                        <p class="row__title">{{ row.description }}</p>
                        <p class="row__meta">{{ row.categoryName ?? i18n.t('dashboard.uncategorised') }}</p>
                      </div>
                      <div class="row__right">
                        <fm-money
                          class="row__amount"
                          [amount]="row.amount"
                          [direction]="row.kind"
                        />
                        <span class="row__date">{{ shortDate(row.occurredLocalDate) }}</span>
                      </div>
                    </li>
                  }
                </ul>
              } @else {
                <p class="empty">{{ i18n.t('dashboard.noTransactions') }}</p>
              }
            </section>
          </div>

          <aside class="rail">
            <section class="fm-card assistant">
              <div class="assistant__head">
                <span class="assistant__avatar"><fm-icon name="sparkles" [size]="20" /></span>
                <div>
                  <h2 class="fm-card__title">{{ i18n.t('dashboard.assistantTitle') }}</h2>
                  <p class="assistant__lede">{{ i18n.t('dashboard.assistantLede') }}</p>
                </div>
              </div>

              <!-- The starter questions come from the API's own planner (docs/06 §8.1), so a chip is a
                   promise the assistant can keep: a hand-written list here would drift from what it can
                   actually answer. Each one **asks** — it links to the composer with the question in the
                   URL, which the screen answers on entry. -->
              @if (suggestions().length > 0) {
                <ul class="chips">
                  @for (suggestion of suggestions(); track suggestion) {
                    <li>
                      <a
                        class="chips__item"
                        routerLink="/assistant"
                        [queryParams]="{ q: suggestion }"
                      >
                        <span>{{ suggestion }}</span>
                        <fm-icon name="chevronRight" [size]="16" />
                      </a>
                    </li>
                  }
                </ul>
              }

              <form class="askbot" (submit)="askAssistant($event)">
                <input
                  class="askbot__input"
                  type="text"
                  name="question"
                  [value]="question()"
                  (input)="onQuestion($event)"
                  [attr.placeholder]="i18n.t('dashboard.assistantPlaceholder')"
                  [attr.aria-label]="i18n.t('assistant.askLabel')"
                />
                <button
                  class="askbot__send"
                  type="submit"
                  [disabled]="question().trim() === ''"
                  [attr.aria-label]="i18n.t('assistant.ask')"
                >
                  <fm-icon name="send" [size]="18" />
                </button>
              </form>
            </section>

            <section class="fm-card">
              <div class="fm-card__head">
                <h2 class="fm-card__title">
                  <fm-icon name="bell" [size]="18" />
                  {{ i18n.t('dashboard.alertsTitle') }}
                </h2>
                <a class="fm-card__action" routerLink="/notifications">
                  {{ i18n.t('dashboard.viewAll') }}
                </a>
              </div>

              @if (panelsUnavailable()) {
                <p class="empty">{{ i18n.t('dashboard.panelsOffline') }}</p>
              } @else if (alertRows().length > 0) {
                <ul class="rows rows--alerts">
                  @for (alert of alertRows(); track alert.id) {
                    <li class="row row--alert">
                      <span [class]="'alert__icon alert__icon--' + alert.severity.toLowerCase()">
                        <fm-icon [name]="alertIcon(alert.severity)" [size]="18" />
                      </span>
                      <div class="row__body">
                        <p class="row__title">{{ alert.title }}</p>
                        <p class="row__meta">{{ alert.body }}</p>
                      </div>
                      <span class="row__date">{{ timeOf(alert.createdAt) }}</span>
                    </li>
                  }
                </ul>
              } @else {
                <p class="empty">{{ i18n.t('dashboard.noAlerts') }}</p>
              }
            </section>
          </aside>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .muted {
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .alert {
        padding: var(--space-3);
        border-radius: var(--radius-md);
        background: var(--color-danger-soft);
        color: var(--color-danger);
        font-size: var(--text-sm);
      }
      .asof {
        margin: 0;
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
        font-style: italic;
      }
      .empty {
        margin: 0;
        color: var(--color-text-subtle);
        font-size: var(--text-sm);
      }

      /* ---- layout ----
         Three regions: the KPI row, the two-by-two panel block, and the rail. They stack below 1280 px,
         where a 21 rem rail would leave the panels too narrow to read a chart in. */
      .grid {
        display: grid;
        gap: var(--space-4);
      }
      .kpis {
        display: grid;
        gap: var(--space-4);
        grid-template-columns: minmax(0, 1fr);
      }
      /* Every grid child gets min-inline-size: 0. Without it a figure like "RSD 9.461.129,00" sets the
         column's min-content width and the amount is clipped by the card instead of shrinking (measured
         on a 1280 px capture of an overspent month). */
      .kpis > *,
      .panels > *,
      .rail > * {
        min-inline-size: 0;
      }
      .panels {
        display: grid;
        gap: var(--space-4);
        grid-template-columns: minmax(0, 1fr);
      }
      .rail {
        display: grid;
        gap: var(--space-4);
        align-content: start;
      }
      @media (min-width: 700px) {
        .kpis {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (min-width: 1000px) {
        .panels {
          grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
        }
      }
      @media (min-width: 1120px) {
        /* The hero is wider than the three tiles beside it, as in the mockup: it carries the headline
           figure and a progress bar, and the other three carry a figure and a trend. */
        .kpis {
          grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(0, 1fr));
        }
      }
      @media (min-width: 1400px) {
        .grid {
          grid-template-columns: minmax(0, 1fr) 21rem;
          align-items: start;
        }
        .rail {
          grid-column: 2;
          grid-row: 1 / -1;
        }
      }

      /* ---- the hero ---- */
      .hero {
        gap: var(--space-2);
        align-content: start;
        /* The card is the container the amount has to fit in. vw was the first attempt and it is
           wrong in both directions: a 1280 px window with a wide sidebar leaves a narrow card, and a
           320 px window has no sidebar at all. */
        container-type: inline-size;
      }
      .hero__label {
        margin: 0;
        color: var(--gradient-hero-ink-muted);
        font-size: var(--text-sm);
      }
      .hero__amount {
        /* 8.5cqw fits the longest thing this card can hold — "−RSD 9.461.129,00" — with the money
           font's tabular figures, and the clamp keeps it sane at both extremes. fm-money is nowrap on
           purpose, so the font is what gives way; overflow-wrap below is the last resort. */
        font-size: clamp(1.05rem, 8.5cqw, 1.6rem);
        font-weight: var(--weight-bold);
        letter-spacing: var(--tracking-tight);
        line-height: var(--leading-tight);
        /* fm-money is nowrap on purpose, so the size gives way instead: at 1.9rem a value like
           "300.000,00 RSD" is wider than a 320 px screen's content box. */
        overflow-wrap: anywhere;
      }
      .hero__of {
        margin: 0;
        color: var(--gradient-hero-ink-muted);
        font-size: var(--text-xs);
      }
      .hero__meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-1);
        margin: 0;
        color: var(--gradient-hero-ink-muted);
        font-size: var(--text-xs);
      }
      .hero__sep {
        margin-inline: var(--space-1);
      }
      .hero__cta {
        margin-block-start: var(--space-2);
        padding: var(--space-2) var(--space-4);
        border-radius: var(--radius-pill);
        background: #ffffff;
        color: #1e1b4b;
        font-size: var(--text-sm);
        font-weight: var(--weight-semibold);
        text-decoration: none;
        justify-self: start;
      }

      /* ---- the KPI tiles ---- */
      .kpi {
        gap: var(--space-2);
        align-content: start;
        container-type: inline-size;
      }
      .kpi__head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .kpi__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: 2rem;
        block-size: 2rem;
        border-radius: var(--radius-sm);
      }
      /* The tiles are tinted; the amounts are not. Money is ink (docs/13 §9): a green figure and a red
         one would read as judgement about a household's spending, and would collide with the reserved
         status colours. The chip carries the hue instead. */
      .kpi__icon--income {
        background: var(--color-success-soft);
        color: var(--color-success);
      }
      .kpi__icon--expense {
        background: var(--color-danger-soft);
        color: var(--color-danger);
      }
      .kpi__icon--projected {
        background: var(--color-primary-soft);
        color: var(--color-primary-text);
      }
      .kpi__label {
        margin: 0;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .kpi__value {
        /* Same reasoning as the hero. A tile is narrower than the hero, so the coefficient is smaller
           and the floor lower. */
        font-size: clamp(0.95rem, 7cqw, 1.25rem);
        font-weight: var(--weight-semibold);
        letter-spacing: var(--tracking-tight);
        overflow-wrap: anywhere;
      }
      .kpi__delta {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        margin: 0;
        font-size: var(--text-xs);
      }
      .kpi__delta--up {
        color: var(--color-success);
      }
      .kpi__delta--down {
        color: var(--color-danger);
      }
      .kpi__delta--flat {
        color: var(--color-text-subtle);
      }
      .kpi__chart {
        margin-block-start: auto;
      }

      /* ---- the donut panel ---- */
      .donut {
        display: grid;
        gap: var(--space-4);
        justify-items: center;
      }
      /* Deliberately **not** side by side. The reference puts the ring and its legend in one row inside
         a card about 440 px wide; in this layout the same card is ~370 px, and a four-column legend
         (icon, name, share, amount) beside a 180 px ring clipped every figure in it (measured on the
         1280 px capture). Stacking gives the legend the card's full width, and the ring only needs to
         be read as a shape. */
      .donut fm-donut {
        justify-self: center;
      }
      .legend {
        display: grid;
        gap: var(--space-3);
        margin: 0;
        padding: 0;
        list-style: none;
        inline-size: 100%;
      }
      .legend__row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto auto;
        align-items: center;
        gap: var(--space-3);
        font-size: var(--text-sm);
      }
      /* The Category's own icon from the tree, which is what the mockup's coloured chips are: the seed
         and the tree editor give every Category an icon, so this is data rather than decoration. */
      .legend__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: 2rem;
        block-size: 2rem;
        border-radius: var(--radius-sm);
        background: var(--color-surface-raised);
        font-size: 1rem;
        line-height: 1;
      }
      .legend__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .legend__pct {
        color: var(--color-text-muted);
        font-variant-numeric: tabular-nums;
      }
      .legend__amount {
        color: var(--color-text);
        font-variant-numeric: tabular-nums;
      }

      /* ---- shared row list (goals, recent transactions, alerts) ---- */
      .rows {
        display: grid;
        gap: var(--space-4);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .rows--tight {
        gap: var(--space-3);
      }
      .row {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .row__body {
        display: grid;
        gap: var(--space-1);
        flex: 1 1 auto;
        min-inline-size: 0;
      }
      .row__title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--weight-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .row__meta {
        margin: 0;
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
        overflow-wrap: anywhere;
      }
      .row__foot {
        margin: 0;
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
      }
      .row__pct {
        margin-inline-start: auto;
        color: var(--color-text-muted);
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
      }
      /* The two amounts and the share on one line, wrapping if the card is narrow: a three-column row
         inside a half-width card is what clipped them. */
      .row__figures {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--space-1) var(--space-2);
        margin: 0;
        color: var(--color-text-muted);
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
      }
      .row__of {
        color: var(--color-text-subtle);
      }
      .row__right {
        display: grid;
        justify-items: end;
        gap: var(--space-1);
        flex: none;
      }
      .row__amount {
        font-size: var(--text-sm);
        font-weight: var(--weight-semibold);
        font-variant-numeric: tabular-nums;
      }
      .row__date {
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
        white-space: nowrap;
      }

      /* ---- the assistant card ---- */
      .assistant {
        gap: var(--space-3);
        border-color: var(--color-primary);
        background: linear-gradient(
          160deg,
          var(--color-primary-soft) 0%,
          var(--color-surface) 55%
        );
      }
      .assistant__head {
        display: flex;
        gap: var(--space-3);
        align-items: flex-start;
      }
      .assistant__avatar {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: 2.5rem;
        block-size: 2.5rem;
        flex: none;
        border-radius: var(--radius-md);
        background: var(--gradient-brand);
        color: #ffffff;
      }
      .assistant__lede {
        margin: var(--space-1) 0 0;
        color: var(--color-text-muted);
        font-size: var(--text-xs);
      }
      .chips {
        display: grid;
        gap: var(--space-2);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .chips__item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-surface);
        color: var(--color-text);
        font-size: var(--text-xs);
        text-decoration: none;
      }
      .chips__item:hover {
        border-color: var(--color-primary);
        color: var(--color-primary-text);
      }
      .askbot {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-pill);
        background: var(--color-surface);
      }
      .askbot:focus-within {
        border-color: var(--color-primary);
        box-shadow: var(--focus-ring);
      }
      .askbot__input {
        flex: 1 1 auto;
        min-inline-size: 0;
        border: none;
        background: none;
        color: var(--color-text);
        font: inherit;
        font-size: var(--text-sm);
        outline: none;
      }
      .askbot__send {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: 2.25rem;
        block-size: 2.25rem;
        flex: none;
        border: none;
        border-radius: var(--radius-pill);
        background: var(--color-primary);
        color: var(--color-primary-contrast);
        cursor: pointer;
      }
      .askbot__send:disabled {
        opacity: 0.5;
        cursor: default;
      }

      /* ---- alerts ---- */
      .rows--alerts {
        gap: var(--space-3);
      }
      .row--alert {
        align-items: flex-start;
      }
      .alert__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: 2rem;
        block-size: 2rem;
        flex: none;
        border-radius: var(--radius-sm);
      }
      .alert__icon--critical {
        background: var(--color-danger-soft);
        color: var(--color-danger);
      }
      .alert__icon--warning {
        background: var(--color-warning-soft);
        color: var(--color-warning);
      }
      .alert__icon--info {
        background: var(--color-info-soft);
        color: var(--color-info);
      }
      .alert__icon--positive {
        background: var(--color-success-soft);
        color: var(--color-success);
      }
    `,
  ],
})
export class DashboardComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly snapshot = inject(SnapshotService);
  private readonly router = inject(Router);

  readonly data = signal<DashboardFigures | null>(null);
  readonly panels = signal<Panels | null>(null);
  /**
   * Whether the panel round trip failed.
   *
   * Distinct from "the panels are empty", and the distinction is the point: an unloaded panel must not
   * render "nothing spent yet this month", which is a claim about the Household's money made from a
   * request that never arrived. ADR-027's 4.2.8b amendment is why there is no cached form to fall back
   * on — a spending analysis has no honest offline shape — so the honest state is a sentence saying so.
   */
  readonly panelsUnavailable = computed(() => this.panels() === null && !this.loading());
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly question = signal('');

  /**
   * The podaci od <time> line, or null when the figures are live.
   *
   * Read from the snapshot service rather than kept locally, so the header chip and this screen label the
   * same moment (ADR-027 decisions 4 and 5). Live figures render **no** label: if everything were
   * labelled, the label would stop meaning anything.
   */
  readonly staleLabel = computed(() => {
    const syncedAt = this.snapshot.staleAt();
    return syncedAt === null ? null : syncedAtLabel(syncedAt, this.i18n.tag());
  });

  /** The greeting is the reader's clock, not the Household's — see greetingKey. */
  readonly greeting = computed(() =>
    this.i18n.t(greetingKey(new Date().getHours())),
  );

  /**
   * The pure view helpers the template calls directly.
   *
   * Exposed as fields rather than re-implemented in the template because they are *rules* — the rounding,
   * the sign and the "no basis for comparison" case — and a template is not a place a rule can be tested.
   */
  protected readonly percentLabel = percentLabel;
  protected readonly amountText = amountText;

  /** The budget, in major units, for the "of 300.000,00 RSD" line. */
  readonly budgetText = computed(() => moneyText(this.data()?.monthlyBudget));

  /** The spent-this-month figure as in-sentence text, for the donut's centre. */
  readonly spentText = computed(() => moneyText(this.data()?.spentThisMonth));

  /** Safe-to-spend today, as in-sentence text. */
  readonly safeTodayText = computed(() => moneyText(this.data()?.safeToSpendToday));

  /**
   * How much of the budget is used, as a 0…1 ratio — computed by @finmate/domain.
   *
   * The client never divides two amounts by hand: shareOfTotal is the same pure function the API's own
   * calculators use, so the bar and the figure beside it cannot disagree about the arithmetic.
   */
  readonly usedRatio = computed(() => {
    const d = this.data();
    if (!d?.monthlyBudget) return 0;
    return shareOfTotal(BigInt(d.spentThisMonth.amountMinor), BigInt(d.monthlyBudget.amountMinor));
  });

  readonly usedPercent = computed(() => percentLabel(this.usedRatio()) ?? '0%');

  /**
   * How much is already over, or null while inside the budget.
   *
   * available is a signed Balance, so this reads as an overspend only once it has gone negative — see
   * `overspendText`, which owns that sign and is covered by `money-text.spec.ts`.
   */
  readonly overrunText = computed(() => overspendText(this.data()?.available));

  /** How much the month is *projected* to overshoot, or null when the projection is inside budget. */
  readonly projectedOverText = computed(() => overrunText(this.data()?.projectedOverrun));

  // ---- the panels, all computed from one response ------------------------------------------------

  /** The daily expense series, for the "spent" tile's bars. */
  readonly spentSeries = computed(() =>
    seriesFromBuckets(this.panels()?.spendOverTime ?? [], 'expenseTotal'),
  );

  /** The daily income series, for the "income" tile's bars. */
  readonly incomeSeries = computed(() =>
    seriesFromBuckets(this.panels()?.spendOverTime ?? [], 'incomeTotal'),
  );

  /**
   * Six months of expense, for the projection tile's line.
   *
   * A **different series** from the spent tile's bars on purpose: the projection is a claim about the
   * shape of a month, and the honest thing to sit beside it is how the last six actually went, not the
   * same thirty days drawn twice.
   */
  readonly historySeries = computed(() =>
    (this.panels()?.cashflow ?? []).map((bucket) => ({
      value: Number(bucket.expense.amountMinor),
      label: bucket.bucketStart,
    })),
  );

  /**
   * The month-over-month deltas, computed by @finmate/domain's own changeRatio.
   *
   * The last cashflow bucket is the current month and the one before it is the prior month, because the
   * history range ends at the period the dashboard named. null when there is no prior bucket at all —
   * which renders no chip rather than a "0 %".
   */
  private readonly deltas = computed(() => {
    const buckets = this.panels()?.cashflow ?? [];
    const current = buckets.at(-1);
    const prior = buckets.at(-2);
    if (!current || !prior) return { income: null, spent: null } as const;

    return {
      income: changeRatio(BigInt(current.income.amountMinor), BigInt(prior.income.amountMinor)),
      spent: changeRatio(BigInt(current.expense.amountMinor), BigInt(prior.expense.amountMinor)),
    } as const;
  });

  readonly incomeDelta = computed(() => deltaLabel(this.deltas().income));
  readonly spentDelta = computed(() => deltaLabel(this.deltas().spent));
  readonly incomeTone = computed(() => deltaTone(this.deltas().income, 'income'));
  readonly spentTone = computed(() => deltaTone(this.deltas().spent, 'expense'));

  /** The top Categories, biggest first — the server's order, never re-sorted here. */
  readonly categoryRows = computed<readonly CategoryRow[]>(() =>
    (this.panels()?.spendByCategory ?? []).slice(0, 6).map((row, index) => ({
      id: row.categoryId ?? `uncategorised-${index}`,
      name: row.category?.name ?? this.i18n.t('dashboard.uncategorised'),
      icon: row.category?.icon ?? null,
      tint: categoryTint(row.category?.color, index),
      total: row.total,
      share: row.shareOfTotal,
    })),
  );

  readonly donutSegments = computed<readonly DonutSegment[]>(() =>
    this.categoryRows().map((row) => ({
      label: row.name,
      share: row.share ?? 0,
      color: row.tint,
    })),
  );

  readonly goalRows = computed<readonly GoalRow[]>(() => (this.panels()?.savingGoals ?? []).slice(0, 2));

  readonly recentRows = computed<readonly RecentRow[]>(() => {
    const panels = this.panels();
    if (!panels) return [];
    const names = new Map(panels.categories.map((category) => [category.id, category]));

    return panels.transactions.edges.map(({ node }) => ({
      id: node.id,
      description: node.description,
      categoryName: node.categoryId ? (names.get(node.categoryId)?.name ?? null) : null,
      amount: node.amount,
      kind: node.kind,
      occurredLocalDate: node.occurredLocalDate,
    }));
  });

  readonly alertRows = computed<readonly AlertRow[]>(() =>
    (this.panels()?.notifications.edges ?? []).map(({ node }) => ({
      id: node.id,
      title: node.title,
      body: node.body,
      severity: severityOf(node.insightSeverity),
      createdAt: node.createdAt,
      read: node.readAt !== null,
    })),
  );

  readonly suggestions = computed(() => (this.panels()?.assistantSuggestions ?? []).slice(0, 4));

  /**
   * The grouped bars, with their accessible sentences.
   *
   * Built here rather than in the component because the sentence is a translated string, and the chart is
   * deliberately i18n-free: it draws what it is given. The bucket's **day of the month** is the axis label
   * (1, 5, 10), which is what the mockup's x axis reads.
   */
  readonly barBuckets = computed<readonly BarBucket[]>(() =>
    (this.panels()?.spendOverTime ?? []).map((bucket) => {
      const day = String(Number(bucket.bucketStart.slice(8, 10)));
      const income = amountText(bucket.incomeTotal);
      const expense = amountText(bucket.expenseTotal);

      return {
        label: bucket.bucketStart,
        shortLabel: day,
        ariaLabel: this.i18n.t('dashboard.bucketLabel', { day, income, expense }),
        values: [
          { key: 'expense', value: Number(bucket.expenseTotal.amountMinor), display: expense },
          { key: 'income', value: Number(bucket.incomeTotal.amountMinor), display: income },
        ],
      };
    }),
  );

  readonly barSeries = computed<readonly BarSeries[]>(() => [
    { key: 'income', label: this.i18n.t('dashboard.legendIncome'), token: '--chart-income' },
    { key: 'expense', label: this.i18n.t('dashboard.legendExpense'), token: '--chart-expense' },
  ]);

  constructor() {
    void this.load();
  }

  /** The icon a delta's tone draws: up is a rise, down is a fall, flat has none. */
  deltaIcon(tone: 'up' | 'down' | 'flat'): 'arrowUp' | 'arrowDown' {
    return tone === 'up' ? 'arrowUp' : 'arrowDown';
  }

  /** The icon an alert's severity draws. */
  alertIcon(severity: AlertRow['severity']): 'alert' | 'info' | 'check' {
    if (severity === 'CRITICAL' || severity === 'WARNING') return 'alert';
    if (severity === 'POSITIVE') return 'check';
    return 'info';
  }

  /** A goal's "due in N months · X per month" footnote, in one of the shapes the data allows. */
  goalFootnote(goal: GoalRow): string {
    const perMonth = amountText(goal.requiredPerMonth);
    if (goal.monthsRemaining === null) {
      return perMonth === '' ? '' : this.i18n.t('dashboard.goalPerMonth', { amount: perMonth });
    }
    return this.i18n.t('dashboard.goalDue', {
      months: goal.monthsRemaining,
      amount: perMonth,
    });
  }

  /** 1 Sep – 30 Sep, in the active locale, from the period the server named. */
  rangeLabel(start: string, end: string): string {
    const format = (date: string): string =>
      new Intl.DateTimeFormat(this.i18n.tag(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
        new Date(`${date}T00:00:00Z`),
      );
    return `${format(start)} – ${format(end)}`;
  }

  /** A day as 10 Sep, for a transaction row. */
  shortDate(date: string): string {
    return new Intl.DateTimeFormat(this.i18n.tag(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
      new Date(`${date}T00:00:00Z`),
    );
  }

  /** A moment as 14:05, for an alert row. */
  timeOf(instant: string): string {
    return new Intl.DateTimeFormat(this.i18n.tag(), { hour: '2-digit', minute: '2-digit' }).format(
      new Date(instant),
    );
  }

  protected onQuestion(event: Event): void {
    this.question.set((event.target as HTMLInputElement).value);
  }

  /** Send the composer's question to the assistant screen, which answers it on entry. */
  askAssistant(event: Event): void {
    event.preventDefault();
    const question = this.question().trim();
    if (question === '') return;
    void this.router.navigate(['/assistant'], { queryParams: { q: question } });
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    let figures: DashboardFigures;
    try {
      const result = await this.graphql.query<{ dashboard: DashboardFigures }>(DASHBOARD_QUERY);
      figures = result.dashboard;
    } catch (error) {
      // A read is a read: every failure — offline, 5xx, a rejected token — falls back to the snapshot.
      // isRetryable is the *outbox*'s classifier and has nothing to say about a read.
      const cached = await this.cachedFigures();
      if (cached !== null) {
        // The server's own numbers, rendered exactly as cached: no zeroes, no extrapolation, and
        // paceIsReliable and the no-budget arm are whatever the payload said (ADR-027 decision 3).
        this.data.set(cached);
        // The panels are deliberately not cached (ADR-027's 4.2.8b amendment: an analysis has no honest
        // offline form), so this is the state that renders the "needs a connection" sentence rather than
        // an empty chart.
        this.panels.set(null);
      } else {
        // A failed read must not leave a *previous* read's figures on screen: the label tracks the
        // snapshot, and there is no snapshot here, so nothing may render (ADR-027 decisions 2 and 3).
        this.data.set(null);
        this.error.set(this.errors.for(error));
      }
      this.loading.set(false);
      return;
    }

    this.data.set(figures);
    this.loading.set(false);

    // Caching is a side effect of a successful read, never a reason to hide one: a store that will not
    // open must not turn a live dashboard into an error screen.
    try {
      await this.snapshot.writeDashboard(figures);
    } catch {
      // Nothing to say to the user — the live figures are already rendered and correct.
    }

    // The panels follow the figures, because their range is the period the server just named.
    if (figures.periodStart && figures.periodEnd) {
      await this.loadPanels(figures.periodStart, figures.periodEnd);
    }
  }

  /**
   * The panels, in one round trip.
   *
   * A separate call and a **separate failure**: the KPI row is the product's headline and must survive a
   * panel query that fails, so a failure here leaves panels at null and the panels area says the
   * breakdowns need a connection rather than blanking the figures above it.
   */
  private async loadPanels(periodStart: string, periodEnd: string): Promise<void> {
    const historyStart = this.sixMonthsBefore(periodStart);
    try {
      const panels = await this.graphql.query<Panels>(PANELS_QUERY, {
        range: { start: periodStart, end: periodEnd },
        history: { start: historyStart, end: periodEnd },
      });
      this.panels.set(panels);
    } catch {
      this.panels.set(null);
    }
  }

  /** The first day of the month six months before date, as a YYYY-MM-DD day. */
  private sixMonthsBefore(date: string): string {
    const [year, month] = date.split('-').map(Number);
    const shifted = new Date(Date.UTC(year!, month! - 1 - 6, 1));
    return shifted.toISOString().slice(0, 10);
  }

  /** The snapshot's figures, or null when there is none, it expired, or the store would not open. */
  private async cachedFigures(): Promise<DashboardFigures | null> {
    try {
      return (await this.snapshot.readDashboard())?.figures ?? null;
    } catch {
      // An unreadable store is the same as no snapshot: keep the honest error state rather than inventing
      // a figure (ADR-027 decision 3).
      return null;
    }
  }
}

/** The notification's severity, narrowed from the API's open string. */
function severityOf(value: string | null): AlertRow['severity'] {
  return value === 'CRITICAL' || value === 'WARNING' || value === 'POSITIVE' ? value : 'INFO';
}
