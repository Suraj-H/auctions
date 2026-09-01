import { createHash } from 'node:crypto';

const UNIQUE_VIOLATION = '23505';

/**
 * What makes two bids "the same request" for retry purposes.
 *
 * Positional and explicit on purpose. Hashing an object literal would make the
 * fingerprint depend on key order, so reordering the fields or adding one would
 * silently change every hash — turning honest retries of bids placed before the
 * deploy into spurious conflicts. A signature change is loud; a key reorder is
 * not.
 */
export const bidFingerprint = (auctionId, userId, amountCents) =>
  createHash('sha256').update([auctionId, userId, amountCents].join('\u0000')).digest();

export class AuctionNotFoundError extends Error {
  constructor(auctionId) {
    super(`no such auction: ${auctionId}`);
    this.name = 'AuctionNotFoundError';
    this.auctionId = auctionId;
  }
}

/** The same key used again for a materially different bid. */
export class IdempotencyConflictError extends Error {
  constructor(auctionId, idemKey) {
    super(`idempotency key ${idemKey} was already used on auction ${auctionId} for a different bid`);
    this.name = 'IdempotencyConflictError';
    this.auctionId = auctionId;
    this.idemKey = idemKey;
  }
}

/**
 * Accept a bid or refuse it, in one statement.
 *
 * The UPDATE's WHERE clause is the decision. There is no read-then-compare: the
 * price gate and the close gate are predicates on the row being written,
 * evaluated while holding its lock, so nothing can land between deciding and
 * writing. claim returns one row if the bid won and none if it did not, and
 * LEFT JOIN claim ON true yields exactly one row either way — so verdict names
 * the outcome for both paths and the ledger records every attempt, accepted or
 * refused, in a single round trip against a single snapshot.
 *
 * The verdict ladder is deliberately in the same order as resolve() in
 * resolver.js; conformance.test.js holds the two to the same answers.
 *
 * Every time reference is clock_timestamp(), never now(). now() is the
 * transaction start time, read before the lock was taken, which would
 * reintroduce the boundary race this statement exists to close.
 *
 * response_body is built here, from the state at the moment of the decision, so
 * a later retry replays what the caller was originally told rather than a fresh
 * answer about a world that has moved on.
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
),
verdict AS (
  SELECT
    c.seq AS seq,
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
    END AS outcome,
    CASE WHEN c.seq IS NOT NULL THEN $3::bigint ELSE a.top_amount_cents END AS current_top_cents
  FROM auctions a
  LEFT JOIN claim c ON true
  WHERE a.id = $1
)
INSERT INTO bids (auction_id, seq, user_id, amount_cents, outcome,
                  idem_key, request_hash, response_body)
SELECT $1, seq, $2, $3, outcome, $4, $5,
       jsonb_build_object('outcome', outcome, 'seq', seq,
                          'currentTopCents', current_top_cents)
FROM verdict
RETURNING response_body`;

const STORED_ATTEMPT = `
SELECT response_body, request_hash FROM bids
 WHERE auction_id = $1 AND user_id = $2 AND idem_key = $3`;

export function atomicRepository(pool) {
  return {
    async placeBid({ auctionId, userId, amountCents, idemKey }) {
      if (!idemKey) throw new TypeError('idemKey is required to make a bid retryable');
      const requestHash = bidFingerprint(auctionId, userId, amountCents);

      let rows;
      try {
        ({ rows } = await pool.query(PLACE_BID, [auctionId, userId, amountCents, idemKey, requestHash]));
      } catch (error) {
        if (error.code !== UNIQUE_VIOLATION) throw error;
        // The key is already spent. Nothing was written: the INSERT and the
        // UPDATE in its CTE are one statement, so the unique violation rolled
        // the auction back with it. This is why the index has to be allowed to
        // raise — ON CONFLICT DO NOTHING would let the UPDATE stand while the
        // ledger dropped the row.
        return replayStoredAttempt(pool, { auctionId, userId, idemKey, requestHash });
      }

      if (rows.length === 0) throw new AuctionNotFoundError(auctionId);
      return { ...rows[0].response_body, replayed: false };
    },
  };
}

async function replayStoredAttempt(pool, { auctionId, userId, idemKey, requestHash }) {
  const { rows } = await pool.query(STORED_ATTEMPT, [auctionId, userId, idemKey]);
  // The colliding insert blocked until the original committed, so its row is
  // always visible here.
  if (rows.length === 0) throw new Error(`idempotency key ${idemKey} collided but no attempt was stored`);

  const [stored] = rows;
  if (!stored.request_hash.equals(requestHash)) {
    throw new IdempotencyConflictError(auctionId, idemKey);
  }
  return { ...stored.response_body, replayed: true };
}
