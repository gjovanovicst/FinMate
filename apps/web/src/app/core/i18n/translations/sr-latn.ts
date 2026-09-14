import type { en } from './en';

/**
 * Serbian (Latin) catalogue.
 *
 * Typed as `Record<TranslationKey, string>`, so a missing key fails the build rather than falling
 * back silently at runtime — the gap is caught by `tsc` and by the key-parity test.
 *
 * Serbian is written here the way people actually speak about money (docs/13 §8): "račun" for a bank
 * account, "trošak" for an expense, "domaćinstvo" for a household.
 */
export const srLatn: Record<keyof typeof en, string> = {
  // ---- application shell ----
  'app.name': 'FinMate',
  'app.skipToContent': 'Preskoči na sadržaj',
  'app.primaryNav': 'Glavna navigacija',
  'app.language': 'Jezik',

  // ---- navigation ----
  'nav.dashboard': 'Pregled',
  'nav.accounts': 'Računi',
  'nav.transactions': 'Transakcije',
  'nav.budgets': 'Budžeti',

  // ---- session ----
  'session.signOut': 'Odjavi se',
  'session.signingOut': 'Odjavljivanje…',
  'session.signedInAs': 'Prijavljeni ste kao {role}',

  // ---- roles ----
  'role.OWNER': 'Vlasnik',
  'role.ADMIN': 'Administrator',
  'role.MEMBER': 'Član',
  'role.VIEWER': 'Posmatrač',
  'role.unknown': 'korisnik',

  // ---- sign in ----
  'signIn.title': 'Prijava',
  'signIn.email': 'Email',
  'signIn.password': 'Lozinka',
  'signIn.submit': 'Prijavi se',
  'signIn.submitting': 'Prijavljivanje…',
  'signIn.noAccount': 'Nemaš nalog?',
  'signIn.register': 'Registruj se',

  // ---- sign up ----
  'signUp.title': 'Registracija',
  'signUp.intro':
    'Otvaranjem naloga dobijaš svoje domaćinstvo — kasnije možeš da dodaš članove porodice.',
  'signUp.displayName': 'Ime',
  'signUp.email': 'Email',
  'signUp.password': 'Lozinka',
  'signUp.passwordHint': 'Najmanje {min} znakova.',
  'signUp.submit': 'Otvori nalog',
  'signUp.submitting': 'Otvaranje naloga…',
  'signUp.haveAccount': 'Već imaš nalog?',
  'signUp.signIn': 'Prijavi se',

  // ---- dashboard ----
  'dashboard.title': 'Pregled',
  'dashboard.nextStepTitle': 'Sledeći korak',
  'dashboard.nextStepBody': 'Dodaj svoj prvi račun da bi mogao da počneš da beležiš troškove.',
  'dashboard.nextStepCta': 'Idi na račune',
  'dashboard.inProgressTitle': 'U izradi',
  'dashboard.todo.naturalLanguage': 'Unos prirodnim jezikom — „Lidl 2000“ (Faza 2)',
  'dashboard.todo.budgets': 'Budžeti i ciljevi štednje (Faza 1)',
  'dashboard.todo.safeToSpend': '„Koliko mogu danas da potrošim?“ (Faza 1)',
  'dashboard.todo.receipts': 'Računi i kategorizacija po stavkama (Faza 4)',

  // ---- accounts ----
  'accounts.title': 'Računi',
  'accounts.loading': 'Učitavanje…',
  'accounts.count': '{shown} od {total}',
  'accounts.emptyTitle': 'Još nema računa',
  'accounts.emptyBody':
    'Dodaj račun (keš, banka ili kartica) da bi mogao da pratiš stanje i troškove.',
  'accounts.newTitle': 'Novi račun',
  'accounts.name': 'Naziv',
  'accounts.kind': 'Tip',
  'accounts.openingBalance': 'Početno stanje (u parama)',
  'accounts.openingBalanceHint': 'npr. 150000 za 1.500,00 RSD',
  'accounts.submit': 'Dodaj račun',
  'accounts.submitting': 'Dodavanje…',

  // ---- account kinds ----
  'accountKind.CASH': 'Keš',
  'accountKind.BANK': 'Tekući račun',
  'accountKind.CARD': 'Kartica',
  'accountKind.OTHER': 'Ostalo',

  // ---- not found ----
  'notFound.title': 'Stranica nije pronađena',
  'notFound.body': 'Link je možda zastareo ili stranica više ne postoji.',
  'notFound.cta': 'Nazad na pregled',

  // ---- transactions ----
  'transactions.title': 'Transakcije',
  'transactions.count': '{count} transakcija',
  'transactions.addTitle': 'Dodaj transakciju',
  'transactions.amount': 'Iznos',
  'transactions.amountPlaceholder': 'npr. 2.000 ili 1.250,50',
  'transactions.amountAmbiguous':
    'Pročitano kao {reading}. Ako si mislio na drugo čitanje, razdvoji hiljade razmakom.',
  'transactions.amountUnreadable': 'Ne mogu da pročitam iznos iz toga.',
  'transactions.description': 'Opis',
  'transactions.kind': 'Tip',
  'transactions.category': 'Kategorija',
  'transactions.noCategory': 'Bez kategorije',
  'transactions.account': 'Račun',
  'transactions.date': 'Datum',
  'transactions.submit': 'Dodaj transakciju',
  'transactions.submitting': 'Dodavanje…',
  'transactions.emptyTitle': 'Još nema transakcija',
  'transactions.emptyBody': 'Dodaj prvu iznad — iznos prihvata ono što bi i inače otkucao.',
  'transactions.needsReview': 'čeka proveru',
  'transactions.noAccountsTitle': 'Prvo dodaj račun',
  'transactions.noAccountsBody':
    'Transakcija pripada računu, pa napravi račun pre nego što zabeležiš trošak.',

  // ---- transaction kinds ----
  'transactionKind.EXPENSE': 'Trošak',
  'transactionKind.INCOME': 'Prihod',

  // ---- dashboard ----
  'dashboard.safeToSpendTitle': 'Danas možeš da potrošiš',
  'dashboard.noBudgetTitle': 'Mesečni budžet nije postavljen',
  'dashboard.noBudgetBody': 'Postavi ga da vidiš koliko dnevno možeš bezbedno da potrošiš.',
  'dashboard.spentThisMonth': 'Potrošeno ovog meseca',
  'dashboard.incomeThisMonth': 'Prihod ovog meseca',
  'dashboard.projected': 'Predviđeno do kraja meseca',
  'dashboard.projectedOverrun': '{amount} preko budžeta',
  'dashboard.overspent': 'Preko budžeta za {amount}',
  'dashboard.notEnoughData': 'Prerano u mesecu za pouzdanu procenu.',
  'dashboard.reviewLabel': 'Čeka proveru',
  'dashboard.of': 'od {budget}',
  'dashboard.dayOf': 'Dan {day} od {total}',

  // ---- budgets ----
  'budgets.title': 'Budžeti',
  'budgets.setBudget': 'Postavi budžet',
  'budgets.none': 'Još nema budžeta',
  'budgets.noneBody': 'Mesečni budžet pretvara knjigu u podatak koliko je bezbedno potrošiti.',
  'budgets.category': 'Kategorija',
  'budgets.wholeHousehold': 'Celo domaćinstvo',
  'budgets.amount': 'Mesečni iznos',
  'budgets.period': 'Period',
  'budgets.periodMonthly': 'Mesečno',
  'budgets.periodWeekly': 'Nedeljno',
  'budgets.periodYearly': 'Godišnje',
  'budgets.save': 'Sačuvaj budžet',
  'budgets.saving': 'Čuvanje…',
  'budgets.remove': 'Ukloni',
  'budgets.spent': 'Potrošeno',
  'budgets.remaining': 'Preostalo',
  'budgets.addTitle': 'Dodaj ili izmeni budžet',
  'budgets.explain':
    'Budžet za kategoriju pokriva celo njeno podstablo. Računaju se samo potvrđene transakcije.',
  'budgets.amountUnreadable': 'Taj iznos nije bilo moguće pročitati.',
  'budgets.overBudget': 'Prekoračenje {amount}',
  'budgets.progressLabel': '{spent} od {budget} iskorišćeno',

  // ---- API error codes ----
  'error.UNAUTHENTICATED': 'Pogrešan email ili lozinka.',
  'error.FORBIDDEN': 'Nemaš dozvolu za ovu radnju.',
  'error.NOT_FOUND': 'Traženi podatak ne postoji.',
  'error.VALIDATION_FAILED': 'Proveri unete podatke.',
  'error.CONFLICT': 'Već postoji zapis sa tim podacima.',
  'error.RATE_LIMITED': 'Previše pokušaja. Pokušaj ponovo za nekoliko minuta.',
  'error.AI_UNAVAILABLE': 'AI trenutno nije dostupan. Ručni unos i dalje radi.',
  'error.QUOTA_EXCEEDED': 'Potrošio si mesečni limit za AI unos.',
  'error.INTERNAL': 'Došlo je do greške. Pokušaj ponovo.',
};
