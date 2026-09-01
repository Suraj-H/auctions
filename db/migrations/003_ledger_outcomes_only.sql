-- REPLAYED and CONFLICT_KEY_REUSED describe what the API answered, not what
-- happened to the auction, and neither was ever reachable in this column: a
-- replay deliberately writes no row (the unique index on the idempotency key is
-- what makes it a replay), and a conflicting key cannot be inserted at all.
--
-- Keeping them here conflated two vocabularies in one type — what is on the
-- ledger, and what the caller was told. The ledger keeps its own.

ALTER TABLE bids ALTER COLUMN outcome TYPE text;
DROP TYPE bid_outcome;

CREATE TYPE bid_outcome AS ENUM (
  'ACCEPTED_LEADING',
  'ACCEPTED_SELF_RAISE',
  'REJECTED_NOT_HIGHER',
  'REJECTED_BELOW_INCREMENT',
  'REJECTED_AUCTION_CLOSED'
);

ALTER TABLE bids ALTER COLUMN outcome TYPE bid_outcome USING outcome::bid_outcome;
