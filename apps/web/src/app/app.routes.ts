import type { Routes } from '@angular/router';

import { anonymousGuard, authenticatedGuard } from './core/auth/auth.guard';
import { onboardingGuard } from './core/onboarding/onboarding.guard';

/**
 * Routes.
 *
 * Every protected route is lazy: the capture screen and the analytics charts are large and a
 * sign-in page has no business downloading either (docs/07 §11 bundle budgets). `loadComponent`
 * keeps the initial bundle to the shell plus the landing route.
 */
export const routes: Routes = [
  {
    path: 'sign-in',
    canActivate: [anonymousGuard],
    loadComponent: () => import('./features/auth/sign-in.component').then((m) => m.SignInComponent),
    title: 'Prijava',
  },
  {
    path: 'sign-up',
    canActivate: [anonymousGuard],
    loadComponent: () => import('./features/auth/sign-up.component').then((m) => m.SignUpComponent),
    title: 'Registracija',
  },
  {
    path: 'onboarding',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/onboarding/onboarding.component').then((m) => m.OnboardingComponent),
    title: 'Podešavanje',
  },
  {
    path: '',
    // The dashboard is the only guarded entry point: sign-in lands here, which is the case docs/02
    // FL-01 §3 describes. Skipping onboarding has to leave the rest of the app reachable.
    canActivate: [authenticatedGuard, onboardingGuard],
    loadComponent: () =>
      import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
    title: 'Pregled',
  },
  {
    path: 'accounts',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/accounts/accounts.component').then((m) => m.AccountsComponent),
    title: 'Računi',
  },
  {
    path: 'capture',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/capture/capture.component').then((m) => m.CaptureComponent),
    title: 'Novi unos',
  },
  {
    path: 'transactions',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/transactions/transactions.component').then((m) => m.TransactionsComponent),
    title: 'Transakcije',
  },
  {
    path: 'analytics',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/analytics/analytics.component').then((m) => m.AnalyticsComponent),
    title: 'Analitika',
  },
  {
    path: 'assistant',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/assistant/assistant.component').then((m) => m.AssistantComponent),
    title: 'Asistent',
  },
  {
    path: 'review',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/review/review.component').then((m) => m.ReviewComponent),
    title: 'Provera',
  },
  {
    path: 'counterparties',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/counterparties/counterparties.component').then(
        (m) => m.CounterpartiesComponent,
      ),
    title: 'Osobe i firme',
  },
  {
    path: 'tags',
    canActivate: [authenticatedGuard],
    loadComponent: () => import('./features/tags/tags.component').then((m) => m.TagsComponent),
    title: 'Oznake',
  },
  {
    path: 'merchants',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/merchants/merchants.component').then((m) => m.MerchantsComponent),
    title: 'Prodavci',
  },
  {
    path: 'categories',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/categories/categories.component').then((m) => m.CategoriesComponent),
    title: 'Kategorije',
  },
  {
    path: 'rules',
    canActivate: [authenticatedGuard],
    loadComponent: () => import('./features/rules/rules.component').then((m) => m.RulesComponent),
    title: 'Pravila',
  },
  {
    path: 'notifications',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/notifications/notifications.component').then(
        (m) => m.NotificationsComponent,
      ),
    title: 'Obaveštenja',
  },
  {
    path: 'budgets',
    canActivate: [authenticatedGuard],
    loadComponent: () =>
      import('./features/budgets/budgets.component').then((m) => m.BudgetsComponent),
    title: 'Budžeti',
  },
  {
    path: '**',
    loadComponent: () =>
      import('./features/not-found/not-found.component').then((m) => m.NotFoundComponent),
    title: 'Nije pronađeno',
  },
];
