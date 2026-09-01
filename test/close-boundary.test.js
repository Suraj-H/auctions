import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { atomicRepository } from '../src/repository.js';
import { createAuction, readAuction, newUserId, waitForAcceptedBids, waitForClosedRefusals, closeNow } from './support/db.js';
import { stormAuction, streamBids, auditLedger } from './support/harness.js';

let pool, repo;
before(() => { pool = createPool({ max: 100 }); repo = atomicRepository(pool); });
after(() => pool.end());

/**
 * The close gate is a predicate inside the accepting statement, so it is only
 * meaningfully tested while bids are actually landing across the boundary.
 *
 * Two assumptions were removed to get here. The first version opened the auction
 * for a fixed 400ms and relied on a 300-bid burst outlasting it, which holds on a
 * typical machine and fails on a fast or a loaded one in either direction. The
 * second waited for bids to be accepted before closing, which was worse: waiting
 * consumed the burst, so barely any attempts were left to refuse.
 *
 * A third assumption survived a while longer: bidding ran for a fixed 900ms, which
 * has to be guessed against however long it takes to reach five accepted bids.
 * Under contention that wait consumed the whole window and the stream finished
 * before the close ever happened, leaving nothing to refuse. Both sides are now
 * explicit waits and the stream runs until it is told to stop, so the test depends
 * on observed state rather than on any duration.
 */
test('no bid is accepted once the auction has ended, mid-storm', async () => {
  const auction = await createAuction(pool, { endsInMs: 60_000 });

  const stream = streamBids(repo, auction.id);
  await waitForAcceptedBids(pool, auction.id, 5);
  await closeNow(pool, auction.id);
  await waitForClosedRefusals(pool, auction.id, 5);
  stream.stop();

  const storm = await stream.done;
  const audit = await auditLedger(pool, auction.id, storm);

  const closed = storm.results.filter((r) => r.outcome === 'REJECTED_AUCTION_CLOSED');

  // Both are structural rather than hopeful: the run does not proceed until five
  // bids have been accepted, and does not stop until five have been refused as
  // closed. Neither depends on how fast the machine is.
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
