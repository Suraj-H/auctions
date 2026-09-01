import { readAuction, readAcceptedBids, newUserId } from './db.js';

const isAccepted = (outcome) => outcome?.startsWith('ACCEPTED');

/**
 * Fire `count` bids at one auction as concurrently as the pool allows, each
 * from a different user, at strictly increasing amounts. Which bids ought to
 * win depends on the order they land in — that is the point. What must hold
 * regardless of order is checked by auditLedger below.
 */
export async function stormAuction(repository, auctionId, { count = 200, startCents = 1000 } = {}) {
  const attempts = Array.from({ length: count }, (_, i) => ({
    userId: newUserId(),
    amountCents: startCents + i * 100,
  }));

  const settled = await Promise.allSettled(
    attempts.map((a) => repository.placeBid({ auctionId, ...a })),
  );

  const results = settled.map((s, i) => ({
    ...attempts[i],
    outcome: s.status === 'fulfilled' ? s.value.outcome : null,
    error: s.status === 'rejected' ? s.reason : null,
  }));

  return {
    results,
    accepted: results.filter((r) => isAccepted(r.outcome)),
    writeErrors: results.filter((r) => r.error),
  };
}

/**
 * The invariants the design claims, checked against what is actually on disk.
 * Returns a list of violations rather than throwing, so a test can assert
 * either that there are none or — for the naive control — that there are some.
 */
export async function auditLedger(pool, auctionId, storm) {
  const auction = await readAuction(pool, auctionId);
  const ledger = await readAcceptedBids(pool, auctionId);
  const finalTop = Number(auction.top_amount_cents);
  const violations = [];

  // 1. Nobody is told they lead with an amount the auction never reached.
  //    This is the lost update, seen from the bidder's side: a wrong answer.
  for (const bid of storm.accepted) {
    if (bid.amountCents > finalTop) {
      violations.push(
        `bidder told ${bid.outcome} at ${bid.amountCents} but the auction finished at ${finalTop}`,
      );
    }
  }

  // 2. Accepted amounts strictly increase in sequence order.
  for (let i = 1; i < ledger.length; i++) {
    if (ledger[i].amountCents <= ledger[i - 1].amountCents) {
      violations.push(
        `seq ${ledger[i - 1].seq}→${ledger[i].seq} did not increase: ` +
          `${ledger[i - 1].amountCents} → ${ledger[i].amountCents}`,
      );
    }
  }

  // 3. Sequence numbers are dense and unique: 1..n with no gaps or repeats.
  ledger.forEach((bid, i) => {
    if (bid.seq !== i + 1) violations.push(`expected seq ${i + 1}, found ${bid.seq}`);
  });

  // 4. The auction row agrees with its own ledger.
  const highest = ledger.at(-1);
  if (highest && highest.amountCents !== finalTop) {
    violations.push(`top bid in ledger is ${highest.amountCents} but auction says ${finalTop}`);
  }

  return { violations, finalTop, acceptedOnDisk: ledger.length };
}
