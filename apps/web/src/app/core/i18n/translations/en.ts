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
  'nav.transactions': 'Transactions',
  'nav.budgets': 'Budgets',
  'nav.categories': 'Categories',
  'nav.more': 'More',

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

  // ---- transactions ----
  'transactions.title': 'Transactions',
  'transactions.count': '{count} transactions',
  'transactions.addTitle': 'Add a transaction',
  'transactions.amount': 'Amount',
  'transactions.amountPlaceholder': 'e.g. 2.000 or 1.250,50',
  'transactions.amountAmbiguous':
    'Read as {reading}. If you meant the other reading, separate the thousands with a space.',
  'transactions.amountUnreadable': 'Could not read an amount from that.',
  'transactions.description': 'Description',
  'transactions.kind': 'Type',
  'transactions.category': 'Category',
  'transactions.noCategory': 'No category',
  'transactions.account': 'Account',
  'transactions.date': 'Date',
  'transactions.submit': 'Add transaction',
  'transactions.submitting': 'Adding…',
  'transactions.emptyTitle': 'No transactions yet',
  'transactions.emptyBody': 'Add your first one above — the amount accepts what you would type.',
  'transactions.needsReview': 'needs review',
  'transactions.noAccountsTitle': 'Add an account first',
  'transactions.noAccountsBody':
    'A transaction belongs to an account, so create one before recording any spending.',

  // ---- transaction list: filters, grouping, pagination ----
  'transactions.search': 'Search',
  'transactions.searchPlaceholder': 'Description contains…',
  'transactions.filters': 'Filters',
  'transactions.allKinds': 'All types',
  'transactions.allCategories': 'All categories',
  'transactions.allAccounts': 'All accounts',
  'transactions.from': 'From',
  'transactions.to': 'To',
  'transactions.onlyNeedsReview': 'Only those needing review',
  'transactions.clearFilters': 'Clear filters',
  'transactions.loadMore': 'Load more',
  'transactions.exportCsv': 'Export CSV',
  'transactions.exporting': 'Preparing…',
  'transactions.exportCount': 'Export CSV ({count})',
  'transactions.loadingMore': 'Loading…',
  'transactions.daySpent': 'Spent {amount}',
  'transactions.dayReceived': 'Received {amount}',
  'transactions.dayPartial': 'more on this day not loaded',
  'transactions.edit': 'Edit',
  'transactions.emptyFilteredTitle': 'Nothing matches those filters',
  'transactions.emptyFilteredBody': 'Try a different search, or clear the filters.',

  // ---- transaction detail / edit ----
  'transactions.editTitle': 'Edit transaction',
  'transactions.close': 'Close',
  'transactions.save': 'Save changes',
  'transactions.saving': 'Saving…',
  'transactions.delete': 'Delete',
  'transactions.deleting': 'Deleting…',
  'transactions.deleteConfirm': 'Delete this transaction? This cannot be undone here.',
  'transactions.note': 'Note',
  'transactions.status': 'Status',
  'transactions.amountPositive': 'Enter an amount greater than zero.',
  'transactions.kindImmutable':
    'The direction cannot be changed — a transaction is either money in or money out. Delete it and re-record if it was wrong.',
  'transactions.splitAmountLocked':
    'This transaction is divided across categories, so its total is fixed by those parts. Change the parts instead of the total.',
  'transactions.splitsTitle': 'Divided across categories',
  'transactions.splitsReadOnly':
    'Editing the division is not available yet; the parts are shown so the total is not a mystery.',
  'transactions.conflictReload': 'Reload',

  // ---- transaction status ----
  'transactionStatus.CONFIRMED': 'Confirmed',
  'transactionStatus.PENDING': 'Pending',
  'transactionStatus.VOID': 'Void',

  // ---- split editor ----
  'transactions.singleCategory': 'One category',
  'transactions.splitAcross': 'Split across categories',
  'transactions.splitHint':
    'When no single category fits — a supermarket basket is not all groceries. The parts must add up to the total exactly.',
  'transactions.addSplit': 'Add a category',
  'transactions.splitEvenly': 'Split evenly',
  'transactions.removeSplit': 'Remove this part',
  'transactions.splitMismatch': 'The parts add up to {sum} but the total is {total}.',
  'transactions.splitBalanced': 'The parts add up exactly.',
  'transactions.splitNeedsTwo': 'Choose at least two categories to split across.',
  'transactions.splitNoAmount': 'Enter the total first, then split it.',

  // ---- transaction kinds ----
  'transactionKind.EXPENSE': 'Expense',
  'transactionKind.INCOME': 'Income',

  // ---- dashboard ----
  'dashboard.safeToSpendTitle': 'You can spend today',
  'dashboard.noBudgetTitle': 'No monthly budget set',
  'dashboard.noBudgetBody': 'Set one to see how much is safe to spend each day.',
  'dashboard.spentThisMonth': 'Spent this month',
  'dashboard.incomeThisMonth': 'Income this month',
  'dashboard.projected': 'Projected by month end',
  'dashboard.projectedOverrun': '{amount} over budget',
  'dashboard.overspent': 'Over budget by {amount}',
  'dashboard.notEnoughData': 'Too early in the month to predict reliably.',
  'dashboard.reviewLabel': 'Awaiting review',
  'dashboard.of': 'of {budget}',
  'dashboard.dayOf': 'Day {day} of {total}',

  // ---- budgets ----
  'budgets.title': 'Budgets',
  'budgets.setBudget': 'Set a budget',
  'budgets.none': 'No budgets yet',
  'budgets.noneBody': 'A monthly budget turns the ledger into the safe-to-spend figure.',
  'budgets.category': 'Category',
  'budgets.wholeHousehold': 'Whole household',
  'budgets.amount': 'Monthly amount',
  'budgets.period': 'Period',
  'budgets.periodMonthly': 'Monthly',
  'budgets.periodWeekly': 'Weekly',
  'budgets.periodYearly': 'Yearly',
  'budgets.save': 'Save budget',
  'budgets.saving': 'Saving…',
  'budgets.remove': 'Remove',
  'budgets.spent': 'Spent',
  'budgets.remaining': 'Remaining',
  'budgets.addTitle': 'Add or update a budget',
  'budgets.explain':
    'Budgeting a category covers its whole subtree. Spending counts confirmed transactions only.',
  'budgets.amountUnreadable': 'That amount could not be read.',
  'budgets.overBudget': 'Over by {amount}',
  'budgets.progressLabel': '{spent} of {budget} used',

  // ---- categories ----
  'categories.title': 'Categories',
  'categories.subtitle':
    'Your own structure. A budget can be set on any node and covers everything beneath it.',
  'categories.expenses': 'Expenses',
  'categories.income': 'Income',
  'categories.add': 'Add',
  'categories.addTitle': 'New category',
  'categories.addChild': 'Add a subcategory',
  'categories.name': 'Name',
  'categories.parent': 'Parent',
  'categories.topLevel': 'Top level',
  'categories.icon': 'Icon',
  'categories.iconHint': 'A single emoji, shown wherever the category appears.',
  'categories.color': 'Colour',
  'categories.aiDescription': 'Description for the classifier',
  'categories.aiDescriptionHint':
    'A hint for automatic categorisation. Write it the way a shop receipt would read.',
  'categories.save': 'Save changes',
  'categories.saving': 'Saving…',
  'categories.create': 'Create',
  'categories.creating': 'Creating…',
  'categories.cancel': 'Cancel',
  'categories.delete': 'Delete category',
  'categories.deleting': 'Deleting…',
  'categories.deleteRefusedTitle': 'This category is still in use',
  'categories.deleteRefusedBody':
    'Nothing was deleted. Choose where its contents should go, then try again.',
  'categories.reassignTo': 'Move its contents to',
  'categories.reassignAndDelete': 'Move and delete',
  'categories.chooseTarget': 'Choose a category…',
  'categories.usage': '{count} transactions use this category directly',
  'categories.usageNone': 'No transactions use this category directly',
  'categories.usageNote': 'Does not count subcategories or split parts.',
  'categories.starter': 'starter',
  'categories.empty': 'No categories yet',
  'categories.emptyBody': 'Add the first one, or start from the seeded tree.',
  'categories.selectPrompt': 'Choose a category to edit it.',
  'categories.keywords': 'Keywords',
  'categories.keywordsHint':
    'Words that suggest this category. An excluded word blocks it — that is how "ulje" is kept out of Fuel.',
  'categories.keywordPlaceholder': 'e.g. septička',
  'categories.keywordNormalised':
    'Saved in lower case without accents, so it matches however you type it later.',
  'categories.addKeyword': 'Add',
  'categories.noKeywords': 'No keywords yet.',
  'categories.polarity': 'Effect',
  'categories.polarityInclude': 'Include',
  'categories.polarityExclude': 'Exclude',
  'categories.matchMode': 'Match',
  'categories.matchWord': 'Whole word',
  'categories.matchPrefix': 'Starts with',
  'categories.matchSubstring': 'Anywhere in the text',
  'categories.substringWarning':
    'Matching anywhere is deliberately weak and can pull in unrelated merchants.',
  'categories.removeKeyword': 'Remove keyword {keyword}',
  'categories.collapse': 'Collapse',
  'categories.expand': 'Expand',
  'categories.moveUp': 'Move up',
  'categories.moveDown': 'Move down',
  'categories.nest': 'Make a subcategory of the row above',
  'categories.unnest': 'Move out one level',
  'categories.keyboardHint':
    'Alt with the arrow keys reorders and re-nests: up and down within a level, right to nest under the row above, left to move out.',
  'categories.refusalSELF': 'A category cannot be inside itself.',
  'categories.refusalCYCLE': 'A category cannot be moved inside its own subcategory.',
  'categories.refusalTOO_DEEP': 'That would nest categories more than 5 deep.',
  'categories.tooDeepTitle': 'Too many levels',
  'categories.tooDeepBody': 'Categories nest at most 5 levels deep. Remove a level first.',
  'categories.moved': 'Moved {name} to {path}.',
  'categories.moveFailed': 'That move was refused.',

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
