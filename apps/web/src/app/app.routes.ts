import type { Routes } from '@angular/router';

import { anonymousGuard, authenticatedGuard, shellGuard } from './core/auth/auth.guard';
import { onboardingGuard } from './core/onboarding/onboarding.guard';

/**
 * Routes.
 *
 * Every protected route is lazy: the capture screen and the analytics charts are large and a
 * sign-in page has no business downloading either (docs/07 §11 bundle budgets). `loadComponent`
 * keeps the initial bundle to the shell plus the landing route.
 *
 * A `title` here is a **`route.*` translation key, not a string to display**. `LocalizedTitleStrategy`
 * (provided in `app.config.ts`) renders it in the active language and re-renders it when the switcher
 * changes locale. Serbian literals used to live in this table, so the browser tab ignored the language
 * setting entirely; `app.routes.spec.ts` now fails if a route names a key the catalogue does not have.
 */
export const routes: Routes = [
  {
    path: 'sign-in',
    canActivate: [anonymousGuard],
    loadComponent: () => import('./features/auth/sign-in.component').then((m) => m.SignInComponent),
    title: 'route.signIn',
  },
  {
    path: 'sign-up',
    canActivate: [anonymousGuard],
    loadComponent: () => import('./features/auth/sign-up.component').then((m) => m.SignUpComponent),
    title: 'route.signUp',
  },
  {
    // Reached from an email link, so **no guard**: `anonymousGuard` would bounce a signed-in visitor to
    // `/` and the reset would never happen, and a person who is signed in is exactly who clicks it
    // (docs/15). The token, not a session, is what authorises the change.
    path: 'reset-password',
    loadComponent: () =>
      import('./features/auth/reset-password.component').then((m) => m.ResetPasswordComponent),
    title: 'route.resetPassword',
  },
  {
    // Same reason as above: the confirmation link must work whether or not there is a session.
    path: 'verify-email',
    loadComponent: () =>
      import('./features/auth/verify-email.component').then((m) => m.VerifyEmailComponent),
    title: 'route.verifyEmail',
  },
  {
    path: 'onboarding',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/onboarding/onboarding.component').then((m) => m.OnboardingComponent),
    title: 'route.onboarding',
  },
  {
    path: '',
    // The dashboard is the only guarded entry point: sign-in lands here, which is the case docs/02
    // FL-01 §3 describes. Skipping onboarding has to leave the rest of the app reachable.
    canActivate: [authenticatedGuard, onboardingGuard],
    loadComponent: () =>
      import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
    title: 'route.dashboard',
  },
  {
    path: 'accounts',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/accounts/accounts.component').then((m) => m.AccountsComponent),
    title: 'route.accounts',
  },
  {
    path: 'capture',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/capture/capture.component').then((m) => m.CaptureComponent),
    title: 'route.capture',
  },
  {
    path: 'transactions',
    canActivate: [authenticatedGuard],
    // Offline-capable (ADR-033 decision 2): with the server unreachable this screen serves the
    // ledger cache read-only — the mode 4.2.8b built — and nothing else on it calls the API.
    data: { offline: true },
    loadComponent: () =>
      import('./features/transactions/transactions.component').then((m) => m.TransactionsComponent),
    title: 'route.transactions',
  },
  {
    // The drill-in (docs/02 §2.1): the list screen with the edit sheet opened for one row. The id is
    // read from `ActivatedRoute` alongside the query filters the same screen already owns.
    path: 'transactions/:id',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/transactions/transactions.component').then((m) => m.TransactionsComponent),
    title: 'route.transaction',
  },
  {
    path: 'goals',
    canActivate: [authenticatedGuard],
    loadComponent: () => import('./features/goals/goals.component').then((m) => m.GoalsComponent),
    title: 'route.goals',
  },
  {
    path: 'recurring',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/recurring/recurring.component').then((m) => m.RecurringComponent),
    title: 'route.recurring',
  },
  {
    path: 'analytics',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/analytics/analytics.component').then((m) => m.AnalyticsComponent),
    title: 'route.analytics',
  },
  {
    path: 'assistant',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/assistant/assistant.component').then((m) => m.AssistantComponent),
    title: 'route.assistant',
  },
  {
    path: 'review',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/review/review.component').then((m) => m.ReviewComponent),
    title: 'route.review',
  },
  {
    path: 'counterparties',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/counterparties/counterparties.component').then(
        (m) => m.CounterpartiesComponent,
      ),
    title: 'route.counterparties',
  },
  {
    path: 'tags',
    canActivate: [authenticatedGuard],
    loadComponent: () => import('./features/tags/tags.component').then((m) => m.TagsComponent),
    title: 'route.tags',
  },
  {
    path: 'merchants',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/merchants/merchants.component').then((m) => m.MerchantsComponent),
    title: 'route.merchants',
  },
  {
    path: 'categories',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/categories/categories.component').then((m) => m.CategoriesComponent),
    title: 'route.categories',
  },
  {
    path: 'rules',
    canActivate: [authenticatedGuard],
    loadComponent: () => import('./features/rules/rules.component').then((m) => m.RulesComponent),
    title: 'route.rules',
  },
  {
    path: 'receipts',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/receipts/receipts-list.component').then((m) => m.ReceiptsListComponent),
    title: 'route.receipts',
  },
  {
    // `withComponentInputBinding` binds `id` straight to the detail component's signal input
    // (app.config.ts), so the screen does not subscribe to the param map.
    path: 'receipts/:id',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/receipts/receipt-detail.component').then((m) => m.ReceiptDetailComponent),
    title: 'route.receipt',
  },
  {
    // docs/02 §4.18's settings shell, with the first section that had no home: the app lock
    // (task 4.2.6b). Most of the shell's sections already have a screen of their own and are linked
    // from here; the ones that do not are not built, and are not advertised.
    path: 'settings',
    canActivate: [authenticatedGuard],
    loadComponent: () => import('./features/settings/settings.component').then((m) => m.SettingsComponent),
    title: 'route.settings',
  },
  {
    path: 'notifications',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/notifications/notifications.component').then(
        (m) => m.NotificationsComponent,
      ),
    title: 'route.notifications',
  },
  {
    // ADR-026 decision 1: the pending tray is a route reached from the header's sync chip, not a nav
    // destination — the same shape as `/notifications`, so the review slot stays the only badged one.
    path: 'pending',
    canActivate: [authenticatedGuard],
    // The queue is local by construction, so this is the one screen an unlocked offline install
    // lands on (ADR-033 decision 2).
    data: { offline: true },
    loadComponent: () =>
      import('./features/pending/pending.component').then((m) => m.PendingComponent),
    title: 'route.pending',
  },
  {
    path: 'budgets',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/budgets/budgets.component').then((m) => m.BudgetsComponent),
    title: 'route.budgets',
  },
  {
    path: '**',
    // Restores a session when there is one, so the page renders in the shell a signed-in person expects,
    // and redirects nobody (see `shellGuard`).
    canActivate: [shellGuard],
    loadComponent: () =>
      import('./features/not-found/not-found.component').then((m) => m.NotFoundComponent),
    title: 'route.notFound',
  },
];
