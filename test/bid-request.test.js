import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBidRequest } from '../src/bid-request.js';

// Exactly the body the brief specifies. Nothing added.
const VALID = {
  auction_id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  amount: 15000,
};
const withField = (k, v) => ({ ...VALID, [k]: v });
const value = (over = {}) => ({
  auctionId: VALID.auction_id, userId: VALID.user_id, amountCents: 15000, idemKey: null, ...over,
});

test("the brief's exact body is accepted with no idempotency key", () => {
  assert.deepEqual(parseBidRequest(VALID), { ok: true, value: value() });
});

test('an Idempotency-Key header is carried through', () => {
  assert.deepEqual(parseBidRequest(VALID, 'retry-key-1'), {
    ok: true, value: value({ idemKey: 'retry-key-1' }),
  });
});

test('a quoted header value means the same key as an unquoted one', () => {
  // The IETF draft types the field as a Structured Field String, which is
  // quoted; Stripe and every curl user send it bare. Without normalising, a
  // client following the RFC and one following Stripe would send the same
  // logical key and get two different bids.
  assert.deepEqual(parseBidRequest(VALID, '"retry-key-1"').value.idemKey, 'retry-key-1');
  assert.deepEqual(parseBidRequest(VALID, '  retry-key-1  ').value.idemKey, 'retry-key-1');
});

test('a key inside the body is refused, pointing at the header', () => {
  // Silently ignoring it would leave the caller believing they had the
  // guarantee they chose, when they actually got the weaker fingerprint
  // fallback. A loud error is cheaper than that.
  const result = parseBidRequest(withField('idempotency_key', 'k1'));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'idempotency_key_in_body');
  assert.match(result.message, /Idempotency-Key header/);
});

const REJECTED = [
  ['a fractional amount',            [withField('amount', 1.5)],            'invalid_amount'],
  ['exponent notation',              [withField('amount', 1e999)],          'invalid_amount'],
  ['an amount beyond safe integers', [withField('amount', 2 ** 53)],        'invalid_amount'],
  ['a zero amount',                  [withField('amount', 0)],              'invalid_amount'],
  ['a negative amount',              [withField('amount', -100)],           'invalid_amount'],
  ['an amount sent as a string',     [withField('amount', '15000')],        'invalid_amount'],
  ['a missing amount',               [withField('amount', undefined)],      'invalid_amount'],
  ['a malformed auction id',         [withField('auction_id', 'nope')],     'invalid_auction_id'],
  ['a missing auction id',           [withField('auction_id', undefined)],  'invalid_auction_id'],
  ['a malformed user id',            [withField('user_id', 'nope')],        'invalid_user_id'],
  ['a non-object body',              ['nonsense'],                          'invalid_body'],
  ['a null body',                    [null],                                'invalid_body'],
  ['an empty header',                [VALID, ''],                           'invalid_idempotency_key'],
  ['a whitespace-only header',       [VALID, '   '],                        'invalid_idempotency_key'],
  ['an over-long header',            [VALID, 'x'.repeat(256)],              'invalid_idempotency_key'],
  ['a non-string header',            [VALID, 123],                          'invalid_idempotency_key'],
];

for (const [name, args, expected] of REJECTED) {
  test(`rejects ${name}`, () => {
    const result = parseBidRequest(...args);
    assert.equal(result.ok, false);
    assert.equal(result.error, expected);
  });
}

test('1e999 arrives as Infinity, which is why the integer check catches it', () => {
  assert.equal(JSON.parse('{"a":1e999}').a, Infinity);
  assert.equal(Number.isSafeInteger(Infinity), false);
});
