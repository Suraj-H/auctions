import { resolve } from '../../src/resolver.js';
import { bidFingerprint } from '../../src/repository.js';

/**
 * A CONTROL, not an implementation. Never imported by src/.
 *
 * This is the obvious way to write the endpoint: read the auction, decide in
 * application code, then write. It is here so the concurrency harness can be
 * shown catching the race it claims to rule out. A harness that has only ever
 * seen correct code is not evidence of anything.
 *
 * It is also a live regression guard: if the real repository is ever collapsed
 * back into read-then-write, the harness still fails on it.
 */
export function naiveRepository(pool) {
  return {
    async placeBid({ auctionId, userId, amountCents, idemKey }) {
      const { rows } = await pool.query('SELECT * FROM auctions WHERE id = $1', [auctionId]);
      const auction = rows[0];

      // --- the race window opens here -------------------------------------
      // Everything below decides against a snapshot that other requests are
      // already invalidating.
      const decision = resolve(
        {
          status: auction.status,
          endsAt: auction.ends_at,
          seq: Number(auction.seq),
          topAmountCents: Number(auction.top_amount_cents),
          topUserId: auction.top_user_id,
          minIncrementCents: Number(auction.min_increment_cents),
        },
        { userId, amountCents },
        new Date(),
      );

      const hash = bidFingerprint(auctionId, userId, amountCents);

      if (!decision.newState) {
        await pool.query(
          `INSERT INTO bids (auction_id, user_id, amount_cents, outcome, idem_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [auctionId, userId, amountCents, decision.outcome, idemKey, hash],
        );
        return { outcome: decision.outcome, seq: null };
      }

      await pool.query(
        `UPDATE auctions
            SET seq = $1, top_amount_cents = $2, top_user_id = $3, top_bid_at = $4
          WHERE id = $5`,
        [
          decision.newState.seq,
          decision.newState.topAmountCents,
          decision.newState.topUserId,
          decision.newState.topBidAt,
          auctionId,
        ],
      );
      await pool.query(
        `INSERT INTO bids (auction_id, seq, user_id, amount_cents, outcome, idem_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [auctionId, decision.newState.seq, userId, amountCents, decision.outcome, idemKey, hash],
      );
      return { outcome: decision.outcome, seq: decision.newState.seq };
    },
  };
}
