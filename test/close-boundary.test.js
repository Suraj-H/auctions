import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { atomicRepository } from '../src/repository.js';
import { createAuction, readAuction, newUserId } from './support/db.js';
import { stormAuction, auditLedger } from './support/harness.js';

let pool, repo;
before(() => { pool = createPool({ max: 100 }); repo = atomicRepository(pool); });
after(() => pool.end());

/**
 * The close gate is a predicate inside the accepting statement, so it is only
 * meaningfully tested while bids are actually landing across the boundary.
 * A 200-bid storm takes roughly half a second, so an auction ending part-way
 * through is guaranteed to see traffic on both sides of its own deadline.
 */
test('no bid is accepted once the auction has ended, mid-storm', async () => {
  const auction = await createAuction(pool, { endsInMs: 400 });

  const storm = await stormAuction(repo, auction.id, { count: 300 });
  const audit = await auditLedger(pool, auction.id, storm);

  const closed = storm.results.filter((r) => r.outcome === 'REJECTED_AUCTION_CLOSED');

  // Without traffic on both sides of the deadline this test asserts nothing.
  assert.ok(storm.accepted.length > 0, 'no bid landed before the close');
  assert.ok(closed.length > 0, 'no bid landed after the close');

  // Exact check: top_bid_at is the very clock_timestamp() the gate compared
  // against ends_at, so this is the gate's own reading rather than a proxy for
  // it. It only covers the winning bid, which is why the broader check follows.
  const winner = await readAuction(pool, auction.id);
  assert.ok(winner.top_bid_at < winner.ends_at, 'the winning bid was stamped at or after the close');

  // Broader check, across every accepted bid. This one leans on created_at
  // defaulting to now() — the statement's start, never later than the gate's
  // clock read. If that default is ever changed to clock_timestamp() it becomes
  // a strictly later reading than the gate used and will report false lateness
  // at the boundary; change the default and this assertion has to go with it.
  const { rows } = await pool.query(
    `SELECT count(*)::int AS late
       FROM bids b JOIN auctions a ON a.id = b.auction_id
      WHERE b.auction_id = $1 AND b.seq IS NOT NULL AND b.created_at >= a.ends_at`,
    [auction.id],
  );
  assert.equal(rows[0].late, 0, 'a bid was accepted at or after the auction ended');

  assert.deepEqual(audit.violations, [], 'ledger violated its own invariants across the close');

  console.log(
    `  close boundary: ${storm.accepted.length} accepted before, ` +
      `${closed.length} refused after, 0 late acceptances`,
  );
});

test('an auction stays closed once its deadline has passed', async () => {
  const auction = await createAuction(pool, { endsInMs: 60 });
  await new Promise((r) => setTimeout(r, 150));

  const result = await repo.placeBid({
    auctionId: auction.id, userId: newUserId(), amountCents: 999999, idemKey: randomUUID(),
  });

  assert.equal(result.outcome, 'REJECTED_AUCTION_CLOSED');
  // The status flag is derived and eventual; the clock predicate is the gate,
  // and it refuses late bids whether or not a closer job has run yet.
  assert.equal((await readAuction(pool, auction.id)).status, 'OPEN');
});
