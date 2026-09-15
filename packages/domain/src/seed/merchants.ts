/**
 * The merchants the product ships knowledge about (docs/01 F-13 step 4, docs/11 §2.3).
 *
 * **Content, not fixture**, and the reason the cold start is not embarrassing: nobody wants to teach
 * a budgeting app what `Lidl` is. The list is the shipped *catalogue* — `pnpm db:seed` writes these as
 * global `merchants` rows (`household_id IS NULL`, `is_global = true`) so every Household can read
 * them, and onboarding step 4 turns the ones a person selects into Household-owned rows carrying a
 * `default_category_id` and aliases.
 *
 * ## Why `categoryKey` rather than a category id
 *
 * `categories.household_id` is `NOT NULL`, so there is no global category tree for a global merchant
 * to point at, and `default_category_id` cannot reference another Household's row. A suggestion is
 * therefore expressed as a **seed key** ([`STARTER_CATEGORIES`](./categories.ts)), which onboarding
 * resolves against the tree it just created. Skipping onboarding step 1 therefore leaves these
 * suggestions unusable — which is honest, because without a category tree there is nothing to
 * categorise *into*.
 *
 * ## Aliases are how people actually type
 *
 * `septička` and `septicka`, `Đak` and `Djak`, `lidl` and `лидл`. The classifier folds both sides
 * (docs/04 §3), so a Cyrillic alias is not redundant with its Latin twin — it is the same match made
 * available to a Cyrillic keyboard. **Aliases must stay globally unambiguous after folding**: two
 * merchants sharing one folded alias would make resolution depend on row order, so
 * `packages/domain/src/seed/seed.spec.ts` asserts raw uniqueness and the API's integration spec
 * asserts folded uniqueness, which is the form that actually decides a match.
 *
 * @module @finmate/domain/seed
 */

/** One shipped merchant and the category its spending usually belongs to. */
export interface ShippedMerchant {
  readonly name: string;
  /** Lower-case and/or Cyrillic spellings people actually type. Include the plain name. */
  readonly aliases: readonly string[];
  /** A `StarterCategory.key`. Onboarding maps it to this Household's category. */
  readonly categoryKey: string;
}

export const SHIPPED_MERCHANTS: readonly ShippedMerchant[] = [
  // ---- supermarkets and markets ----
  { name: 'Lidl', aliases: ['lidl', 'lidle', 'лидл'], categoryKey: 'hrana-supermarket' },
  { name: 'Maxi', aliases: ['maxi', 'maksi'], categoryKey: 'hrana-supermarket' },
  { name: 'Idea', aliases: ['idea', 'idea market'], categoryKey: 'hrana-supermarket' },
  { name: 'DIS', aliases: ['dis', 'dis market'], categoryKey: 'hrana-supermarket' },
  { name: 'Univerexport', aliases: ['univerexport', 'univereksport'], categoryKey: 'hrana-supermarket' },
  { name: 'Shop&Go', aliases: ['shop&go', 'shop and go', 'shopgo'], categoryKey: 'hrana-supermarket' },
  { name: 'Aman', aliases: ['aman'], categoryKey: 'hrana-supermarket' },
  { name: 'Roda', aliases: ['roda'], categoryKey: 'hrana-supermarket' },
  { name: 'Mere', aliases: ['mere'], categoryKey: 'hrana-supermarket' },
  { name: 'Lilly', aliases: ['lilly', 'lili'], categoryKey: 'hrana-supermarket' },
  { name: 'Vero', aliases: ['vero', 'supervero', 'super vero'], categoryKey: 'hrana-supermarket' },
  { name: 'Metro', aliases: ['metro', 'metro cash & carry'], categoryKey: 'hrana-supermarket' },
  { name: 'Tempo', aliases: ['tempo', 'tempo market'], categoryKey: 'hrana-supermarket' },
  { name: 'Rodić', aliases: ['rodic', 'rodić'], categoryKey: 'hrana-supermarket' },

  // ---- bakery ----
  { name: 'Pekara Trpković', aliases: ['trpkovic', 'trpković'], categoryKey: 'hrana-pekara' },
  { name: 'Hleb & Kifle', aliases: ['hleb i kifle', 'hleb & kifle'], categoryKey: 'hrana-pekara' },

  // ---- restaurants, delivery and coffee ----
  { name: "McDonald's", aliases: ['mcdonalds', "mcdonald's", 'mek'], categoryKey: 'hrana-restoran' },
  { name: 'KFC', aliases: ['kfc'], categoryKey: 'hrana-restoran' },
  { name: 'Burger King', aliases: ['burger king', 'burgerking'], categoryKey: 'hrana-restoran' },
  { name: 'Wolt', aliases: ['wolt'], categoryKey: 'hrana-restoran' },
  { name: 'Glovo', aliases: ['glovo'], categoryKey: 'hrana-restoran' },
  { name: 'Coffee Dream', aliases: ['coffee dream'], categoryKey: 'hrana-kafa' },

  // ---- fuel, parking, tolls ----
  { name: 'NIS Petrol', aliases: ['nis', 'nis petrol', 'газпром'], categoryKey: 'auto-gorivo' },
  { name: 'Lukoil', aliases: ['lukoil', 'лукоил'], categoryKey: 'auto-gorivo' },
  { name: 'OMV', aliases: ['omv'], categoryKey: 'auto-gorivo' },
  { name: 'Shell', aliases: ['shell', 'šel'], categoryKey: 'auto-gorivo' },
  { name: 'MOL', aliases: ['mol'], categoryKey: 'auto-gorivo' },
  { name: 'Petrol', aliases: ['petrol'], categoryKey: 'auto-gorivo' },
  { name: 'Parking servis', aliases: ['parking servis', 'parking'], categoryKey: 'auto-parking' },
  { name: 'Putevi Srbije', aliases: ['putarina', 'putevi srbije'], categoryKey: 'auto-parking' },

  // ---- registration and insurance ----
  { name: 'Dunav osiguranje', aliases: ['dunav', 'dunav osiguranje'], categoryKey: 'auto-registracija' },

  // ---- utilities ----
  { name: 'EPS', aliases: ['eps', 'elektroprivreda', 'struja'], categoryKey: 'kuca-struja' },
  { name: 'Vodovod', aliases: ['vodovod', 'voda'], categoryKey: 'kuca-voda' },
  { name: 'Srbijagas', aliases: ['srbijagas', 'gas'], categoryKey: 'kuca-grejanje' },
  { name: 'Beogradske elektrane', aliases: ['elektrane', 'toplana'], categoryKey: 'kuca-grejanje' },
  { name: 'Infostan', aliases: ['infostan'], categoryKey: 'kuca-komunalije' },

  // ---- connectivity and subscriptions ----
  { name: 'SBB', aliases: ['sbb', 'sbb internet'], categoryKey: 'kuca-internet' },
  { name: 'MTS', aliases: ['mts', 'telekom srbija', 'telekom'], categoryKey: 'kuca-internet' },
  { name: 'Orion Telekom', aliases: ['orion'], categoryKey: 'kuca-internet' },
  { name: 'Yettel', aliases: ['yettel', 'telenor'], categoryKey: 'kuca-telefon' },
  { name: 'A1', aliases: ['a1', 'vip mobile', 'vip'], categoryKey: 'kuca-telefon' },
  { name: 'Netflix', aliases: ['netflix'], categoryKey: 'zabava-pretplate' },
  { name: 'Spotify', aliases: ['spotify'], categoryKey: 'zabava-pretplate' },
  { name: 'HBO Max', aliases: ['hbo', 'hbo max', 'max'], categoryKey: 'zabava-pretplate' },
  { name: 'Disney+', aliases: ['disney', 'disney+'], categoryKey: 'zabava-pretplate' },
  { name: 'YouTube Premium', aliases: ['youtube', 'yt premium'], categoryKey: 'zabava-pretplate' },

  // ---- health and pharmacy ----
  { name: 'Apoteka Benu', aliases: ['benu', 'apoteka benu'], categoryKey: 'porodica-zdravlje' },
  { name: 'Apoteka Lilly', aliases: ['apoteka lilly'], categoryKey: 'porodica-zdravlje' },
  { name: 'Dr Max', aliases: ['dr max', 'drmax'], categoryKey: 'porodica-zdravlje' },

  // ---- family ----
  { name: 'Dečji svet', aliases: ['decji svet', 'dečji svet'], categoryKey: 'porodica-deca' },
  { name: 'Cvećara', aliases: ['cvecara', 'cvećara', 'cvece'], categoryKey: 'porodica-pokloni' },

  // ---- drugstores and clothing ----
  { name: 'DM', aliases: ['dm', 'dm drogerie'], categoryKey: 'higijena' },
  { name: 'Lilly Drogerie', aliases: ['lilly drogerie'], categoryKey: 'higijena' },
  { name: 'Sport Vision', aliases: ['sport vision'], categoryKey: 'odeca' },
  { name: 'Đak Sport', aliases: ['djak', 'đak sport'], categoryKey: 'odeca' },
  { name: 'Zara', aliases: ['zara'], categoryKey: 'odeca' },
  { name: 'H&M', aliases: ['h&m', 'h and m'], categoryKey: 'odeca' },
  { name: 'Deichmann', aliases: ['deichmann'], categoryKey: 'odeca' },

  // ---- leisure ----
  { name: 'Teretana', aliases: ['teretana', 'gym'], categoryKey: 'zabava-sport' },
  { name: 'Cineplexx', aliases: ['cineplexx', 'bioskop'], categoryKey: 'zabava-izlasci' },

  // ---- banking fees ----
  { name: 'Banca Intesa', aliases: ['banca intesa', 'intesa'], categoryKey: 'finansije-naknade' },
  { name: 'Raiffeisen banka', aliases: ['raiffeisen'], categoryKey: 'finansije-naknade' },
];
