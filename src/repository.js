import { randomUUID, createHash } from 'node:crypto';
import { resolve } from './resolver.js';

const hashOf = (payload) => createHash('sha256').update(JSON.stringify(payload)).digest();

/**
 * Accept a bid, or refuse it, in one statement.
 *
 * The UPDATE's WHERE clause is the decision. There is no read-then-compare:
 * the price gate and the close gate are predicates on the row being written,
 * evaluated while holding its lock, so no other bid can land between deciding
 * and writing. Zero rows back means refused.
 *
 * clock_timestamp() rather than now(): now() is the transaction start time,
 * which would be read before the lock was acquired and would reintroduce the
 * boundary race this statement exists to close.
 */
const ACCEPT = `
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
     AND $3 > top_amount_cents
     AND $3 >= top_amount_cents + min_increment_cents
  RETURNING seq, previous_top_user_id
)
INSERT INTO bids (auction_id, seq, user_id, amount_cents, outcome, idem_key, request_hash)
SELECT $1, seq, $2, $3,
       CASE WHEN previous_top_user_id = $2
            THEN 'ACCEPTED_SELF_RAISE'::bid_outcome
            ELSE 'ACCEPTED_LEADING'::bid_outcome END,
       $4, $5
  FROM claim
RETURNING seq, outcome`;

const RECORD_REFUSAL = `
INSERT INTO bids (auction_id, user_id, amount_cents, outcome, idem_key, request_hash)
VALUES ($1, $2, $3, $4, $5, $6)`;

export function atomicRepository(pool) {
  return {
    name: 'atomic conditional update',

    async placeBid({ auctionId, userId, amountCents, idemKey = randomUUID() }) {
      const hash = hashOf({ auctionId, userId, amountCents });
      const { rows } = await pool.query(ACCEPT, [auctionId, userId, amountCents, idemKey, hash]);

      if (rows.length === 1) {
        return { outcome: rows[0].outcome, seq: Number(rows[0].seq) };
      }

      // Refused. Reading the auction again to name the reason is safe despite
      // the race: top_amount_cents only ever increases and a closed auction
      // never reopens, so a refusal cannot become an acceptance while we look.
      // The reason is a lower bound on the truth, and that is enough.
      const outcome = await explainRefusal(pool, auctionId, { userId, amountCents });
      await pool.query(RECORD_REFUSAL, [auctionId, userId, amountCents, outcome, idemKey, hash]);
      return { outcome, seq: null };
    },
  };
}

async function explainRefusal(pool, auctionId, bid) {
  const { rows } = await pool.query('SELECT * FROM auctions WHERE id = $1', [auctionId]);
  if (rows.length === 0) throw new Error(`no such auction: ${auctionId}`);
  const a = rows[0];

  return resolve(
    {
      status: a.status,
      endsAt: a.ends_at,
      seq: Number(a.seq),
      topAmountCents: Number(a.top_amount_cents),
      topUserId: a.top_user_id,
      minIncrementCents: Number(a.min_increment_cents),
    },
    bid,
    new Date(),
  ).outcome;
}
