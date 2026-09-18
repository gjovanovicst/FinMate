/**
 * The Household's vocabulary, in the one shape both planners match against.
 *
 * The read planner and the write planner answer different questions about the same words — *"koliko sam
 * potrošio na hranu"* and *"postavi budžet za hranu na 20000"* must resolve `hranu` to the **same**
 * Category — so the adapter that turns a service's rows into `NamedEntity` lives here rather than twice.
 * A second mapping is how a budget starts scoping a different Category than the answer beside it names.
 *
 * The mapping is deliberately thin: a name, the breadcrumb, the `INCLUDE` keywords and the kind. It
 * carries no figure and no id beyond the row's own, because the planner never computes anything about
 * money (ADR-001) and a slot's id must come from the database (ADR-035 decision 5).
 *
 * @module apps/api/src/modules/assistant
 */

import type { Account } from '../accounts/account.model';
import type { CategoryModel } from '../taxonomy/category.model';
import type { GoalView } from '../goals/goals.service';
import type { MerchantModel } from '../taxonomy/merchant.model';
import type { TagModel } from '../taxonomy/tag.model';
import type { NamedEntity } from './query-planner';

export function categoryEntities(categories: readonly CategoryModel[]): readonly NamedEntity[] {
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    path: category.path.join(' / '),
    owned: true,
    // The tree's own vocabulary, which the capture path classifies with. `INCLUDE` only: an `EXCLUDE`
    // keyword means *this word does not belong here* (docs/04 §5.4), so it must not attract a question
    // — or a budget.
    keywords: category.keywords
      .filter((keyword) => keyword.polarity === 'INCLUDE')
      .map((keyword) => keyword.keyword),
    kind: category.kind,
  }));
}

export function merchantEntities(merchants: readonly MerchantModel[]): readonly NamedEntity[] {
  return merchants.map((merchant) => ({
    id: merchant.id,
    name: merchant.name,
    // `merchants` is the one list with shared rows in it (docs/08's global allow-list), and the
    // Household's own copy of a seeded name is the row its Transactions point at.
    owned: !merchant.isGlobal,
  }));
}

export function accountEntities(accounts: readonly Account[]): readonly NamedEntity[] {
  return accounts.map((account) => ({ id: account.id, name: account.name, owned: true }));
}

export function tagEntities(tags: readonly TagModel[]): readonly NamedEntity[] {
  return tags.map((tag) => ({ id: tag.id, name: tag.name, owned: true }));
}

export function goalEntities(goals: readonly GoalView[]): readonly NamedEntity[] {
  return goals.map((goal) => ({ id: goal.id, name: goal.name, owned: true }));
}

/** A recurring rule is named by its description — the only way a question can refer to one. */
export function recurringEntities(
  rules: readonly { readonly id: string; readonly description: string }[],
): readonly NamedEntity[] {
  return rules.map((rule) => ({ id: rule.id, name: rule.description, owned: true }));
}
