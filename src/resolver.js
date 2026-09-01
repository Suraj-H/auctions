/**
 * The bid decision, as a pure function. No database, no clock of its own.
 *
 * The caller supplies `now` because the authoritative clock is the database's,
 * read inside the same statement that performs the write (DECISIONS.md D6).
 * Keeping it a parameter is what makes the boundary cases testable at all.
 *
 * Idempotency is deliberately NOT handled here. A retry is a transport concern
 * and is resolved before any bid-validity rule runs (DECISIONS.md R3), so
 * REPLAYED and CONFLICT_KEY_REUSED never reach this function.
 */

export const OUTCOMES = Object.freeze({
  ACCEPTED_LEADING: 'ACCEPTED_LEADING',
  ACCEPTED_SELF_RAISE: 'ACCEPTED_SELF_RAISE',
  REJECTED_NOT_HIGHER: 'REJECTED_NOT_HIGHER',
  REJECTED_BELOW_INCREMENT: 'REJECTED_BELOW_INCREMENT',
  REJECTED_AUCTION_CLOSED: 'REJECTED_AUCTION_CLOSED',
});

const refuse = (outcome) => ({ outcome, newState: null });

export function resolve(auction, bid, now) {
  // Close gate first: a closed auction refuses every bid, whatever its price.
  // `now < endsAt` is strict — a bid landing exactly at ends_at is late.
  if (auction.status !== 'OPEN' || now.getTime() >= auction.endsAt.getTime()) {
    return refuse(OUTCOMES.REJECTED_AUCTION_CLOSED);
  }

  // Price gate. The reserve is not checked here: it gates whether the lot
  // sells, not whether a bid is accepted.
  if (bid.amountCents <= auction.topAmountCents) {
    return refuse(OUTCOMES.REJECTED_NOT_HIGHER);
  }
  if (bid.amountCents < auction.topAmountCents + auction.minIncrementCents) {
    return refuse(OUTCOMES.REJECTED_BELOW_INCREMENT);
  }

  // Accepted. The top bidder raising themselves is a normal bid under the same
  // price rules, typed separately so support and shill detection can see it.
  const outcome =
    bid.userId === auction.topUserId
      ? OUTCOMES.ACCEPTED_SELF_RAISE
      : OUTCOMES.ACCEPTED_LEADING;

  return {
    outcome,
    newState: {
      seq: auction.seq + 1,
      topAmountCents: bid.amountCents,
      topUserId: bid.userId,
      topBidAt: now,
    },
  };
}
