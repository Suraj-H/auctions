-- Who a bid displaced, captured atomically by the bid itself.
--
-- Needed because RETURNING yields post-update values, so the accepting
-- statement has no other way to see who held the top bid a moment earlier —
-- and without that it cannot tell a self-raise from an ordinary lead. The SET
-- expression reads the pre-update value under the row lock, so this is exact
-- rather than a best-effort read.
--
-- (PostgreSQL 18 adds RETURNING OLD, which would make this column unnecessary.
-- It is also useful on its own: it records the displacement chain.)

ALTER TABLE auctions ADD COLUMN previous_top_user_id uuid;
