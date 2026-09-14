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
  'nav.categories': 'Kategorije',
  'nav.merchants': 'Prodavci',
  'nav.more': 'Više',

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

  // ---- transaction list: filters, grouping, pagination ----
  'transactions.search': 'Pretraga',
  'transactions.searchPlaceholder': 'Opis sadrži…',
  'transactions.filters': 'Filteri',
  'transactions.allKinds': 'Svi tipovi',
  'transactions.allCategories': 'Sve kategorije',
  'transactions.allAccounts': 'Svi računi',
  'transactions.from': 'Od',
  'transactions.to': 'Do',
  'transactions.onlyNeedsReview': 'Samo oni koji čekaju proveru',
  'transactions.clearFilters': 'Očisti filtere',
  'transactions.loadMore': 'Prikaži još',
  'transactions.exportCsv': 'Izvezi CSV',
  'transactions.exporting': 'Priprema…',
  'transactions.exportCount': 'Izvezi CSV ({count})',
  'transactions.loadingMore': 'Učitavanje…',
  'transactions.daySpent': 'Potrošeno {amount}',
  'transactions.dayReceived': 'Primljeno {amount}',
  'transactions.dayPartial': 'još stavki tog dana nije učitano',
  'transactions.edit': 'Izmeni',
  'transactions.emptyFilteredTitle': 'Ništa ne odgovara tim filterima',
  'transactions.emptyFilteredBody': 'Probaj drugu pretragu ili očisti filtere.',

  // ---- transaction detail / edit ----
  'transactions.editTitle': 'Izmena transakcije',
  'transactions.close': 'Zatvori',
  'transactions.save': 'Sačuvaj izmene',
  'transactions.saving': 'Čuvanje…',
  'transactions.delete': 'Obriši',
  'transactions.deleting': 'Brisanje…',
  'transactions.deleteConfirm': 'Obrisati ovu transakciju? Ovo se ovde ne može poništiti.',
  'transactions.note': 'Napomena',
  'transactions.status': 'Status',
  'transactions.amountPositive': 'Unesi iznos veći od nule.',
  'transactions.kindImmutable':
    'Smer se ne može menjati — transakcija je ili priliv ili odliv. Obriši je i ponovo unesi ako je pogrešna.',
  'transactions.splitAmountLocked':
    'Ova transakcija je podeljena po kategorijama, pa je njen ukupan iznos određen tim delovima. Menjaj delove, ne ukupan iznos.',
  'transactions.splitsTitle': 'Podeljeno po kategorijama',
  'transactions.splitsReadOnly':
    'Izmena podele još nije dostupna; delovi su prikazani da ukupan iznos ne bi bio nejasan.',
  'transactions.conflictReload': 'Učitaj ponovo',

  // ---- transaction status ----
  'transactionStatus.CONFIRMED': 'Potvrđena',
  'transactionStatus.PENDING': 'Na čekanju',
  'transactionStatus.VOID': 'Stornirana',

  // ---- split editor ----
  'transactions.singleCategory': 'Jedna kategorija',
  'transactions.splitAcross': 'Podeli po kategorijama',
  'transactions.splitHint':
    'Kada jedna kategorija ne odgovara — korpa iz supermarketa nije samo hrana. Delovi moraju tačno da se saberu u ukupan iznos.',
  'transactions.addSplit': 'Dodaj kategoriju',
  'transactions.splitEvenly': 'Podeli na jednake delove',
  'transactions.removeSplit': 'Ukloni ovaj deo',
  'transactions.splitMismatch': 'Delovi se sabiraju u {sum}, a ukupan iznos je {total}.',
  'transactions.splitBalanced': 'Delovi se sabiraju tačno.',
  'transactions.splitNeedsTwo': 'Izaberi najmanje dve kategorije za podelu.',
  'transactions.splitNoAmount': 'Prvo unesi ukupan iznos, pa ga podeli.',

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

  // ---- categories ----
  'categories.title': 'Kategorije',
  'categories.subtitle':
    'Vaša sopstvena struktura. Budžet se može postaviti na svaki čvor i pokriva sve ispod njega.',
  'categories.expenses': 'Troškovi',
  'categories.income': 'Prihodi',
  'categories.add': 'Dodaj',
  'categories.addTitle': 'Nova kategorija',
  'categories.addChild': 'Dodaj potkategoriju',
  'categories.name': 'Naziv',
  'categories.parent': 'Roditelj',
  'categories.topLevel': 'Najviši nivo',
  'categories.icon': 'Ikonica',
  'categories.iconHint': 'Jedan emodži, prikazan svuda gde se kategorija pojavljuje.',
  'categories.color': 'Boja',
  'categories.aiDescription': 'Opis za klasifikator',
  'categories.aiDescriptionHint':
    'Nagoveštaj za automatsko kategorisanje. Napišite ga onako kako bi pisalo na računu.',
  'categories.save': 'Sačuvaj izmene',
  'categories.saving': 'Čuvanje…',
  'categories.create': 'Napravi',
  'categories.creating': 'Pravljenje…',
  'categories.cancel': 'Otkaži',
  'categories.delete': 'Obriši kategoriju',
  'categories.deleting': 'Brisanje…',
  'categories.deleteRefusedTitle': 'Ova kategorija se još koristi',
  'categories.deleteRefusedBody':
    'Ništa nije obrisano. Izaberite gde da odu njeni sadržaji, pa pokušajte ponovo.',
  'categories.reassignTo': 'Prebaci sadržaj u',
  'categories.reassignAndDelete': 'Prebaci i obriši',
  'categories.chooseTarget': 'Izaberite kategoriju…',
  'categories.usage': '{count} transakcija koristi ovu kategoriju direktno',
  'categories.usageNone': 'Nijedna transakcija ne koristi ovu kategoriju direktno',
  'categories.usageNote': 'Ne računa potkategorije ni delove podele.',
  'categories.starter': 'početna',
  'categories.empty': 'Još nema kategorija',
  'categories.emptyBody': 'Dodajte prvu, ili počnite od ponuđenog stabla.',
  'categories.selectPrompt': 'Izaberite kategoriju da je izmenite.',
  'categories.keywords': 'Ključne reči',
  'categories.keywordsHint':
    'Reči koje upućuju na ovu kategoriju. Isključena reč je blokira — tako „ulje“ ne završi u Gorivu.',
  'categories.keywordPlaceholder': 'npr. septička',
  'categories.keywordNormalised':
    'Čuva se malim slovima i bez kvačica, pa se poklapa kako god je kasnije otkucaš.',
  'categories.addKeyword': 'Dodaj',
  'categories.noKeywords': 'Još nema ključnih reči.',
  'categories.polarity': 'Efekat',
  'categories.polarityInclude': 'Uključuje',
  'categories.polarityExclude': 'Isključuje',
  'categories.matchMode': 'Poklapanje',
  'categories.matchWord': 'Cela reč',
  'categories.matchPrefix': 'Počinje sa',
  'categories.matchSubstring': 'Bilo gde u tekstu',
  'categories.substringWarning':
    'Poklapanje bilo gde je namerno slabo i može da prevuče nepovezane prodavce.',
  'categories.removeKeyword': 'Ukloni ključnu reč {keyword}',
  'categories.collapse': 'Skupi',
  'categories.expand': 'Razgranaj',
  'categories.moveUp': 'Pomeri gore',
  'categories.moveDown': 'Pomeri dole',
  'categories.nest': 'Napravi potkategoriju od reda iznad',
  'categories.unnest': 'Izađi jedan nivo',
  'categories.keyboardHint':
    'Alt sa strelicama menja redosled i nivo: gore i dole unutar nivoa, desno za potkategoriju reda iznad, levo za izlazak nivo više.',
  'categories.refusalSELF': 'Kategorija ne može biti unutar same sebe.',
  'categories.refusalCYCLE': 'Kategorija ne može da se premesti u sopstvenu potkategoriju.',
  'categories.refusalTOO_DEEP': 'To bi ugnjezdilo kategorije više od 5 nivoa.',
  'categories.tooDeepTitle': 'Previše nivoa',
  'categories.tooDeepBody': 'Kategorije se ugnježđuju najviše 5 nivoa. Uklonite prvo jedan nivo.',
  'categories.moved': 'Premešteno {name} u {path}.',
  'categories.moveFailed': 'To premeštanje je odbijeno.',

  // ---- merchants ----
  'merchants.title': 'Prodavci',
  'merchants.subtitle':
    'Radnje i servisi. Alijas je ono po čemu napisan opis pronalazi pravog prodavca.',
  'merchants.add': 'Dodaj',
  'merchants.addTitle': 'Novi prodavac',
  'merchants.name': 'Naziv',
  'merchants.create': 'Napravi',
  'merchants.creating': 'Pravljenje…',
  'merchants.cancel': 'Otkaži',
  'merchants.search': 'Pretraga',
  'merchants.searchPlaceholder': 'Pretraži prodavce',
  'merchants.defaultCategory': 'Podrazumevana kategorija',
  'merchants.noDefaultCategory': 'Nije postavljena',
  'merchants.defaultCategoryHint':
    'Nije obavezno. Stavka računa koja navodi svoju kategoriju ima prednost.',
  'merchants.aiHint': 'Nagoveštaj za klasifikator',
  'merchants.aiHintHint': 'Reči koje biste očekivali na računu odatle.',
  'merchants.aliases': 'Alijasi',
  'merchants.aliasesHint':
    'Drugi načini na koje se ovaj prodavac piše. Čuva se bez kvačica i velikih slova, pa ono što se vrati može da izgleda drugačije od unetog.',
  'merchants.aliasPlaceholder': 'npr. lidl dorcol',
  'merchants.addAlias': 'Dodaj',
  'merchants.noAliases': 'Još nema alijasa.',
  'merchants.removeAlias': 'Ukloni alijas {alias}',
  'merchants.save': 'Sačuvaj izmene',
  'merchants.saving': 'Čuvanje…',
  'merchants.starter': 'isporučen',
  'merchants.usage': '{count} transakcija',
  'merchants.usageNone': 'još se ne koristi',
  'merchants.selectPrompt': 'Izaberite prodavca da ga izmenite.',
  'merchants.empty': 'Još nema prodavaca',
  'merchants.emptyBody': 'Dodajte jednog, ili pretražite isporučeni katalog.',
  'merchants.emptySearch': 'Ništa ne odgovara toj pretrazi',
  'merchants.truncated': 'Prikazano je prvih 200. Pretražite da suzite listu.',
  'merchants.copyOnWrite':
    'Ovo je isporučen prodavac. Čuvanjem pravite svoju kopiju i vaše transakcije se prebacuju na nju, pa zajednički katalog ostaje nepromenjen.',
  'merchants.duplicateName': 'Drugi prodavac već ima taj naziv. Spojite ga sa njim.',
  'merchants.merge': 'Spoji sa drugim prodavcem',
  'merchants.mergeHint':
    'Prebacuje sve zabeleženo ovde na izabranog prodavca, spaja alijase, pa uklanja ovog.',
  'merchants.mergeTarget': 'Spoji sa',
  'merchants.chooseTarget': 'Izaberite prodavca…',
  'merchants.mergePreviewAliases': 'Alijasi nakon spajanja',
  'merchants.mergePreviewCount': '{count} transakcija će se premestiti',
  'merchants.mergePreviewNone': 'Nema transakcija za premeštanje.',
  'merchants.mergeConfirm': 'Spoji',
  'merchants.merging': 'Spajanje…',
  'merchants.delete': 'Obriši prodavca',
  'merchants.deleting': 'Brisanje…',
  'merchants.deleteConfirm': 'Obrisati ovog prodavca?',
  'merchants.refusalSAME': 'Prodavac ne može da se spoji sam sa sobom.',
  'merchants.refusalSHIPPED_SOURCE':
    'Isporučen prodavac ne može da se spoji i ukloni. Spojite svog prodavca sa njim.',
  'merchants.deleteRefusalSHIPPED':
    'Isporučeni prodavci ne mogu da se brišu. Sačuvajte izmenu da napravite svoju kopiju.',
  'merchants.deleteRefusalIN_USE':
    'Transakcije još koriste ovog prodavca. Spojite ga sa drugim da ih prvo premestite.',

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
