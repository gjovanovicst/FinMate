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
