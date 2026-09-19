import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import { AvatarLoaderComponent } from '../../shared/ui/avatar-loader/avatar-loader.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { todayLocally } from '../capture/capture.view';
import {
  categoryLabel,
  changeIcon,
  changeKind,
  changeLabelKey,
  csvHref,
  drillThroughQuery,
  monthKeyOf,
  monthOptions,
  monthRange,
  periodLabel,
  rootRows,
  sharePercent,
  shiftMonthKey,
  sparklinePoints,
  trendLabelKey,
  trendDirection,
  trendRange,
  type AnalyticsData,
  type CategorySpendRow,
} from './analytics.view';

/**
 * Analytics — F-20, docs/02 §4.15, docs/06 §4.3.
 *
 * ## The screen asks; it never computes
 *
 * One GraphQL request per period carries every section: the category bars, the monthly trend, the top
 * merchants and the month-over-month comparison are four root fields of **one** operation, which is
 * what docs/02 §4.15 means by "one query drives every chart for the selected period". Every amount is
 * rendered by `fm-money` (ADR-003); nothing here adds, subtracts or converts money. The only
 * arithmetic is geometry ({@link sparklinePoints}) and whole-percent rounding of a ratio the server
 * already computed.
 *
 * ## Why the bars are a list and not `role="img"`
 *
 * docs/07 §7.3 wants every chart to carry an `aria-label` stating the takeaway and a table
 * equivalent. The bars carry a **link** to the filtered transactions, and an element with
 * `role="img"` hides its descendants from assistive technology — so a list of labelled, linked rows
 * with a visible amount and share is both more accessible and more useful than an image of itself.
 * The sparkline, which carries no text at all, *is* `role="img"` with a label saying which way the
 * months went. Both sections have their table in the DOM (inside `<details>`), which is the
 * equivalent docs/07 §7.3 requires.
 *
 * ## What is deliberately absent
 *
 * No chart library: a new dependency needs an ADR (ADR-004). The bars are CSS and the trend is one
 * `<polyline>`. `cashflow` (docs/06 §4.3) is **not fetched** — F-20 asks for category trends,
 * month-over-month and top merchants, and docs/02 §4.15 draws no cashflow panel; the query stays
 * honest by returning only what the screen renders.
 *
 * @module apps/web/src/app/features/analytics
 */
@Component({
  selector: 'fm-analytics',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, MoneyComponent, AvatarLoaderComponent],
  template: `
    <div class="fm-page">
      <header class="fm-page__head">
        <div>
          <h1 class="fm-page__title">{{ i18n.t('analytics.title') }}</h1>
          <p class="fm-page__sub">{{ i18n.t('analytics.subtitle') }}</p>
        </div>
      </header>

      <div class="controls">
        <span class="controls__field">
          <label for="analytics-period">{{ i18n.t('analytics.period') }}</label>
          <select id="analytics-period" [value]="period()" (change)="onPeriodChange($event)">
            @for (key of months(); track key) {
              <option [value]="key">{{ label(key) }}</option>
            }
          </select>
        </span>

        <span class="pager" (keydown)="onPagerKeydown($event)">
          <button
            type="button"
            class="pager__button"
            [attr.aria-label]="i18n.t('analytics.previous')"
            (click)="shiftPeriod(-1)"
          >
            <fm-icon name="chevronLeft" [size]="16" />
          </button>
          <button
            type="button"
            class="pager__button"
            [attr.aria-label]="i18n.t('analytics.next')"
            (click)="shiftPeriod(1)"
          >
            <fm-icon name="chevronRight" [size]="16" />
          </button>
        </span>

        <span class="controls__field">
          <label for="analytics-compare">{{ i18n.t('analytics.compareTo') }}</label>
          <select id="analytics-compare" [value]="compareTo()" (change)="onCompareChange($event)">
            @for (key of months(); track key) {
              <option [value]="key">{{ label(key) }}</option>
            }
          </select>
        </span>

        <a class="controls__csv" [href]="csv()" download>{{ i18n.t('analytics.export') }}</a>
      </div>

      @if (error()) {
        <p class="alert" role="alert">{{ error() }}</p>
      }

      @if (data(); as view) {
        <section class="fm-card" aria-labelledby="analytics-trend">
          <h2 class="fm-card__title" id="analytics-trend">{{ i18n.t('analytics.trend') }}</h2>
          <svg
            class="spark"
            viewBox="0 0 100 32"
            preserveAspectRatio="none"
            role="img"
            [attr.aria-label]="trendAria()"
          >
            <polyline class="spark__line" [attr.points]="sparkPoints()" />
          </svg>
          <details class="more">
            <summary>{{ i18n.t('analytics.table') }}</summary>
            <table class="table">
              <caption class="visually-hidden">{{ i18n.t('analytics.trend') }}</caption>
              <thead>
                <tr>
                  <th scope="col">{{ i18n.t('analytics.period') }}</th>
                  <th scope="col">{{ i18n.t('analytics.tableTotal') }}</th>
                  <th scope="col">{{ i18n.t('analytics.tableCount') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (bucket of view.spendOverTime; track bucket.bucketStart) {
                  <tr>
                    <th scope="row">{{ label(monthKeyOf(bucket.bucketStart)) }}</th>
                    <td><fm-money [amount]="bucket.expenseTotal" /></td>
                    <td>{{ bucket.transactionCount }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </details>
        </section>

        <section class="fm-card" aria-labelledby="analytics-categories">
          <h2 class="fm-card__title" id="analytics-categories">
            {{ i18n.t('analytics.spendByCategory') }}
          </h2>
          <p class="muted">{{ i18n.t('analytics.rootsHint') }}</p>

          @if (chartRows().length === 0) {
            <p class="muted">{{ i18n.t('analytics.empty', { period: label(period()) }) }}</p>
          } @else {
            <ul class="bars" [attr.aria-label]="chartAria()">
              @for (row of chartRows(); track row.categoryId ?? 'none') {
                <li class="bar">
                  <span class="bar__head">
                    @if (drill(row); as query) {
                      <a
                        class="bar__label"
                        [routerLink]="['/transactions']"
                        [queryParams]="query"
                        >{{ name(row) }}</a
                      >
                    } @else {
                      <span class="bar__label">{{ name(row) }}</span>
                    }
                    <fm-money class="bar__amount" [amount]="row.total" />
                    <span class="bar__share">{{ percent(row.shareOfTotal) }} %</span>
                    <span class="bar__change">
                      @if (changeIcon(changeKind(row.changeRatio)); as icon) {
                        <fm-icon [name]="icon" [size]="14" />
                      }
                      <span class="visually-hidden">{{ changeText(row.changeRatio) }}</span>
                    </span>
                  </span>
                  <span class="bar__track" aria-hidden="true">
                    <span class="bar__fill" [style.inline-size.%]="percent(row.shareOfTotal)"></span>
                  </span>
                </li>
              }
            </ul>
          }

          <details class="more">
            <summary>{{ i18n.t('analytics.table') }}</summary>
            <table class="table">
              <caption class="visually-hidden">{{ i18n.t('analytics.spendByCategory') }}</caption>
              <thead>
                <tr>
                  <th scope="col">{{ i18n.t('analytics.tableCategory') }}</th>
                  <th scope="col">{{ i18n.t('analytics.tableTotal') }}</th>
                  <th scope="col">{{ i18n.t('analytics.tableShare') }}</th>
                  <th scope="col">{{ i18n.t('analytics.tableCount') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (row of view.spendByCategory; track row.categoryId ?? 'none') {
                  <tr>
                    <th scope="row">{{ name(row) }}</th>
                    <td><fm-money [amount]="row.total" /></td>
                    <td>{{ percent(row.shareOfTotal) }} %</td>
                    <td>{{ row.transactionCount }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </details>
        </section>

        <section class="fm-card" aria-labelledby="analytics-merchants">
          <h2 class="fm-card__title" id="analytics-merchants">
            {{ i18n.t('analytics.topMerchants') }}
          </h2>
          @if (view.topMerchants.length === 0) {
            <p class="muted">{{ i18n.t('analytics.merchantsEmpty', { period: label(period()) }) }}</p>
          } @else {
            <ul class="plain">
              @for (merchant of view.topMerchants; track merchant.displayName) {
                <li class="plain__row">
                  <span class="plain__label">{{ merchant.displayName }}</span>
                  <fm-money [amount]="merchant.total" />
                </li>
              }
            </ul>
          }
        </section>

        <section class="fm-card" aria-labelledby="analytics-comparison">
          <h2 class="fm-card__title" id="analytics-comparison">
            {{ i18n.t('analytics.comparison', { period: label(view.monthComparison.compareTo) }) }}
          </h2>
          <ul class="plain">
            <li class="plain__row">
              <span class="plain__label">{{ label(view.monthComparison.period) }}</span>
              <fm-money [amount]="view.monthComparison.total" />
            </li>
            <li class="plain__row">
              <span class="plain__label">{{ i18n.t('analytics.comparisonPrior') }}</span>
              <fm-money [amount]="view.monthComparison.compareTotal" />
            </li>
            <li class="plain__row plain__row--total">
              <span class="plain__label">{{ i18n.t('analytics.comparisonDelta') }}</span>
              <fm-money [amount]="view.monthComparison.delta" />
              <span class="plain__ratio">{{ changeText(view.monthComparison.deltaRatio) }}</span>
            </li>
          </ul>

          @if (comparisonRows().length > 0) {
            <details class="more">
              <summary>{{ i18n.t('analytics.table') }}</summary>
              <table class="table">
                <caption class="visually-hidden">
                  {{ i18n.t('analytics.comparison', { period: label(view.monthComparison.compareTo) }) }}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{{ i18n.t('analytics.tableCategory') }}</th>
                    <th scope="col">{{ i18n.t('analytics.comparisonNow', { period: label(view.monthComparison.period) }) }}</th>
                    <th scope="col">{{ i18n.t('analytics.comparisonPrior') }}</th>
                    <th scope="col">
                      {{ i18n.t('analytics.tableChange', { period: label(view.monthComparison.compareTo) }) }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of comparisonRows(); track row.categoryId ?? 'none') {
                    <tr>
                      <th scope="row">{{ name(row) }}</th>
                      <td><fm-money [amount]="row.total" /></td>
                      <td>
                        @if (row.priorPeriodTotal; as prior) {
                          <fm-money [amount]="prior" />
                        } @else {
                          <span aria-hidden="true">—</span>
                        }
                      </td>
                      <td>{{ changeText(row.changeRatio) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </details>
          }
        </section>
      } @else if (loading()) {
        <!-- The analysis arrives as panels, so the placeholder is panel-shaped rather than one line. -->
        <fm-avatar-loader variant="card" [rows]="4" labelKey="analytics.loading" />
      }
    </div>
  `,
  styles: [
    `
      .muted {
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        align-items: flex-end;
      }
      .controls__field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-inline-size: 0;
        font-size: var(--text-sm);
      }
      .controls__field select {
        max-inline-size: 100%;
      }
      .controls__csv {
        margin-inline-start: auto;
      }
      .pager {
        display: flex;
        gap: var(--space-1);
      }
      .pager__button {
        min-inline-size: var(--control-size);
        font-size: var(--text-lg);
        line-height: 1;
      }
      .spark {
        inline-size: 100%;
        block-size: 4rem;
      }
      .spark__line {
        fill: none;
        /* --chart-1, from the token layer's chart ramp. This used var(--color-accent, currentColor), and
           --color-accent has never existed — so the fallback always won and the whole trend line was
           painted in --color-text: white on dark, black on light (measured in the ADR-039 audit). */
        stroke: var(--chart-1);
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
      }
      .bars {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .bar {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-inline-size: 0;
      }
      .bar__head {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: baseline;
      }
      .bar__label {
        min-inline-size: 0;
        overflow-wrap: anywhere;
      }
      .bar__amount {
        margin-inline-start: auto;
      }
      .bar__share,
      .bar__change {
        font-variant-numeric: tabular-nums;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .bar__track {
        display: block;
        block-size: 0.5rem;
        border-radius: var(--radius-sm);
        background: var(--color-border);
        overflow: hidden;
      }
      .bar__fill {
        display: block;
        block-size: 100%;
        /* Same dead token: the category bars were ink. */
        background: var(--chart-1);
      }
      .plain {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .plain__row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: baseline;
        padding-block: var(--space-1);
        border-block-start: 1px solid var(--color-border);
      }
      .plain__row--total {
        font-weight: 600;
      }
      .plain__label {
        min-inline-size: 0;
        overflow-wrap: anywhere;
      }
      .plain__ratio {
        margin-inline-start: auto;
        font-size: var(--text-sm);
        font-weight: 400;
        color: var(--color-text-muted);
      }
      .more summary {
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
        /* Padding, not min-block-size: the disclosure marker needs display: list-item (4.3.1e). */
        padding-block: var(--space-3);
      }
      .table {
        inline-size: 100%;
        border-collapse: collapse;
        margin-block-start: var(--space-2);
        font-size: var(--text-sm);
      }
      .table th,
      .table td {
        text-align: start;
        padding: var(--space-1) var(--space-2);
        border-block-end: 1px solid var(--color-border);
      }
      .table td:not(:first-child) {
        font-variant-numeric: tabular-nums;
      }
      .visually-hidden {
        position: absolute;
        inline-size: 1px;
        block-size: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
    `,
  ],
})
export class AnalyticsComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);

  /** The device's own month; the server is asked for a range the user chose, never for "now". */
  private readonly currentMonth = monthKeyOf(todayLocally());

  readonly period = signal(this.currentMonth);
  readonly compareTo = signal(shiftMonthKey(this.currentMonth, -1));
  readonly data = signal<AnalyticsData | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly months = computed(() => {
    // The anchor moves with the selection, so paging back a year does not empty the `<select>`.
    const anchor = this.period() > this.currentMonth ? this.period() : this.currentMonth;
    return monthOptions(anchor);
  });

  /** The display set: the roots plus the uncategorised bucket (docs/06 §4.3). */
  readonly chartRows = computed(() => rootRows(this.data()?.spendByCategory ?? []));

  /** The comparison table drops the rows with no spend in either month. */
  readonly comparisonRows = computed(() =>
    (this.data()?.monthComparison.categories ?? []).filter(
      (row) => row.total.amountMinor !== '0' || (row.priorPeriodTotal?.amountMinor ?? '0') !== '0',
    ),
  );

  readonly sparkPoints = computed(() => sparklinePoints(this.data()?.spendOverTime ?? []));

  constructor() {
    void this.load();
  }

  /** The view module's decision, re-exposed for the template without logic in it. */
  readonly monthKeyOf = monthKeyOf;

  /**
   * The change indicator's icon and the state it is drawn from.
   *
   * Exposed as fields because the decision is a *rule* — which of the four states a ratio is, and
   * which glyph that state draws — and a template is not a place a rule can be tested.
   */
  readonly changeIcon = changeIcon;
  readonly changeKind = changeKind;

  label(key: string): string {
    return periodLabel(key, this.i18n.tag());
  }

  percent(share: number): number {
    return sharePercent(share);
  }

  name(row: CategorySpendRow): string {
    return categoryLabel(row, this.i18n.t('analytics.uncategorised'));
  }

  /**
   * A ratio in words: *više 20 %*, *manje 40 %*, *nepromenjeno* — or *nema osnova za poređenje* when
   * the baseline is zero. The last one is a sentence, not a figure, which is the whole point
   * (docs/02 §4.15): there is no ratio to print.
   */
  changeText(ratio: number | null): string {
    const kind = changeKind(ratio);
    const label = this.i18n.t(changeLabelKey(kind));
    if (kind === 'NO_BASIS' || ratio === null) return label;
    return label + ' ' + Math.round(Math.abs(ratio) * 100) + ' %';
  }

  drill(row: CategorySpendRow): Record<string, string> | null {
    return drillThroughQuery(monthRange(this.period()), row);
  }

  csv(): string {
    return csvHref(monthRange(this.period()));
  }

  /** The chart's spoken takeaway: the period, not the figures — those are in the table. */
  chartAria(): string {
    return this.i18n.t('analytics.chartLabel', { period: this.label(this.period()) });
  }

  trendAria(): string {
    const buckets = this.data()?.spendOverTime ?? [];
    const key = trendLabelKey(trendDirection(buckets));
    const first = buckets[0]?.bucketStart;
    return this.i18n.t(key, {
      count: buckets.length,
      period: this.label(this.period()),
      first: first === undefined ? this.label(this.period()) : this.label(monthKeyOf(first)),
    });
  }

  onPeriodChange(event: Event): void {
    this.setPeriod((event.target as HTMLSelectElement).value);
  }

  onCompareChange(event: Event): void {
    this.compareTo.set((event.target as HTMLSelectElement).value);
    void this.load();
  }

  shiftPeriod(delta: number): void {
    this.setPeriod(shiftMonthKey(this.period(), delta));
  }

  /** docs/02 §4.15: `[` and `]` move the period on desktop. */
  onPagerKeydown(event: KeyboardEvent): void {
    if (event.key === '[') {
      event.preventDefault();
      this.shiftPeriod(-1);
    } else if (event.key === ']') {
      event.preventDefault();
      this.shiftPeriod(1);
    }
  }

  private setPeriod(period: string): void {
    this.period.set(period);
    // The baseline follows the period unless the user has chosen one; keeping the old `compareTo`
    // would silently compare March with January after two clicks.
    this.compareTo.set(shiftMonthKey(period, -1));
    void this.load();
  }

  private range() {
    return monthRange(this.period());
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<AnalyticsData>(ANALYTICS_QUERY, {
        range: this.range(),
        // The trend covers six months ending at the selected one, so the sparkline has a shape even
        // when the selected month is empty.
        trendRange: trendRange(this.period()),
        period: this.period(),
        compareTo: this.compareTo(),
      });
      this.data.set({
        spendByCategory: result.spendByCategory,
        spendOverTime: result.spendOverTime,
        topMerchants: result.topMerchants,
        monthComparison: result.monthComparison,
      });
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }
}

/**
 * One operation for every panel — docs/02 §4.15's "one query drives every chart for the selected
 * period". `total`, `expenseTotal` and `delta` are `Money`/`Balance` **scalars**: they are selected
 * bare, because a selection set on a scalar is a validation error the client only sees at runtime
 * (the 3.2.4 defect, docs/15).
 */
const ANALYTICS_QUERY = /* GraphQL */ `
  query Analytics(
    $range: DateRangeInput!
    $trendRange: DateRangeInput!
    $period: String!
    $compareTo: String!
  ) {
    spendByCategory(range: $range) {
      categoryId
      category {
        id
        name
        path
        parentId
      }
      periodStart
      periodEnd
      total
      transactionCount
      shareOfTotal
      priorPeriodTotal
      changeRatio
      isSubtreeAggregate
    }
    spendOverTime(range: $trendRange, bucket: MONTH) {
      bucketStart
      bucketEnd
      expenseTotal
      incomeTotal
      transactionCount
    }
    topMerchants(range: $range, limit: 5) {
      merchantId
      displayName
      total
      transactionCount
    }
    monthComparison(period: $period, compareTo: $compareTo) {
      period
      compareTo
      total
      compareTotal
      delta
      deltaRatio
      categories {
        categoryId
        category {
          id
          name
          path
          parentId
        }
        periodStart
        periodEnd
        total
        transactionCount
        shareOfTotal
        priorPeriodTotal
        changeRatio
        isSubtreeAggregate
      }
    }
  }
`;
