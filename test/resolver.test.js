import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '../src/resolver.js';

const CLOSE_MS = Date.parse('2026-09-01T12:00:00.000Z');
const at = (offsetMs) => new Date(CLOSE_MS + offsetMs);
const BEFORE = at(-1000);

// £100.00 top bid, £10.00 minimum increment, £500.00 reserve.
const openAuction = (over = {}) => ({
  id: 'auction-1',
  status: 'OPEN',
  endsAt: at(0),
  seq: 4,
  topAmountCents: 10000,
  topUserId: 'user-top',
  minIncrementCents: 1000,
  reserveCents: 50000,
  ...over,
});

const bid = (amountCents, userId = 'user-challenger') => ({ userId, amountCents });

// ---------------------------------------------------------------- price gate

test('refuses a bid below the current top', () => {
  const { outcome } = resolve(openAuction(), bid(9000), BEFORE);
  assert.equal(outcome, 'REJECTED_NOT_HIGHER');
});

test('refuses a bid equal to the current top — strictly higher means strictly', () => {
  const { outcome } = resolve(openAuction(), bid(10000), BEFORE);
  assert.equal(outcome, 'REJECTED_NOT_HIGHER');
});

test('refuses a bid above the top but under the minimum increment', () => {
  const { outcome } = resolve(openAuction(), bid(10500), BEFORE);
  assert.equal(outcome, 'REJECTED_BELOW_INCREMENT');
});

test('accepts a bid exactly on the minimum increment', () => {
  const { outcome } = resolve(openAuction(), bid(11000), BEFORE);
  assert.equal(outcome, 'ACCEPTED_LEADING');
});

test('accepts the first bid on an auction with no bids yet', () => {
  const empty = openAuction({ topAmountCents: 0, topUserId: null });
  const { outcome } = resolve(empty, bid(5000), BEFORE);
  assert.equal(outcome, 'ACCEPTED_LEADING');
});

test('accepts a bid below the reserve — the reserve gates the sale, not the bid', () => {
  const { outcome } = resolve(openAuction(), bid(11000), BEFORE);
  assert.equal(outcome, 'ACCEPTED_LEADING');
  assert.ok(11000 < openAuction().reserveCents, 'fixture must actually be under reserve');
});

// ---------------------------------------------------------------- close gate

test('accepts a bid one millisecond before the close', () => {
  const { outcome } = resolve(openAuction(), bid(20000), at(-1));
  assert.equal(outcome, 'ACCEPTED_LEADING');
});

test('refuses a bid landing exactly at ends_at — the boundary is exclusive', () => {
  const { outcome } = resolve(openAuction(), bid(20000), at(0));
  assert.equal(outcome, 'REJECTED_AUCTION_CLOSED');
});

test('refuses a bid one millisecond after the close', () => {
  const { outcome } = resolve(openAuction(), bid(20000), at(1));
  assert.equal(outcome, 'REJECTED_AUCTION_CLOSED');
});

test('refuses a bid once status is CLOSED even if the clock says otherwise', () => {
  const closed = openAuction({ status: 'CLOSED' });
  const { outcome } = resolve(closed, bid(20000), BEFORE);
  assert.equal(outcome, 'REJECTED_AUCTION_CLOSED');
});

test('the close gate is checked before the price gate', () => {
  const { outcome } = resolve(openAuction(), bid(50), at(1));
  assert.equal(outcome, 'REJECTED_AUCTION_CLOSED');
});

// ---------------------------------------------------------------- self-raise

test('accepts the current top bidder raising themselves, typed as a self-raise', () => {
  const { outcome } = resolve(openAuction(), bid(11000, 'user-top'), BEFORE);
  assert.equal(outcome, 'ACCEPTED_SELF_RAISE');
});

test('a self-raise still has to clear the minimum increment', () => {
  const { outcome } = resolve(openAuction(), bid(10500, 'user-top'), BEFORE);
  assert.equal(outcome, 'REJECTED_BELOW_INCREMENT');
});

test('a self-raise still has to be strictly higher', () => {
  const { outcome } = resolve(openAuction(), bid(10000, 'user-top'), BEFORE);
  assert.equal(outcome, 'REJECTED_NOT_HIGHER');
});

// ---------------------------------------------------------------- state transition

test('an accepted bid advances the sequence and installs the new top', () => {
  const now = BEFORE;
  const { newState } = resolve(openAuction(), bid(20000), now);
  assert.deepEqual(newState, {
    seq: 5,
    topAmountCents: 20000,
    topUserId: 'user-challenger',
    topBidAt: now,
  });
});

test('a refused bid produces no state change', () => {
  const { newState } = resolve(openAuction(), bid(9000), BEFORE);
  assert.equal(newState, null);
});

test('resolve does not mutate the auction it is given', () => {
  const auction = openAuction();
  const snapshot = structuredClone(auction);
  resolve(auction, bid(20000), BEFORE);
  assert.deepEqual(auction, snapshot);
});
