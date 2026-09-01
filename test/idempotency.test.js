import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { atomicRepository, IdempotencyConflictError } from '../src/repository.js';
import { createAuction, readAuction, newUserId } from './support/db.js';

let pool, repo;
before(() => { pool = createPool({ max: 10 }); repo = atomicRepository(pool); });
after(() => pool.end());

const countBids = async (auctionId) =>
  Number((await pool.query('SELECT count(*) FROM bids WHERE auction_id = $1', [auctionId])).rows[0].count);

test('a retried bid replays the original response and creates no second bid', async () => {
  const auction = await createAuction(pool);
  const bid = { auctionId: auction.id, userId: newUserId(), amountCents: 5000, idemKey: randomUUID() };

  const first = await repo.placeBid(bid);
  const retry = await repo.placeBid(bid);

  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(retry.outcome, first.outcome);
  assert.equal(retry.seq, first.seq);
  assert.equal(await countBids(auction.id), 1);
});

test('a retry of a successful self-raise replays it, rather than reporting already winning', async () => {
  // The bug this whole layer exists to prevent. Without idempotency resolving
  // ahead of the bid rules, the retry is judged against a world where the user
  // is already the top bidder and comes back refused — telling them they lost
  // an auction they are currently winning.
  const auction = await createAuction(pool);
  const userId = newUserId();
  await repo.placeBid({ auctionId: auction.id, userId, amountCents: 5000, idemKey: randomUUID() });

  const raise = { auctionId: auction.id, userId, amountCents: 9000, idemKey: randomUUID() };
  const first = await repo.placeBid(raise);
  const retry = await repo.placeBid(raise);

  assert.equal(first.outcome, 'ACCEPTED_SELF_RAISE');
  assert.equal(retry.outcome, 'ACCEPTED_SELF_RAISE', 'the retry must not be re-judged');
  assert.equal(retry.replayed, true);
  assert.equal(await countBids(auction.id), 2);
});

test('a replay returns the price as it stood at the original decision', async () => {
  const auction = await createAuction(pool);
  const bid = { auctionId: auction.id, userId: newUserId(), amountCents: 5000, idemKey: randomUUID() };
  const first = await repo.placeBid(bid);

  // The world moves on between the original and the retry.
  await repo.placeBid({ auctionId: auction.id, userId: newUserId(), amountCents: 50000, idemKey: randomUUID() });

  const retry = await repo.placeBid(bid);
  assert.equal(retry.currentTopCents, first.currentTopCents,
    'the replay was re-derived against a world that had moved on');
});

test('the same key with a different amount is a conflict, not a replay', async () => {
  const auction = await createAuction(pool);
  const idemKey = randomUUID();
  const userId = newUserId();
  await repo.placeBid({ auctionId: auction.id, userId, amountCents: 5000, idemKey });

  await assert.rejects(
    () => repo.placeBid({ auctionId: auction.id, userId, amountCents: 500000, idemKey }),
    IdempotencyConflictError,
  );
});

test('a conflicting retry leaves the auction untouched', async () => {
  // The UPDATE sits in a CTE that runs before the INSERT that trips the unique
  // index. If the failing statement did not roll the UPDATE back with it, the
  // auction would carry a bid the ledger never recorded.
  const auction = await createAuction(pool);
  const idemKey = randomUUID();
  const userId = newUserId();
  await repo.placeBid({ auctionId: auction.id, userId, amountCents: 5000, idemKey });
  const before = await readAuction(pool, auction.id);

  await repo.placeBid({ auctionId: auction.id, userId, amountCents: 500000, idemKey }).catch(() => {});

  const after = await readAuction(pool, auction.id);
  assert.deepEqual(
    { seq: after.seq, top: after.top_amount_cents },
    { seq: before.seq, top: before.top_amount_cents },
  );
});

test('two distinct keys from the same user are two distinct bids', async () => {
  const auction = await createAuction(pool);
  const userId = newUserId();
  await repo.placeBid({ auctionId: auction.id, userId, amountCents: 5000, idemKey: randomUUID() });
  await repo.placeBid({ auctionId: auction.id, userId, amountCents: 9000, idemKey: randomUUID() });
  assert.equal(await countBids(auction.id), 2);
});

test('concurrent retries of one bid produce exactly one ledger row', async () => {
  const auction = await createAuction(pool);
  const bid = { auctionId: auction.id, userId: newUserId(), amountCents: 5000, idemKey: randomUUID() };

  const settled = await Promise.all(Array.from({ length: 20 }, () => repo.placeBid(bid)));

  assert.equal(await countBids(auction.id), 1);
  assert.equal(settled.filter((r) => !r.replayed).length, 1, 'exactly one attempt is the original');
  assert.ok(settled.every((r) => r.seq === settled[0].seq));
});
