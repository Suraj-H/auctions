import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db.js';
import { resolve } from '../src/resolver.js';
import { atomicRepository } from '../src/repository.js';
import { createAuctionInState, newUserId } from './support/db.js';

/**
 * The bid rules exist twice: as a JS if-ladder in resolver.js, and as a CASE
 * ladder inside the accepting SQL statement. The SQL copy is not optional —
 * it is what makes the decision atomic — so the resolver is the duplicate.
 *
 * This holds the two to the same answers. Without it, resolver.test.js is
 * testing a specification that production has quietly stopped following.
 */

const INCREMENT = 1000;
const OPEN_FOR = 60_000;

const CASES = [
  { name: 'below the top bid',            top: 10000, amount:  9000, expect: 'REJECTED_NOT_HIGHER' },
  { name: 'equal to the top bid',         top: 10000, amount: 10000, expect: 'REJECTED_NOT_HIGHER' },
  { name: 'above the top, under the increment', top: 10000, amount: 10500, expect: 'REJECTED_BELOW_INCREMENT' },
  { name: 'exactly on the increment',     top: 10000, amount: 11000, expect: 'ACCEPTED_LEADING' },
  { name: 'well above the top',           top: 10000, amount: 50000, expect: 'ACCEPTED_LEADING' },
  { name: 'first bid on an empty auction', top: 0,    amount:  5000, expect: 'ACCEPTED_LEADING' },
  { name: 'top bidder raising themselves', top: 10000, amount: 11000, self: true, expect: 'ACCEPTED_SELF_RAISE' },
  { name: 'self-raise under the increment', top: 10000, amount: 10500, self: true, expect: 'REJECTED_BELOW_INCREMENT' },
  { name: 'auction whose end time has passed', top: 10000, amount: 50000, endsInMs: -1000, expect: 'REJECTED_AUCTION_CLOSED' },
  { name: 'auction already marked CLOSED', top: 10000, amount: 50000, status: 'CLOSED', expect: 'REJECTED_AUCTION_CLOSED' },
];

let pool;
before(() => { pool = createPool({ max: 4 }); });
after(() => pool.end());

for (const c of CASES) {
  test(`resolver and SQL agree: ${c.name}`, async () => {
    const topUserId = newUserId();
    const auction = await createAuctionInState(pool, {
      topAmountCents: c.top,
      topUserId,
      minIncrementCents: INCREMENT,
      endsInMs: c.endsInMs ?? OPEN_FOR,
      status: c.status ?? 'OPEN',
    });
    const userId = c.self ? topUserId : newUserId();

    const fromSql = await atomicRepository(pool).placeBid({
      auctionId: auction.id, userId, amountCents: c.amount,
    });

    const fromResolver = resolve(
      {
        status: auction.status,
        endsAt: auction.ends_at,
        seq: Number(auction.seq),
        topAmountCents: Number(auction.top_amount_cents),
        topUserId: auction.top_user_id,
        minIncrementCents: INCREMENT,
      },
      { userId, amountCents: c.amount },
      new Date(),
    );

    assert.equal(fromSql.outcome, c.expect, 'SQL disagreed with the expected outcome');
    assert.equal(fromResolver.outcome, c.expect, 'resolver disagreed with the expected outcome');
  });
}
