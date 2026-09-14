/**
 * English catalogue — the **primary** language and the source of truth for the key set.
 *
 * `TranslationKey` is derived from this object, so every other locale is type-checked against it:
 * a missing or misspelled key is a compile error, not a runtime fallback to a raw key.
 *
 * Interpolation uses `{name}` placeholders. Whole sentences only — never concatenated fragments,
 * because Serbian case and gender agreement make fragment assembly produce nonsense (ADR-019).
 */
export const en = {
  // ---- application shell ----
  'app.name': 'FinMate',
  'app.skipToContent': 'Skip to content',
  'app.primaryNav': 'Main navigation',
  'app.language': 'Language',

  // ---- navigation ----
  'nav.dashboard': 'Overview',
  'nav.accounts': 'Accounts',

  // ---- session ----
  'session.signOut': 'Sign out',
  'session.signingOut': 'Signing out…',
  'session.signedInAs': 'Signed in as {role}',

  // ---- roles ----
  'role.OWNER': 'Owner',
  'role.ADMIN': 'Administrator',
  'role.MEMBER': 'Member',
  'role.VIEWER': 'Viewer',
  'role.unknown': 'user',

  // ---- sign in ----
  'signIn.title': 'Sign in',
  'signIn.email': 'Email',
  'signIn.password': 'Password',
  'signIn.submit': 'Sign in',
  'signIn.submitting': 'Signing in…',
  'signIn.noAccount': 'No account yet?',
  'signIn.register': 'Create one',

  // ---- sign up ----
  'signUp.title': 'Create account',
  'signUp.intro':
    'Creating an account gives you your own household — you can add family members later.',
  'signUp.displayName': 'Name',
  'signUp.email': 'Email',
  'signUp.password': 'Password',
  'signUp.passwordHint': 'At least {min} characters.',
  'signUp.submit': 'Create account',
  'signUp.submitting': 'Creating account…',
  'signUp.haveAccount': 'Already have an account?',
  'signUp.signIn': 'Sign in',

  // ---- dashboard ----
  'dashboard.title': 'Overview',
  'dashboard.nextStepTitle': 'Next step',
  'dashboard.nextStepBody': 'Add your first account so you can start tracking spending.',
  'dashboard.nextStepCta': 'Go to accounts',
  'dashboard.inProgressTitle': 'In progress',
  'dashboard.todo.naturalLanguage': 'Natural-language entry — “Lidl 2000” (Phase 2)',
  'dashboard.todo.budgets': 'Budgets and savings goals (Phase 1)',
  'dashboard.todo.safeToSpend': '“How much can I spend today?” (Phase 1)',
  'dashboard.todo.receipts': 'Receipts and per-item categorisation (Phase 4)',

  // ---- accounts ----
  'accounts.title': 'Accounts',
  'accounts.loading': 'Loading…',
  'accounts.count': '{shown} of {total}',
  'accounts.emptyTitle': 'No accounts yet',
  'accounts.emptyBody':
    'Add an account (cash, bank or card) so you can track balances and spending.',
  'accounts.newTitle': 'New account',
  'accounts.name': 'Name',
  'accounts.kind': 'Type',
  'accounts.openingBalance': 'Opening balance (in minor units)',
  'accounts.openingBalanceHint': 'e.g. 150000 for 1,500.00 RSD',
  'accounts.submit': 'Add account',
  'accounts.submitting': 'Adding…',

  // ---- account kinds ----
  'accountKind.CASH': 'Cash',
  'accountKind.BANK': 'Current account',
  'accountKind.CARD': 'Card',
  'accountKind.OTHER': 'Other',

  // ---- not found ----
  'notFound.title': 'Page not found',
  'notFound.body': 'The link may be out of date, or the page no longer exists.',
  'notFound.cta': 'Back to overview',

  // ---- API error codes (docs/06 §10) ----
  // The server returns a stable CODE and a safe English message; the client localises it. That
  // keeps the API locale-agnostic and means adding a language never touches the backend.
  'error.UNAUTHENTICATED': 'Incorrect email or password.',
  'error.FORBIDDEN': 'You do not have permission to do that.',
  'error.NOT_FOUND': 'That item does not exist.',
  'error.VALIDATION_FAILED': 'Please check the details you entered.',
  'error.CONFLICT': 'Something with those details already exists.',
  'error.RATE_LIMITED': 'Too many attempts. Please try again in a few minutes.',
  'error.AI_UNAVAILABLE': 'AI is unavailable right now. Manual entry still works.',
  'error.QUOTA_EXCEEDED': 'You have reached this month’s AI entry limit.',
  'error.INTERNAL': 'Something went wrong. Please try again.',
} as const;
