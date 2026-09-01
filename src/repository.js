import { randomUUID, createHash } from 'node:crypto';

export const hashOf = (payload) =>
  createHash('sha256').update(JSON.stringify(payload)).digest();

/**
 * Accept a bid or refuse it, in one statement.
 *
 * The UPDATE's WHERE clause is the decision. There is no read-then-compare: the
 * price gate and the close gate are predicates on the row being written,
 * evaluated while holding its lock, so nothing can land between deciding and
 * writing. The claim CTE returns one row if the bid won and none if it did not.
 *
 * LEFT JOIN claim ON true then yields exactly one row either way, so the CASE
 * ladder below names the outcome for both paths and the ledger records every
 * attempt — accepted or refused — without a second round trip or a second
 * snapshot. The ladder is deliberately in the same order as resolve() in
 * resolver.js; test/conformance.test.js holds the two to the same answers.
 *
 * Every time reference is clock_timestamp(), never now(). now() is the
 * transaction start time, read before the lock was taken, which would
 * reintroduce the boundary race this statement exists to close.
 */
const PLACE_BID = `
WITH claim AS (
  UPDATE auctions
     SET seq                  = seq + 1,
         previous_top_user_id = top_user_id,
         top_amount_cents     = $3,
         top_user_id          = $2,
         top_bid_at           = clock_timestamp()
   WHERE id       = $1
     AND status   = 'OPEN'
     AND clock_timestamp() < ends_at
     -- Both predicates are load-bearing. The second does NOT subsume the first:
     -- it only looks that way while min_increment_cents is constrained above
     -- zero. Allow a zero-increment auction and >= would start accepting equal
     -- bids, which breaks the one invariant this whole service exists to hold.
     AND $3 >  top_amount_cents
     AND $3 >= top_amount_cents + min_increment_cents
  RETURNING seq, previous_top_user_id
)
INSERT INTO bids (auction_id, seq, user_id, amount_cents, outcome, idem_key, request_hash)
SELECT
  $1, c.seq, $2, $3,
  CASE
    WHEN c.seq IS NOT NULL AND c.previous_top_user_id = $2
      THEN 'ACCEPTED_SELF_RAISE'::bid_outcome
    WHEN c.seq IS NOT NULL
      THEN 'ACCEPTED_LEADING'::bid_outcome
    WHEN a.status <> 'OPEN' OR clock_timestamp() >= a.ends_at
      THEN 'REJECTED_AUCTION_CLOSED'::bid_outcome
    WHEN $3 <= a.top_amount_cents
      THEN 'REJECTED_NOT_HIGHER'::bid_outcome
    ELSE 'REJECTED_BELOW_INCREMENT'::bid_outcome
  END,
  $4, $5
FROM auctions a
LEFT JOIN claim c ON true
WHERE a.id = $1
RETURNING seq, outcome`;

export function atomicRepository(pool) {
  return {
    async placeBid({ auctionId, userId, amountCents, idemKey = randomUUID() }) {
      const hash = hashOf({ auctionId, userId, amountCents });
      const { rows } = await pool.query(PLACE_BID, [auctionId, userId, amountCents, idemKey, hash]);
      if (rows.length === 0) throw new Error(`no such auction: ${auctionId}`);

      const [{ seq, outcome }] = rows;
      return { outcome, seq: seq === null ? null : Number(seq) };
    },
  };
}
