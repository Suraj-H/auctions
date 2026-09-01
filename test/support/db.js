import { randomUUID } from 'node:crypto';


/** An open auction with no bids, ending far enough away to be irrelevant. */
export async function createAuction(pool, over = {}) {
  const { endsInMs = 60_000, minIncrementCents = 1, reserveCents = 0 } = over;
  const { rows } = await pool.query(
    `INSERT INTO auctions (ends_at, min_increment_cents, reserve_cents)
     VALUES (now() + make_interval(secs => $1), $2, $3)
     RETURNING *`,
    [endsInMs / 1000, minIncrementCents, reserveCents],
  );
  return rows[0];
}

export async function readAuction(pool, auctionId) {
  const { rows } = await pool.query('SELECT * FROM auctions WHERE id = $1', [auctionId]);
  return rows[0];
}

export async function readAcceptedBids(pool, auctionId) {
  const { rows } = await pool.query(
    `SELECT seq, user_id, amount_cents, outcome
       FROM bids
      WHERE auction_id = $1 AND seq IS NOT NULL
      ORDER BY seq`,
    [auctionId],
  );
  return rows.map((r) => ({ ...r, seq: Number(r.seq), amountCents: Number(r.amount_cents) }));
}

export const newUserId = () => randomUUID();

/**
 * An auction pinned to an exact state, for driving the decision table.
 * top_bid_is_whole means the three top-bid columns move together or not at all.
 */
export async function createAuctionInState(pool, { topAmountCents, topUserId, minIncrementCents, endsInMs, status = 'OPEN' }) {
  const hasTopBid = topAmountCents > 0;
  const { rows } = await pool.query(
    `INSERT INTO auctions (status, ends_at, min_increment_cents,
                           top_amount_cents, top_user_id, top_bid_at)
     VALUES ($1, now() + make_interval(secs => $2), $3, $4, $5, CASE WHEN $6 THEN now() END)
     RETURNING *`,
    [status, endsInMs / 1000, minIncrementCents,
     topAmountCents, hasTopBid ? topUserId : null, hasTopBid],
  );
  return rows[0];
}
