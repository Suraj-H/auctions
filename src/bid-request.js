/**
 * Validate an incoming bid and map it onto the internal shape.
 *
 * Pure, so the money rules get a fast table-driven test and the route stays a
 * thin adapter. The body is exactly what the brief specifies — auction_id,
 * user_id, amount — in snake_case; camelCase starts here and goes no further out.
 *
 * The retry key arrives separately because it is not part of the bid. It says
 * how to treat the delivery of this request, not what is being bid, which is why
 * it belongs in the Idempotency-Key header (IETF
 * draft-ietf-httpapi-idempotency-key-header) rather than the payload. Body and
 * header are validated together here so there is one place that can reject a
 * request, not two that can drift.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_KEY_LENGTH = 255;
const QUOTED = /^"(.*)"$/;

const fail = (error, message) => ({ ok: false, error, message });

/**
 * The IETF draft types the field as a Structured Field String, which is quoted;
 * Stripe and every hand-written curl send it bare. Both spellings have to mean
 * the same key, or a client following the RFC and one following Stripe send the
 * same logical retry and get two separate bids.
 */
function normalizeKey(raw) {
  const trimmed = raw.trim();
  return QUOTED.exec(trimmed)?.[1] ?? trimmed;
}

export function parseBidRequest(body, idempotencyKey) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('invalid_body', 'expected a JSON object');
  }

  if ('idempotency_key' in body) {
    return fail(
      'idempotency_key_in_body',
      'send the retry key in the Idempotency-Key header, not the body — it describes ' +
        'the delivery of this request rather than the bid itself',
    );
  }

  const { auction_id: auctionId, user_id: userId, amount } = body;

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

  // The header is optional: the brief's body is a complete request on its own,
  // and the repository derives a key from the request when none is supplied.
  let idemKey = null;
  if (idempotencyKey !== undefined) {
    if (typeof idempotencyKey !== 'string') {
      return fail('invalid_idempotency_key', 'Idempotency-Key must be a string');
    }
    idemKey = normalizeKey(idempotencyKey);
    if (idemKey.length === 0 || idemKey.length > MAX_KEY_LENGTH) {
      return fail('invalid_idempotency_key', `Idempotency-Key must be 1 to ${MAX_KEY_LENGTH} characters`);
    }
  }

  return { ok: true, value: { auctionId, userId, amountCents: amount, idemKey } };
}
