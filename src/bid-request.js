/**
 * Validate an incoming bid body and map it onto the internal shape.
 *
 * Pure, so the money rules get a fast table-driven test and the route stays a
 * thin adapter. The wire contract stays snake_case, exactly as specified;
 * camelCase starts here and goes no further out.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_KEY_LENGTH = 255;

const fail = (error, message) => ({ ok: false, error, message });

export function parseBidRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('invalid_body', 'expected a JSON object');
  }

  const { auction_id: auctionId, user_id: userId, amount, idempotency_key: idemKey } = body;

  if (typeof auctionId !== 'string' || !UUID.test(auctionId)) {
    return fail('invalid_auction_id', 'auction_id must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    return fail('invalid_user_id', 'user_id must be a UUID');
  }

  // Money is an integer count of minor units. Number.isSafeInteger rejects
  // fractions, values past 2^53 where JSON numbers stop being exact, and
  // Infinity — which is what JSON.parse produces for 1e999, so exponent
  // notation needs no rule of its own. A production contract would take a
  // string and parse it as a decimal, never trusting a JSON number with money.
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return fail('invalid_amount', 'amount must be a positive whole number of minor units');
  }

  if (typeof idemKey !== 'string' || idemKey.length === 0 || idemKey.length > MAX_KEY_LENGTH) {
    return fail('invalid_idempotency_key', `idempotency_key must be 1 to ${MAX_KEY_LENGTH} characters`);
  }

  return { ok: true, value: { auctionId, userId, amountCents: amount, idemKey } };
}
