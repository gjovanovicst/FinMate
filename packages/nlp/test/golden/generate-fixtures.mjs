/**
 * Generates the golden-dataset v1 fixtures under `./fixtures/`.
 *
 * **The expectations here are hand-derived from docs/04 §3.1 and §3.2 and from primary-school
 * Serbian number formatting. This file never imports `@finmate/nlp` and never runs the parser.** If
 * it did, the dataset would assert that the code does what the code does — the tautology that makes
 * a golden set worthless. The workflow that produced these values is:
 *
 *   1. write the expectation from the spec by hand (the tables below);
 *   2. run the harness;
 *   3. adjudicate every difference — parser bug or wrong expectation — and record it.
 *
 * The amount-format slice is *composed* over three axes (numeric form × currency suffix × prefix)
 * rather than typed out 130 times, because the interesting space is the interaction of the grouping
 * separator, the decimal separator, the `k` shorthand and the currency suffix. Each axis entry still
 * carries its own hand-computed minor units and candidate count, so composition never invents an
 * expectation.
 *
 * Regenerate with:  node packages/nlp/test/golden/generate-fixtures.mjs
 *
 * @module golden fixture generator
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The same Monday `extract.spec.ts` uses, so `prošli petak` has an unambiguous previous week. */
const TODAY = '2026-09-14';
const ADDED_IN = '2026-09-14';

const DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(DIR, 'fixtures');

// ---------------------------------------------------------------------------------------------
// AMOUNT_FORMAT — numeric forms (hand-computed minor units, RSD = 100 para)
// ---------------------------------------------------------------------------------------------

/**
 * Every entry's `minor` is the value read under the docs/04 §3.1 rules:
 *   `.` and a space group thousands, `,` is the decimal separator, and with both present the **last**
 *   one is the decimal point; a trailing `k` multiplies by one thousand.
 * `candidates` is the count of readings the ambiguity policy must surface. A well-formed single
 * `.`-group (`2.000`, `1.200`) is genuinely ambiguous — twelve hundred or one-point-two — so it has
 * two, with the Serbian grouping reading first. Two `.`-groups (`1.234.567`) cannot be a decimal, so
 * there is one.
 */
const AMOUNT_FORMS = [
  { text: '2000', minor: '200000', candidates: 1, why: 'plain integer' },
  { text: '2.000', minor: '200000', candidates: 2, why: 'dot groups thousands; the decimal reading is the alternative' },
  { text: '2 000', minor: '200000', candidates: 1, why: 'space groups thousands and cannot be a decimal point' },
  { text: '2\u00a0000', minor: '200000', candidates: 1, why: 'non-breaking space groups thousands' },
  { text: '1.200', minor: '120000', candidates: 2, why: 'the docs/04 §3.1 ambiguity named in the spec' },
  { text: '1 200', minor: '120000', candidates: 1, why: 'space-grouped 1200' },
  { text: '20000', minor: '2000000', candidates: 1, why: 'twenty thousand, ungrouped' },
  { text: '20.000', minor: '2000000', candidates: 2, why: 'dot-grouped twenty thousand' },
  { text: '20 000', minor: '2000000', candidates: 1, why: 'space-grouped twenty thousand' },
  { text: '200000', minor: '20000000', candidates: 1, why: 'two hundred thousand, ungrouped' },
  { text: '200.000', minor: '20000000', candidates: 2, why: 'dot-grouped two hundred thousand' },
  { text: '1.234.567', minor: '123456700', candidates: 1, why: 'two groups cannot be a decimal, so one reading' },
  { text: '1 234 567', minor: '123456700', candidates: 1, why: 'space-grouped millions' },
  { text: '2,50', minor: '250', candidates: 1, why: 'comma is the decimal separator' },
  { text: '2,5', minor: '250', candidates: 1, why: 'one decimal digit pads to 50 para' },
  { text: '0,05', minor: '5', candidates: 1, why: 'five para, below one dinar' },
  { text: '0,5', minor: '50', candidates: 1, why: 'half a dinar' },
  { text: '1.250,50', minor: '125050', candidates: 1, why: 'both separators: the comma is the decimal point' },
  { text: '2.000,50', minor: '200050', candidates: 1, why: 'both separators on a round thousand' },
  { text: '1.200,5', minor: '120050', candidates: 1, why: 'one decimal digit after a grouped integer part' },
  { text: '2,500', minor: '250', candidates: 2, why: 'three digits after a comma: Serbian decimal leads, English grouping is the alternative' },
  { text: '2k', minor: '200000', candidates: 1, why: 'k shorthand' },
  { text: '1.5k', minor: '150000', candidates: 1, why: 'fractional shorthand is a decimal point, not a stripped group' },
  { text: '1,5k', minor: '150000', candidates: 1, why: 'comma decimal with k shorthand' },
  { text: '1.200k', minor: '120000000', candidates: 1, why: 'grouped base: 1200 thousand' },
  { text: '1.200,50k', minor: '120050000', candidates: 1, why: 'grouped base with a fractional thousand' },
];

/**
 * A currency written after the amount. All three currencies are scale-100, so the currency axis does
 * not change `minor` — deliberately noted, because adding a JPY row here would silently break that
 * assumption and every composed row with it.
 */
const SUFFIXES = [
  { text: '', currency: null, why: 'no currency named: inherit the ledger currency' },
  { text: ' din', currency: 'RSD', why: 'leading space keeps the k lookahead from eating the suffix' },
  { text: ' rsd', currency: 'RSD', why: 'ISO code as a word' },
  { text: '€', currency: 'EUR', why: 'symbol suffix' },
  { text: '$', currency: 'USD', why: 'symbol suffix' },
];

const PREFIXES = ['Lidl', 'kupovina'];

/**
 * Hand-written rows for the amount-format cases the axes cannot express without lying about what
 * they cover: the currency-word list, the `kg` lookahead, exact bigint past 2^53, currency
 * inheritance, and an injected non-RSD ledger currency.
 */
const AMOUNT_SPECIALS = [
  {
    input: 'Lidl 20€',
    expected: { amountMinor: '2000', currency: 'EUR', kind: 'EXPENSE', occurredOn: null, description: 'Lidl', tokens: ['lidl'], candidates: 1 },
    note: 'symbol-suffixed euro amount is parsed in EUR, not the RSD ledger currency',
  },
  {
    input: 'Lidl 20 eur',
    expected: { amountMinor: '2000', currency: 'EUR', description: 'Lidl', candidates: 1 },
    note: 'currency word after a space',
  },
  {
    input: 'Lidl 20 eura',
    expected: { amountMinor: '2000', currency: 'EUR', description: 'Lidl', candidates: 1 },
    note: 'genitive plural of euro',
  },
  {
    input: 'Lidl 20 evra',
    expected: { amountMinor: '2000', currency: 'EUR', description: 'Lidl', candidates: 1 },
    note: 'the everyday Serbian spelling of euro',
  },
  {
    input: 'Lidl 1500 dinara',
    expected: { amountMinor: '150000', currency: 'RSD', description: 'Lidl', candidates: 1 },
    note: 'docs/04 §3.1 currency-suffix form',
  },
  {
    input: 'Lidl 1500 dindži',
    expected: { amountMinor: '150000', currency: 'RSD', description: 'Lidl', candidates: 1 },
    note: 'docs/04 §3.1 currency-suffix form, with a diacritic',
  },
  {
    input: 'Lidl 1500 dindzi',
    expected: { amountMinor: '150000', currency: 'RSD', description: 'Lidl', candidates: 1 },
    note: 'the same suffix folded to ASCII',
  },
  {
    input: 'Lidl 20$',
    expected: { amountMinor: '2000', currency: 'USD', description: 'Lidl', candidates: 1 },
    note: 'dollar symbol',
  },
  {
    input: 'Lidl 20 usd',
    expected: { amountMinor: '2000', currency: 'USD', description: 'Lidl', candidates: 1 },
    note: 'ISO code as a word',
  },
  {
    input: 'Lidl 20 dolara',
    expected: { amountMinor: '2000', currency: 'USD', description: 'Lidl', candidates: 1 },
    note: 'Serbian word for dollars',
  },
  {
    input: 'Lidl 2000kg',
    expected: { amountMinor: '200000', currency: null, description: 'Lidl kg', tokens: ['lidl', 'kg'], candidates: 1 },
    note: 'the k lookahead: `2000k` would be two million, `2000kg` is two thousand kilograms. `kg` is text, so it stays in the description.',
  },
  {
    input: 'Lidl 1.000.000,99',
    expected: { amountMinor: '100000099', currency: null, description: 'Lidl', candidates: 1 },
    note: 'two groups plus a decimal comma, exact to the para',
  },
  {
    input: 'Lidl 9007199254740993',
    expected: { amountMinor: '900719925474099300', currency: null, description: 'Lidl', candidates: 1 },
    note: 'past Number.MAX_SAFE_INTEGER: a float path loses the last digits (ADR-003)',
  },
  {
    input: 'Lidl 9007199254740993k',
    expected: { amountMinor: '900719925474099300000', currency: null, description: 'Lidl', candidates: 1 },
    note: 'the same value with a k shorthand, so both scalings stay exact',
  },
  {
    input: 'Lidl 0,05',
    expected: { amountMinor: '5', currency: null, description: 'Lidl', candidates: 1 },
    note: 'five para must not round to zero',
  },
  {
    input: 'Lidl 2000din',
    expected: { amountMinor: '200000', currency: 'RSD', kind: 'EXPENSE', occurredOn: null, description: 'Lidl', tokens: ['lidl'], candidates: 1 },
    note: 'docs/04 §3.1 names the attached form `2000din` verbatim; the suffix axis uses a leading space so the k lookahead cannot eat it',
  },
  {
    input: 'Lidl 1.200,50din',
    expected: { amountMinor: '120050', currency: 'RSD', description: 'Lidl', candidates: 1 },
    note: 'both separators with an attached currency word',
  },
  {
    input: 'Lidl 2000',
    ledgerCurrency: 'EUR',
    expected: { amountMinor: '200000', currency: null, description: 'Lidl', candidates: 1, kind: 'EXPENSE' },
    note: 'currency stays null so the caller inherits the ledger currency (docs/04 §3.2); 2000 EUR is 200000 cents',
  },
  {
    input: 'Lidl 2000 rsd',
    ledgerCurrency: 'EUR',
    expected: { amountMinor: '200000', currency: 'RSD', description: 'Lidl', candidates: 1 },
    note: 'a named currency beats the ledger currency',
  },
  {
    input: 'Lidl 2000',
    ledgerCurrency: 'JPY',
    expected: { amountMinor: '2000', currency: null, description: 'Lidl', candidates: 1 },
    note: 'JPY has no minor unit: proves the injected ledger currency, not a hardcoded x100, sets the scale',
  },
];

// ---------------------------------------------------------------------------------------------
// MERCHANT — Serbian retail and biller inputs
// ---------------------------------------------------------------------------------------------

/** Merchant display names and their **hand-folded** content tokens (docs/04 §3.1). */
const MERCHANTS = [
  { name: 'Lidl', tokens: ['lidl'] },
  { name: 'Maxi', tokens: ['maxi'] },
  { name: 'Idea', tokens: ['idea'] },
  { name: 'DIS', tokens: ['dis'] },
  { name: 'Univerexport', tokens: ['univerexport'] },
  { name: 'Shop&Go', tokens: ['shop', 'go'] },
  { name: 'Aman', tokens: ['aman'] },
  { name: 'Roda', tokens: ['roda'] },
  { name: 'Mere', tokens: ['mere'] },
  { name: 'Lilly', tokens: ['lilly'] },
  { name: 'Pekara Trpković', tokens: ['pekara', 'trpkovic'] },
  { name: 'Hleb & Kifle', tokens: ['hleb', 'kifle'] },
  { name: 'NIS Petrol', tokens: ['nis', 'petrol'] },
  { name: 'Lukoil', tokens: ['lukoil'] },
  { name: 'OMV', tokens: ['omv'] },
  { name: 'Shell', tokens: ['shell'] },
  { name: 'MOL', tokens: ['mol'] },
  { name: 'EPS', tokens: ['eps'] },
  { name: 'Vodovod', tokens: ['vodovod'] },
  { name: 'Srbijagas', tokens: ['srbijagas'] },
  { name: 'Beogradske elektrane', tokens: ['beogradske', 'elektrane'] },
  { name: 'SBB', tokens: ['sbb'] },
  { name: 'MTS', tokens: ['mts'] },
  { name: 'Yettel', tokens: ['yettel'] },
  { name: 'A1', tokens: ['a1'] },
  { name: 'Orion Telekom', tokens: ['orion', 'telekom'] },
  { name: 'Netflix', tokens: ['netflix'] },
  { name: 'Spotify', tokens: ['spotify'] },
  { name: 'HBO Max', tokens: ['hbo', 'max'] },
  { name: 'YouTube Premium', tokens: ['youtube', 'premium'] },
  { name: 'Apoteka Benu', tokens: ['apoteka', 'benu'] },
  { name: 'Apoteka Lilly', tokens: ['apoteka', 'lilly'] },
  { name: 'DM', tokens: ['dm'] },
  { name: 'Lilly Drogerie', tokens: ['lilly', 'drogerie'] },
  { name: 'Sport Vision', tokens: ['sport', 'vision'] },
  { name: 'Đak Sport', tokens: ['dak', 'sport'] },
  { name: 'Teretana', tokens: ['teretana'] },
  { name: 'Tempo', tokens: ['tempo'] },
  { name: 'Metro', tokens: ['metro'] },
  { name: 'Vero', tokens: ['vero'] },
];

/** Amounts realistic for these merchants, with the reading the spec requires. */
const MERCHANT_AMOUNTS = [
  { text: '199', minor: '19900', candidates: 1 },
  { text: '250', minor: '25000', candidates: 1 },
  { text: '349', minor: '34900', candidates: 1 },
  { text: '1.200', minor: '120000', candidates: 2 },
  { text: '2.000', minor: '200000', candidates: 2 },
  { text: '2.350', minor: '235000', candidates: 2 },
  { text: '3.500', minor: '350000', candidates: 2 },
  { text: '15.000', minor: '1500000', candidates: 2 },
  { text: '150000', minor: '15000000', candidates: 1 },
  { text: '1.250,50', minor: '125050', candidates: 1 },
  { text: '2,50', minor: '250', candidates: 1 },
  { text: '1.500', minor: '150000', candidates: 2 },
];

/** Explicit merchant+date rows, so every relative-date and absolute-date rule is exercised. */
const MERCHANT_DATES = [
  { name: 'Lidl', amount: '2.000', minor: '200000', candidates: 2, date: 'danas', occurredOn: '2026-09-14' },
  { name: 'Maxi', amount: '3.500', minor: '350000', candidates: 2, date: 'prekjuče', occurredOn: '2026-09-12' },
  { name: 'Idea', amount: '1.200', minor: '120000', candidates: 2, date: 'prošli petak', occurredOn: '2026-09-11' },
  { name: 'DIS', amount: '250', minor: '25000', candidates: 1, date: '1.9.', occurredOn: '2026-09-01' },
  { name: 'Univerexport', amount: '15.000', minor: '1500000', candidates: 2, date: '01.09.2026', occurredOn: '2026-09-01' },
  { name: 'Aman', amount: '150000', minor: '15000000', candidates: 1, date: '1/9', occurredOn: '2026-09-01' },
  { name: 'Roda', amount: '2.350', minor: '235000', candidates: 2, date: '1.9.2025', occurredOn: '2025-09-01' },
  { name: 'Mere', amount: '1.500', minor: '150000', candidates: 2, date: 'danas', occurredOn: '2026-09-14' },
];

/** Income markers (docs/04 §3.1), which are part of the common path even without a Merchant. */
const MERCHANT_INCOME = [
  { input: 'plata 150000', minor: '15000000', description: 'plata', tokens: ['plata'] },
  { input: 'Plata za avgust 150000', minor: '15000000', description: 'Plata za avgust', tokens: ['plata', 'za', 'avgust'] },
  { input: 'penzija 45000', minor: '4500000', description: 'penzija', tokens: ['penzija'] },
  { input: 'uplata 20000', minor: '2000000', description: 'uplata', tokens: ['uplata'] },
  { input: 'honorar 60000', minor: '6000000', description: 'honorar', tokens: ['honorar'] },
  { input: 'primio 25000', minor: '2500000', description: 'primio', tokens: ['primio'] },
  { input: 'povraćaj 3.500', minor: '350000', description: 'povraćaj', tokens: ['povracaj'] },
  { input: 'refundacija 2.000', minor: '200000', description: 'refundacija', tokens: ['refundacija'] },
];

/**
 * Refund/negation markers. docs/04 §3.1 says these "flag for user confirmation rather than guessing
 * a sign"; the §3.2 interface has no field for that flag, so `kind` is deliberately **not** pinned
 * here — see README "known gaps".
 */
const MERCHANT_REFUNDS = [
  { input: 'Lidl vraćeno 2000', minor: '200000', description: 'Lidl vraćeno', tokens: ['lidl', 'vraceno'] },
  { input: 'storno Lidl 2000', minor: '200000', description: 'storno Lidl', tokens: ['storno', 'lidl'] },
  { input: 'refund Lidl 2000', minor: '200000', description: 'refund Lidl', tokens: ['refund', 'lidl'] },
  { input: 'Maxi 3.500 vraćeno', minor: '350000', description: 'Maxi vraćeno', tokens: ['maxi', 'vraceno'] },
  { input: 'Idea 1.200 storno', minor: '120000', description: 'Idea storno', tokens: ['idea', 'storno'] },
  { input: 'vraćeno Maxi 2.000 juče', minor: '200000', description: 'vraćeno Maxi', tokens: ['vraceno', 'maxi'], occurredOn: '2026-09-13' },
];

/** Currency-suffix rows on real merchants. */
const MERCHANT_CURRENCIES = [
  { input: 'Lidl 2.000 rsd', minor: '200000', currency: 'RSD', description: 'Lidl', tokens: ['lidl'] },
  { input: 'Shell 20€', minor: '2000', currency: 'EUR', description: 'Shell', tokens: ['shell'] },
  { input: 'Spotify 10€', minor: '1000', currency: 'EUR', description: 'Spotify', tokens: ['spotify'] },
  { input: 'Netflix 15$', minor: '1500', currency: 'USD', description: 'Netflix', tokens: ['netflix'] },
  { input: 'NIS Petrol 5.000 din', minor: '500000', currency: 'RSD', description: 'NIS Petrol', tokens: ['nis', 'petrol'] },
  { input: 'Univerexport 1.250,50 rsd', minor: '125050', currency: 'RSD', description: 'Univerexport', tokens: ['univerexport'] },
  { input: 'Apoteka Benu 20 eur', minor: '2000', currency: 'EUR', description: 'Apoteka Benu', tokens: ['apoteka', 'benu'] },
  { input: 'HBO Max 20 dolara', minor: '2000', currency: 'USD', description: 'HBO Max', tokens: ['hbo', 'max'] },
];

// ---------------------------------------------------------------------------------------------
// BULK — segmentation across the separators docs/04 §3 names
// ---------------------------------------------------------------------------------------------

const BULK = [
  {
    input: 'Lidl 2000, gorivo 3500, plata 150000',
    note: 'the Phase 2 exit-criterion line; docs/04 §3',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE', tokens: ['lidl'] },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE', tokens: ['gorivo'] },
      { description: 'plata', amountMinor: '15000000', kind: 'INCOME', tokens: ['plata'] },
    ],
  },
  {
    input: 'Lidl 2000;gorivo 3500',
    note: 'semicolon separator',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000\ngorivo 3500',
    note: 'newline separator',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000 + gorivo 3500',
    note: 'plus separator',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000 i gorivo 3500',
    note: 'inline conjunction `i`',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000 pa gorivo 3500',
    note: 'inline conjunction `pa`',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000 I gorivo 3500',
    note: 'conjunction matching is case-insensitive',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000 PA gorivo 3500',
    note: 'uppercase `PA`',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000,,gorivo 3500',
    note: 'a run of separators collapses',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000;;gorivo 3500',
    note: 'run of semicolons',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2,50 i gorivo 3,00',
    note: 'a decimal comma must not split a fragment',
    expected: [
      { description: 'Lidl', amountMinor: '250', kind: 'EXPENSE', tokens: ['lidl'] },
      { description: 'gorivo', amountMinor: '300', kind: 'EXPENSE', tokens: ['gorivo'] },
    ],
  },
  {
    input: 'Lidl 1.250,50 i Maxi 2.000,00',
    note: 'decimal commas with thousands grouping on both sides of the separator',
    expected: [
      { description: 'Lidl', amountMinor: '125050', kind: 'EXPENSE' },
      { description: 'Maxi', amountMinor: '200000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'kafa 180, hleb 90',
    note: 'comma between fragments, no decimals',
    expected: [
      { description: 'kafa', amountMinor: '18000', kind: 'EXPENSE', tokens: ['kafa'] },
      { description: 'hleb', amountMinor: '9000', kind: 'EXPENSE', tokens: ['hleb'] },
    ],
  },
  {
    input: 'kafa 180, hleb 90, mleko 150',
    note: 'three short fragments',
    expected: [
      { description: 'kafa', amountMinor: '18000', kind: 'EXPENSE' },
      { description: 'hleb', amountMinor: '9000', kind: 'EXPENSE' },
      { description: 'mleko', amountMinor: '15000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'plata 150000, kirija 45000, struja 3.500',
    note: 'mixed direction in one line',
    expected: [
      { description: 'plata', amountMinor: '15000000', kind: 'INCOME' },
      { description: 'kirija', amountMinor: '4500000', kind: 'EXPENSE' },
      { description: 'struja', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000, Maxi 3500, Idea 1200, DIS 800',
    note: 'four supermarket fragments',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'Maxi', amountMinor: '350000', kind: 'EXPENSE' },
      { description: 'Idea', amountMinor: '120000', kind: 'EXPENSE' },
      { description: 'DIS', amountMinor: '80000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000, Maxi 3500\ngorivo 3500;plata 150000',
    note: 'every hard separator in one input',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'Maxi', amountMinor: '350000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
      { description: 'plata', amountMinor: '15000000', kind: 'INCOME' },
    ],
  },
  {
    input: 'Lidl juče 2000, gorivo danas 3500',
    note: 'relative dates are resolved per fragment',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE', occurredOn: '2026-09-13', tokens: ['lidl'] },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE', occurredOn: '2026-09-14', tokens: ['gorivo'] },
    ],
  },
  {
    input: 'Lidl 1.9. 2000, gorivo 2.9. 3500',
    note: 'absolute dates are resolved per fragment and never read as amounts',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE', occurredOn: '2026-09-01' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE', occurredOn: '2026-09-02' },
    ],
  },
  {
    input: 'Lidl 2.000 rsd i gorivo 20€',
    note: 'per-fragment currency is independent of the ledger currency',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE', currency: 'RSD' },
      { description: 'gorivo', amountMinor: '2000', kind: 'EXPENSE', currency: 'EUR' },
    ],
  },
  {
    input: 'Lidl 2k, gorivo 3.5k',
    note: 'k shorthand in a bulk line',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2k i gorivo 3,5k',
    note: 'comma-decimal shorthand in a bulk line',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Лиди 2000 и гориво 3500',
    note: 'Cyrillic conjunction `и` is the same separator; tokens are folded to Latin',
    expected: [
      { description: 'Лиди', amountMinor: '200000', kind: 'EXPENSE', tokens: ['lidi'] },
      { description: 'гориво', amountMinor: '350000', kind: 'EXPENSE', tokens: ['gorivo'] },
    ],
  },
  {
    input: 'Лиди 2000 па гориво 3500',
    note: 'Cyrillic conjunction `па`',
    expected: [
      { description: 'Лиди', amountMinor: '200000', kind: 'EXPENSE', tokens: ['lidi'] },
      { description: 'гориво', amountMinor: '350000', kind: 'EXPENSE', tokens: ['gorivo'] },
    ],
  },
  {
    input: 'pivo 200, Indian 300',
    note: 'a word containing `i` never splits',
    expected: [
      { description: 'pivo', amountMinor: '20000', kind: 'EXPENSE', tokens: ['pivo'] },
      { description: 'Indian', amountMinor: '30000', kind: 'EXPENSE', tokens: ['indian'] },
    ],
  },
  {
    input: 'Lidl 2000 iMax',
    note: '`i` without whitespace on both sides is not a separator, so this stays one fragment',
    expected: [
      { description: 'Lidl iMax', amountMinor: '200000', kind: 'EXPENSE', tokens: ['lidl', 'imax'] },
    ],
  },
  {
    input: 'Lidl 2000, gorivo 3500,',
    note: 'a trailing separator produces no empty fragment',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: '  Lidl 2000 ,, ; \n gorivo 3500  ',
    note: 'surrounding whitespace and blank fragments are dropped',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Vraćeno 2000, Lidl 3500',
    note: 'docs/04 §3.1: a refund word flags for confirmation. `kind` is not pinned — see README known gaps.',
    expected: [
      { description: 'Vraćeno', amountMinor: '200000', tokens: ['vraceno'], needsDirectionConfirmation: true },
      { description: 'Lidl', amountMinor: '350000', kind: 'EXPENSE', needsDirectionConfirmation: false },
    ],
  },
  {
    input: 'plata 150000 i vraćeno 2000',
    note: 'mixed direction: one fragment is unattributable, the other must still be usable (F-06)',
    expected: [
      { description: 'plata', amountMinor: '15000000', kind: 'INCOME', needsDirectionConfirmation: false },
      { description: 'vraćeno', amountMinor: '200000', tokens: ['vraceno'], needsDirectionConfirmation: true },
    ],
  },
  {
    input: 'Lidl 2000+ gorivo 3500',
    note: 'separator with no surrounding whitespace',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000 +gorivo 3500',
    note: 'separator followed directly by the next fragment',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000\ngorivo 3500\nplata 150000',
    note: 'three newline-separated fragments',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
      { description: 'plata', amountMinor: '15000000', kind: 'INCOME' },
    ],
  },
  {
    input: 'Mleko 179, Hleb 90, Jogurt 130, Sir 450, Kafa 200',
    note: 'five grocery fragments',
    expected: [
      { description: 'Mleko', amountMinor: '17900', kind: 'EXPENSE', tokens: ['mleko'] },
      { description: 'Hleb', amountMinor: '9000', kind: 'EXPENSE', tokens: ['hleb'] },
      { description: 'Jogurt', amountMinor: '13000', kind: 'EXPENSE', tokens: ['jogurt'] },
      { description: 'Sir', amountMinor: '45000', kind: 'EXPENSE', tokens: ['sir'] },
      { description: 'Kafa', amountMinor: '20000', kind: 'EXPENSE', tokens: ['kafa'] },
    ],
  },
  {
    input: 'gorivo 3500 pa kafa 180 pa hleb 90',
    note: 'chained `pa` separators',
    expected: [
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
      { description: 'kafa', amountMinor: '18000', kind: 'EXPENSE' },
      { description: 'hleb', amountMinor: '9000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Lidl 2000 ; gorivo 3500 + plata 150000',
    note: 'separators padded with spaces',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
      { description: 'plata', amountMinor: '15000000', kind: 'INCOME' },
    ],
  },
  {
    input: 'lidl 2.000 rsd, shell 20€, spotify 10 eur',
    note: 'lowercase input keeps its lowercase display text; tokens are folded',
    expected: [
      { description: 'lidl', amountMinor: '200000', kind: 'EXPENSE', currency: 'RSD', tokens: ['lidl'] },
      { description: 'shell', amountMinor: '2000', kind: 'EXPENSE', currency: 'EUR', tokens: ['shell'] },
      { description: 'spotify', amountMinor: '1000', kind: 'EXPENSE', currency: 'EUR', tokens: ['spotify'] },
    ],
  },
  {
    input: 'kupovina 3500 i popravka 1200 i registracija 25000',
    note: 'generic descriptions with no merchant',
    expected: [
      { description: 'kupovina', amountMinor: '350000', kind: 'EXPENSE' },
      { description: 'popravka', amountMinor: '120000', kind: 'EXPENSE' },
      { description: 'registracija', amountMinor: '2500000', kind: 'EXPENSE' },
    ],
  },
  {
    input: 'Stan 45000, struja 3.500, voda 1.200, internet 2.500, telefon 1.500',
    note: 'five biller fragments',
    expected: [
      { description: 'Stan', amountMinor: '4500000', kind: 'EXPENSE', tokens: ['stan'] },
      { description: 'struja', amountMinor: '350000', kind: 'EXPENSE', tokens: ['struja'] },
      { description: 'voda', amountMinor: '120000', kind: 'EXPENSE', tokens: ['voda'] },
      { description: 'internet', amountMinor: '250000', kind: 'EXPENSE', tokens: ['internet'] },
      { description: 'telefon', amountMinor: '150000', kind: 'EXPENSE', tokens: ['telefon'] },
    ],
  },
  {
    input: 'Lidl 2000, gorivo 3500, plata 150000, kirija 45000',
    note: 'four fragments mixing direction',
    expected: [
      { description: 'Lidl', amountMinor: '200000', kind: 'EXPENSE' },
      { description: 'gorivo', amountMinor: '350000', kind: 'EXPENSE' },
      { description: 'plata', amountMinor: '15000000', kind: 'INCOME' },
      { description: 'kirija', amountMinor: '4500000', kind: 'EXPENSE' },
    ],
  },
];

// ---------------------------------------------------------------------------------------------

const pad = (value) => String(value).padStart(4, '0');

function baseCase(slice, id, input, extra = {}) {
  return {
    id,
    slice,
    input,
    today: TODAY,
    ledgerCurrency: 'RSD',
    ...extra,
    provenance: extra.provenance ?? 'hand-labelled',
    addedIn: ADDED_IN,
  };
}

function buildAmountFormat() {
  const cases = [];
  let index = 0;

  // 26 numeric forms x 5 currency suffixes = 130 composed cases.
  SUFFIXES.forEach((suffix, suffixIndex) => {
    AMOUNT_FORMS.forEach((form, formIndex) => {
      index += 1;
      const prefix = PREFIXES[(formIndex + suffixIndex) % PREFIXES.length];
      cases.push(
        baseCase('AMOUNT_FORMAT', `amount-${pad(index)}`, `${prefix} ${form.text}${suffix.text}`, {
          expected: {
            amountMinor: form.minor,
            currency: suffix.currency,
            kind: 'EXPENSE',
            occurredOn: null,
            description: prefix,
            tokens: [prefix.toLowerCase()],
            candidates: form.candidates,
          },
          note: `${form.why}; suffix: ${suffix.why}`,
          provenance: 'synthetic',
        }),
      );
    });
  });

  // 20 hand-written specials.
  for (const special of AMOUNT_SPECIALS) {
    index += 1;
    cases.push(
      baseCase('AMOUNT_FORMAT', `amount-${pad(index)}`, special.input, {
        ledgerCurrency: special.ledgerCurrency ?? 'RSD',
        expected: special.expected,
        note: special.note,
      }),
    );
  }

  return cases;
}

function buildMerchant() {
  const cases = [];
  let index = 0;

  MERCHANTS.forEach((merchant, merchantIndex) => {
    const firstAmount = MERCHANT_AMOUNTS[(merchantIndex * 2) % MERCHANT_AMOUNTS.length];
    const secondAmount = MERCHANT_AMOUNTS[(merchantIndex * 2 + 1) % MERCHANT_AMOUNTS.length];

    index += 1;
    cases.push(
      baseCase('MERCHANT', `merchant-${pad(index)}`, `${merchant.name} ${firstAmount.text}`, {
        expected: {
          amountMinor: firstAmount.minor,
          currency: null,
          kind: 'EXPENSE',
          occurredOn: null,
          description: merchant.name,
          tokens: merchant.tokens,
          candidates: firstAmount.candidates,
        },
        note: 'common path: merchant name plus amount',
      }),
    );

    index += 1;
    cases.push(
      baseCase('MERCHANT', `merchant-${pad(index)}`, `${merchant.name} ${secondAmount.text} juče`, {
        expected: {
          amountMinor: secondAmount.minor,
          currency: null,
          kind: 'EXPENSE',
          occurredOn: '2026-09-13',
          description: merchant.name,
          tokens: merchant.tokens,
          candidates: secondAmount.candidates,
        },
        note: 'common path with the relative day `juče`',
      }),
    );
  });

  for (const row of MERCHANT_DATES) {
    index += 1;
    cases.push(
      baseCase('MERCHANT', `merchant-${pad(index)}`, `${row.name} ${row.amount} ${row.date}`, {
        expected: {
          amountMinor: row.minor,
          currency: null,
          kind: 'EXPENSE',
          occurredOn: row.occurredOn,
          description: row.name,
          tokens: MERCHANTS.find((merchant) => merchant.name === row.name).tokens,
          candidates: row.candidates,
        },
        note: 'date extraction: the date is removed from the description and never read as an amount',
      }),
    );
  }

  for (const row of MERCHANT_INCOME) {
    index += 1;
    cases.push(
      baseCase('MERCHANT', `merchant-${pad(index)}`, row.input, {
        expected: {
          amountMinor: row.minor,
          currency: null,
          kind: 'INCOME',
          occurredOn: null,
          description: row.description,
          tokens: row.tokens,
        },
        note: 'docs/04 §3.1 income marker',
      }),
    );
  }

  for (const row of MERCHANT_REFUNDS) {
    index += 1;
    cases.push(
      baseCase('MERCHANT', `merchant-${pad(index)}`, row.input, {
        expected: {
          amountMinor: row.minor,
          occurredOn: row.occurredOn ?? null,
          description: row.description,
          tokens: row.tokens,
          needsDirectionConfirmation: true,
        },
        note: 'docs/04 §3.1 refund/negation: confirm the sign, do not guess it. `kind` is not pinned — see README known gaps.',
      }),
    );
  }

  for (const row of MERCHANT_CURRENCIES) {
    index += 1;
    cases.push(
      baseCase('MERCHANT', `merchant-${pad(index)}`, row.input, {
        expected: {
          amountMinor: row.minor,
          currency: row.currency,
          kind: 'EXPENSE',
          occurredOn: null,
          description: row.description,
          tokens: row.tokens,
        },
        note: 'docs/04 §3.1 currency-suffix forms',
      }),
    );
  }

  return cases;
}

function buildBulk() {
  return BULK.map((row, rowIndex) =>
    baseCase('BULK', `bulk-${pad(rowIndex + 1)}`, row.input, {
      expected: row.expected,
      note: row.note,
    }),
  );
}

function writeFixture(name, cases) {
  const text = `${JSON.stringify(cases, null, 2).replace(/\u00a0/g, '\\u00a0')}\n`;
  writeFileSync(join(FIXTURES, name), text, 'utf8');
  console.log(`${name}: ${cases.length} cases`);
}

function main() {
  const amountFormat = buildAmountFormat();
  const merchant = buildMerchant();
  const bulk = buildBulk();

  const total = amountFormat.length + merchant.length + bulk.length;
  if (amountFormat.length !== 150 || merchant.length !== 110 || bulk.length !== 40 || total !== 300) {
    throw new Error(
      `composition drifted: amount=${amountFormat.length} merchant=${merchant.length} bulk=${bulk.length} total=${total}`,
    );
  }

  mkdirSync(FIXTURES, { recursive: true });
  writeFixture('amount-format.json', amountFormat);
  writeFixture('merchant.json', merchant);
  writeFixture('bulk.json', bulk);
  console.log(`total: ${total}`);
}

main();
