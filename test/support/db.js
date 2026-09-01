import { randomUUID, createHash } from 'node:crypto';

export const hashOf = (payload) =>
  createHash('sha256').update(JSON.stringify(payload)).digest();

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
