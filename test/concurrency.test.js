import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db.js';
import { createAuction } from './support/db.js';
import { naiveRepository } from './support/naive-repository.js';
import { stormAuction, auditLedger } from './support/harness.js';

let pool;
before(() => { pool = createPool({ max: 100 }); });
after(() => pool.end());

const LOST_UPDATE = /told .* but the auction finished at/;

test('the harness catches a read-then-write handler losing bids under load', async () => {
  const auction = await createAuction(pool);

  const storm = await stormAuction(naiveRepository(pool), auction.id, { count: 200 });
  const audit = await auditLedger(pool, auction.id, storm);

  // This test passes by confirming the race HAPPENS. It is the evidence that
  // the harness can detect the failure it is later used to rule out.
  assert.ok(
    audit.violations.length > 0,
    'expected the naive handler to violate the invariant, but the ledger was clean — ' +
      'the harness is not applying enough concurrency to be evidence of anything',
  );

  // Constraint violations alone would not prove much: the unique index would be
  // doing the catching, not the harness. Insist on at least one lost update —
  // a bidder told they were leading at a price the auction never reached.
  assert.ok(
    audit.violations.some((v) => LOST_UPDATE.test(v)),
    `expected at least one lost update, got only: ${audit.violations.join('; ')}`,
  );

  console.log(
    `  naive control: ${storm.accepted.length} told they led, ${audit.acceptedOnDisk} on disk, ` +
      `${storm.writeErrors.length} rejected by the unique index, ` +
      `${audit.violations.length} invariant violations`,
  );
  for (const v of audit.violations.slice(0, 3)) console.log(`    - ${v}`);
});
