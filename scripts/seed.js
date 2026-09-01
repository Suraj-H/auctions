import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';

// Same default as src/server.js, so the printed commands are right under PORT too.
const port = Number(process.env.PORT ?? 3000);

/**
 * Creates one open auction and prints ready-to-paste requests against it.
 *
 * The brief only asks for POST /bid, so there is no endpoint for creating an
 * auction. This exists so the endpoint can actually be exercised without
 * hand-writing SQL.
 */
const pool = createPool({ max: 1 });
try {
  const { rows } = await pool.query(
    `INSERT INTO auctions (ends_at, min_increment_cents, reserve_cents)
     VALUES (now() + interval '1 hour', 100, 50000)
     RETURNING id, ends_at, min_increment_cents`,
  );
  const auction = rows[0];
  const alice = randomUUID();
  const bob = randomUUID();

  // The body is exactly what the brief specifies. The retry key, when there is
  // one, rides in the Idempotency-Key header — it describes the delivery of the
  // request, not the bid.
  const bid = (user, amount, key) =>
    `curl -s -X POST localhost:${port}/bid -H 'content-type: application/json'` +
    (key ? ` -H 'Idempotency-Key: ${key}'` : '') +
    ` -d '${JSON.stringify({ auction_id: auction.id, user_id: user, amount })}'`;

  console.log(`
auction   ${auction.id}
ends      ${auction.ends_at.toISOString()}  (1 hour from now)
increment ${auction.min_increment_cents} minor units
reserve   50000

Start the server with 'npm start', then:

# 1. Alice bids 500.00 — accepted, 201
${bid(alice, 50000)}

# 2. The same request again — replayed, not re-judged. Still 201, replayed: true
${bid(alice, 50000)}

# 3. Bob bids 400.00 — refused, 200 REJECTED_NOT_HIGHER
${bid(bob, 40000)}

# 4. Bob bids 600.00 — accepted, 201
${bid(bob, 60000)}

# 5. Bob raises his own top bid — 201 ACCEPTED_SELF_RAISE
${bid(bob, 70000, 'bob-raise-1')}

# 6. Same key, different amount — 409 idempotency_key_reused
${bid(bob, 99999, 'bob-raise-1')}

# 7. A fractional amount — 400 invalid_amount
${bid(alice, 1.5)}
`);
} finally {
  await pool.end();
}
