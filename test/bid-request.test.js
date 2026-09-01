import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBidRequest } from '../src/bid-request.js';

const VALID = {
  auction_id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  amount: 15000,
  idempotency_key: 'retry-key-1',
};
const withField = (k, v) => ({ ...VALID, [k]: v });

test('the brief\'s exact contract is accepted — idempotency_key is optional', () => {
  // The brief defines the body as auction_id, user_id, amount. Requiring a key
  // we invented would reject the contract as written, so an absent key is
  // valid and the repository derives one from the request itself.
  const { auction_id, user_id, amount } = VALID;
  assert.deepEqual(parseBidRequest({ auction_id, user_id, amount }), {
    ok: true,
    value: { auctionId: auction_id, userId: user_id, amountCents: amount, idemKey: null },
  });
});

test('a well-formed request maps onto the internal shape', () => {
  assert.deepEqual(parseBidRequest(VALID), {
    ok: true,
    value: {
      auctionId: VALID.auction_id,
      userId: VALID.user_id,
      amountCents: 15000,
      idemKey: 'retry-key-1',
    },
  });
});

const REJECTED = [
  ['a fractional amount',        withField('amount', 1.5),            'invalid_amount'],
  ['exponent notation',          withField('amount', 1e999),          'invalid_amount'],
  ['an amount beyond safe integers', withField('amount', 2 ** 53),    'invalid_amount'],
  ['a zero amount',              withField('amount', 0),              'invalid_amount'],
  ['a negative amount',          withField('amount', -100),           'invalid_amount'],
  ['an amount sent as a string', withField('amount', '15000'),        'invalid_amount'],
  ['a missing amount',           withField('amount', undefined),      'invalid_amount'],
  ['a malformed auction id',     withField('auction_id', 'not-a-uuid'), 'invalid_auction_id'],
  ['a missing auction id',       withField('auction_id', undefined),  'invalid_auction_id'],
  ['a malformed user id',        withField('user_id', 'nope'),        'invalid_user_id'],
  ['an empty idempotency key',   withField('idempotency_key', ''),    'invalid_idempotency_key'],
  ['a non-object body',          'nonsense',                          'invalid_body'],
  ['a null body',                null,                                'invalid_body'],
];

for (const [name, body, expected] of REJECTED) {
  test(`rejects ${name}`, () => {
    const result = parseBidRequest(body);
    assert.equal(result.ok, false);
    assert.equal(result.error, expected);
  });
}

test('1e999 arrives as Infinity, which is why the integer check catches it', () => {
  // Documents why no separate exponent-notation rule is needed: JSON.parse
  // turns 1e999 into Infinity long before any of our code sees it.
  assert.equal(JSON.parse('{"a":1e999}').a, Infinity);
  assert.equal(Number.isSafeInteger(Infinity), false);
});
