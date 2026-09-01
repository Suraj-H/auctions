import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db.js';
import { createAuction } from './support/db.js';
import { naiveRepository } from './support/naive-repository.js';
import { atomicRepository } from '../src/repository.js';
import { stormAuction, auditLedger } from './support/harness.js';

let pool;
before(() => { pool = createPool({ max: 100 }); });
after(() => pool.end());

test('the harness catches a read-then-write handler losing bids under load', async () => {
  // The race is probabilistic, so give it up to three auctions to show itself.
  // In practice one is enough; the loop is here so a submission never hinges on
  // a coin flip.
  let found = null;
  for (let round = 1; round <= 3 && !found; round++) {
    const auction = await createAuction(pool);
    const storm = await stormAuction(naiveRepository(pool), auction.id, { count: 200 });
    const audit = await auditLedger(pool, auction.id, storm);
    if (audit.violations.length > 0) found = { round, storm, audit };
  }

  // This test passes by confirming the race HAPPENS. It is the evidence that
  // the harness can detect the failure it is later used to rule out.
  //
  // Note what counts: constraint errors from the database are collected
  // separately as writeErrors. A violation is always something the audit found
  // sitting on disk afterwards — real corruption, not the schema complaining.
  assert.ok(
    found,
    'three 200-way storms against a read-then-write handler left a clean ledger — ' +
      'the harness is not applying enough concurrency to be evidence of anything',
  );

  const { storm, audit } = found;
  console.log(
    `  naive control: ${storm.accepted.length} told they led, ${audit.acceptedOnDisk} on disk, ` +
      `${storm.writeErrors.length} rejected by the unique index, ` +
      `${audit.violations.length} invariant violations`,
  );
  for (const v of audit.violations.slice(0, 3)) console.log(`    - ${v}`);
});

test('the atomic repository holds the invariant under the same load', async () => {
  const auction = await createAuction(pool);

  const storm = await stormAuction(atomicRepository(pool), auction.id, { count: 200 });
  const audit = await auditLedger(pool, auction.id, storm);

  assert.deepEqual(audit.violations, [], 'ledger violated its own invariants');
  assert.equal(storm.writeErrors.length, 0, 'no bid should error');

  // Every bid the client was told it led with must be on disk, in order.
  assert.equal(storm.accepted.length, audit.acceptedOnDisk);
  assert.ok(storm.accepted.length > 1, 'the run must actually contend, not serialise into one winner');

  // The highest bid fired always wins: it beats whatever preceded it whenever
  // it lands, so a correct implementation can never refuse it.
  const highestFired = Math.max(...storm.results.map((r) => r.amountCents));
  assert.equal(audit.finalTop, highestFired);

  console.log(`  atomic: ${audit.acceptedOnDisk} accepted of 200, finished at ${audit.finalTop}, 0 violations`);
});
