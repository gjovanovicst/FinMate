/**
 * The starter Serbian category tree (docs/01 F-13 step 1, docs/11 §2.3).
 *
 * **This is content, not fixture.** It ships to every Household that accepts the default tree during
 * onboarding, so it lives in git as a reviewable artefact rather than as rows somebody typed into a
 * database once. `apps/api/prisma/seed.ts` and the onboarding wizard both read it, and onboarding
 * writes it into the Household (categories are household-scoped — there is no global tree, because
 * `categories.household_id` is `NOT NULL`; the *shipped* thing is this document).
 *
 * ## Why the tree looks like this
 *
 * It is deliberately shallow where a person is unlikely to drill in and specific where the product
 * differentiates: `Kuća / Septička jama` exists because that is a real recurring Serbian household
 * cost with a distinctive vocabulary, and F-09's worked example corrects exactly that input. Roots are
 * ~8 expense areas plus 4 income lines, which keeps the first categorisation decision recognisable
 * (docs/02 §4.1's "~40 Serbian nodes").
 *
 * ## `key` is not an id
 *
 * A seed key is a stable *name* for a node inside this document. Onboarding maps keys to real
 * `categories.id` values as it creates them, and `SHIPPED_MERCHANTS[].categoryKey` refers to these —
 * which is the only reason a merchant can carry a suggested category without hardcoding a UUID that
 * means nothing in another Household.
 *
 * ## `strong` versus `include` — the difference that makes the cold start work
 *
 * docs/04 §5.4 decides a category from keywords only when the top score is **≥ 2.0**, and the schema
 * default keyword weight is 1.0. **A keyword at the default weight therefore scores 1.0 and can never
 * decide anything on its own** — which is exactly what happened: the shipped tree seeded 137
 * keywords, all at 1.0, so `Lidl 2000` fell through to the AI (or, with no provider, to the blocking
 * lane) no matter how good the tree was. The demo Household hid it because its merchants carry
 * default categories, and a *merchant default* is a different stage that always decides.
 *
 * So a node names its keywords twice:
 *
 *  - **`strong`** — decisive alone: a merchant's name (`lidl`), or the word that *is* the category
 *    (`gorivo`, `struja`, `penzija`). Written at weight 2.0.
 *  - **`include`** — corroborating: a word that is plausible but ambiguous (`market`, `kafa`, `jama`,
 *    `rata`, `karte`). Written at the schema default, so it needs a second hit to reach the threshold.
 *    `kafa` is the clearest case: buying coffee is `Kafa i kolači`, but "kafa i mleko" is groceries.
 *
 * `exclude` is separate and weight-independent: docs/04 §5.4 makes an EXCLUDE match **hard-block** a
 * category, so `ulje` under Gorivo is what stops engine oil being filed as fuel.
 *
 * @module @finmate/domain/seed
 */

/** One node of the starter tree. Children are nested because the tree is authored, not computed. */
export interface StarterCategory {
  /** Stable within this document. Merchant suggestions reference it. */
  readonly key: string;
  readonly name: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly icon?: string;
  /** Fed to the classifier as category context (docs/04 §6.3). */
  readonly aiDescription?: string;
  /** Decisive keywords: written at {@link STRONG_KEYWORD_WEIGHT}, enough to decide alone. */
  readonly strong?: readonly string[];
  /** Corroborating keywords: written at {@link DEFAULT_KEYWORD_WEIGHT}, needing a second hit. */
  readonly include?: readonly string[];
  /** `CategoryKeyword` rows with polarity `EXCLUDE`. Weight-independent — they hard-block. */
  readonly exclude?: readonly string[];
  readonly children?: readonly StarterCategory[];
}

/** docs/04 §5.4's decision threshold. A single keyword must reach it to decide a category. */
export const KEYWORD_DECISION_THRESHOLD = 2;

/** `category_keywords.weight`'s schema default (docs/03 §4): one hit, not enough to decide. */
export const DEFAULT_KEYWORD_WEIGHT = 1;

/** What a decisive keyword is written as, so one hit clears the threshold exactly. */
export const STRONG_KEYWORD_WEIGHT = 2;

export const STARTER_CATEGORIES: readonly StarterCategory[] = [
  {
    key: 'hrana',
    name: 'Hrana',
    kind: 'EXPENSE',
    icon: '🛒',
    aiDescription: 'Namirnice, marketi, pekare i restorani.',
    strong: ['hrana'],
    include: ['namirnice', 'market', 'prodavnica'],
    children: [
      {
        key: 'hrana-supermarket',
        name: 'Supermarket',
        kind: 'EXPENSE',
        // Merchant names: the strongest signal a household produces.
        strong: ['lidl', 'maxi', 'idea', 'dis', 'univerexport', 'shopgo'],
      },
      { key: 'hrana-pekara', name: 'Pekara', kind: 'EXPENSE', strong: ['pekara'], include: ['hleb', 'burek'] },
      {
        key: 'hrana-restoran',
        name: 'Restoran',
        kind: 'EXPENSE',
        strong: ['restoran', 'kafana'],
        include: ['ručak', 'večera', 'dostava'],
      },
      {
        key: 'hrana-kafa',
        name: 'Kafa i kolači',
        kind: 'EXPENSE',
        // `kafa` is weak on purpose: "kafa i mleko" is groceries, "kafić" is not.
        strong: ['kafić', 'poslastičarnica'],
        include: ['kafa'],
      },
    ],
  },
  {
    key: 'auto',
    name: 'Automobil',
    kind: 'EXPENSE',
    icon: '🚗',
    children: [
      {
        key: 'auto-gorivo',
        name: 'Gorivo',
        kind: 'EXPENSE',
        strong: ['gorivo', 'benzin', 'dizel', 'nafta'],
        include: ['pumpa'],
        // Without this, "ulje" (engine oil) routes into fuel. An EXCLUDE hard-blocks the category.
        exclude: ['ulje', 'filter', 'servis', 'gume', 'registracija'],
      },
      {
        key: 'auto-servis',
        name: 'Servis',
        kind: 'EXPENSE',
        strong: ['servis', 'majstor', 'popravka'],
      },
      { key: 'auto-delovi', name: 'Delovi', kind: 'EXPENSE', strong: ['delovi'], include: ['filter', 'ulje', 'gume'] },
      {
        key: 'auto-registracija',
        name: 'Registracija',
        kind: 'EXPENSE',
        strong: ['registracija', 'osiguranje'],
        include: ['tehnički pregled'],
      },
      {
        key: 'auto-parking',
        name: 'Parking i putarine',
        kind: 'EXPENSE',
        strong: ['parking', 'putarina', 'mostarina'],
      },
    ],
  },
  {
    key: 'kuca',
    name: 'Kuća',
    kind: 'EXPENSE',
    icon: '🏠',
    children: [
      { key: 'kuca-struja', name: 'Struja', kind: 'EXPENSE', strong: ['struja', 'eps', 'elektro'] },
      { key: 'kuca-voda', name: 'Voda', kind: 'EXPENSE', strong: ['vodovod'], include: ['voda'] },
      {
        key: 'kuca-grejanje',
        name: 'Grejanje',
        kind: 'EXPENSE',
        strong: ['grejanje', 'gas', 'toplana'],
        include: ['drva', 'pelet'],
      },
      {
        key: 'kuca-internet',
        name: 'Internet i TV',
        kind: 'EXPENSE',
        // `yettel` is deliberately NOT here. It used to be, while `merchants.ts` gives `Yettel` a
        // `Kuća / Telefon` default and a `telenor` alias — and because a keyword decision outranks an
        // entity default, "Yettel 2,50" resolved to *Internet i TV*. The evaluation harness caught the
        // contradiction on its first run (docs/04 §8.1.5). The merchant's default is the more specific
        // artefact and matches the brand, so the keyword moved to `kuca-telefon`.
        strong: ['internet', 'sbb', 'mts', 'orion'],
      },
      {
        key: 'kuca-telefon',
        name: 'Telefon',
        kind: 'EXPENSE',
        strong: ['telefon', 'telekom', 'mobilni', 'a1', 'yettel'],
      },
      {
        key: 'kuca-septicka',
        name: 'Septička jama',
        kind: 'EXPENSE',
        aiDescription: 'Pražnjenje, čišćenje i održavanje septičke jame.',
        strong: ['septička', 'septicka', 'jama', 'cisterna', 'fekalna'],
        include: ['pražnjenje jame'],
      },
      {
        key: 'kuca-odrzavanje',
        name: 'Održavanje',
        kind: 'EXPENSE',
        strong: ['održavanje', 'renoviranje'],
        include: ['majstor', 'popravka'],
      },
      {
        key: 'kuca-komunalije',
        name: 'Komunalije',
        kind: 'EXPENSE',
        strong: ['infostan', 'komunalije'],
        include: ['smeće'],
      },
    ],
  },
  {
    key: 'porodica',
    name: 'Porodica',
    kind: 'EXPENSE',
    icon: '👨‍👩‍👧',
    children: [
      { key: 'porodica-deca', name: 'Deca', kind: 'EXPENSE', strong: ['vrtić', 'igračke'], include: ['deca', 'škola'] },
      {
        key: 'porodica-pokloni',
        name: 'Pokloni',
        kind: 'EXPENSE',
        strong: ['poklon', 'svadba', 'krštenje'],
        include: ['rođendan', 'rodjendan'],
      },
      {
        key: 'porodica-zdravlje',
        name: 'Zdravlje',
        kind: 'EXPENSE',
        strong: ['apoteka', 'lekar', 'zubar', 'pregled'],
        include: ['zdravlje'],
      },
    ],
  },
  {
    key: 'higijena',
    name: 'Higijena',
    kind: 'EXPENSE',
    icon: '🧴',
    aiDescription: 'Lična higijena i sredstva za čišćenje — često na istom računu kao hrana.',
    strong: ['higijena', 'šampon', 'sampon', 'sapun'],
    include: ['pasta za zube', 'deterdžent', 'sredstvo za sudove'],
  },
  {
    key: 'odeca',
    name: 'Odeća i obuća',
    kind: 'EXPENSE',
    icon: '👕',
    strong: ['odeća', 'obuca', 'obuća', 'patike'],
    include: ['jakna'],
  },
  {
    key: 'zabava',
    name: 'Zabava',
    kind: 'EXPENSE',
    icon: '🎬',
    children: [
      {
        key: 'zabava-pretplate',
        name: 'Pretplate',
        kind: 'EXPENSE',
        strong: ['netflix', 'spotify', 'hbo', 'disney', 'youtube'],
        include: ['pretplata'],
      },
      {
        key: 'zabava-izlasci',
        name: 'Izlasci',
        kind: 'EXPENSE',
        strong: ['bioskop', 'koncert'],
        include: ['izlazak', 'karte'],
      },
      { key: 'zabava-sport', name: 'Sport', kind: 'EXPENSE', strong: ['teretana'], include: ['bazen', 'sport', 'trening'] },
    ],
  },
  {
    key: 'finansije',
    name: 'Finansije',
    kind: 'EXPENSE',
    icon: '🏦',
    children: [
      { key: 'finansije-kredit', name: 'Kredit', kind: 'EXPENSE', strong: ['kredit', 'anuitet'], include: ['rata'] },
      { key: 'finansije-stednja', name: 'Štednja', kind: 'EXPENSE', strong: ['štednja', 'stednja'], include: ['štek'] },
      {
        key: 'finansije-naknade',
        name: 'Bankovne naknade',
        kind: 'EXPENSE',
        strong: ['naknada', 'provizija'],
        include: ['održavanje računa'],
      },
    ],
  },
  { key: 'ostalo', name: 'Ostalo', kind: 'EXPENSE', icon: '📦', aiDescription: 'Nekategorizovani troškovi.' },

  // ---- income ----
  {
    key: 'prihod-plata',
    name: 'Plata',
    kind: 'INCOME',
    icon: '💰',
    strong: ['plata', 'zarada', 'honorar'],
  },
  { key: 'prihod-penzija', name: 'Penzija', kind: 'INCOME', icon: '👴', strong: ['penzija'] },
  { key: 'prihod-uplata', name: 'Uplata', kind: 'INCOME', icon: '⬆️', strong: ['uplata', 'leglo'], include: ['primio'] },
  {
    key: 'prihod-povracaj',
    name: 'Povraćaj',
    kind: 'INCOME',
    icon: '↩️',
    strong: ['povraćaj', 'povracaj', 'refundacija', 'reklamacija'],
  },
];
