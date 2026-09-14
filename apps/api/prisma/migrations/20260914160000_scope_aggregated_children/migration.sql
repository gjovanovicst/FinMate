-- Give the three AGGREGATED child tables their own household_id.
--
-- Why: transaction_splits, receipt_items and goal_contributions are all summed per Household
-- (budget consumption by category, "how much on meat this month", goal progress). Without a
-- household_id they cannot be scoped or indexed by tenant, and reassigning them when a Category is
-- deleted would need a bypass of the tenancy guard.
--
-- Additive and safe: the column is added NULLable, backfilled from the parent, then made NOT NULL.
-- That ordering matters — a NOT NULL column with no default would lock and fail on existing rows.

ALTER TABLE transaction_splits ADD COLUMN household_id UUID;
UPDATE transaction_splits s
   SET household_id = t.household_id
  FROM transactions t
 WHERE t.id = s.transaction_id;
ALTER TABLE transaction_splits ALTER COLUMN household_id SET NOT NULL;
ALTER TABLE transaction_splits
  ADD CONSTRAINT transaction_splits_household_id_fkey
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE;
CREATE INDEX transaction_splits_household_category_idx
  ON transaction_splits (household_id, category_id);

ALTER TABLE receipt_items ADD COLUMN household_id UUID;
UPDATE receipt_items i
   SET household_id = r.household_id
  FROM receipts r
 WHERE r.id = i.receipt_id;
ALTER TABLE receipt_items ALTER COLUMN household_id SET NOT NULL;
ALTER TABLE receipt_items
  ADD CONSTRAINT receipt_items_household_id_fkey
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE;
CREATE INDEX receipt_items_household_category_idx
  ON receipt_items (household_id, category_id);

ALTER TABLE goal_contributions ADD COLUMN household_id UUID;
UPDATE goal_contributions c
   SET household_id = g.household_id
  FROM saving_goals g
 WHERE g.id = c.goal_id;
ALTER TABLE goal_contributions ALTER COLUMN household_id SET NOT NULL;
ALTER TABLE goal_contributions
  ADD CONSTRAINT goal_contributions_household_id_fkey
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE;
CREATE INDEX goal_contributions_household_idx ON goal_contributions (household_id);
