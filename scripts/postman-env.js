import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db.js';

/**
 * Seeds the state the Postman collection runs against, and writes the matching
 * environment file.
 *
 * Run this before every collection run. The collection asserts exact sequence
 * numbers and prices, so it needs an auction that no one has bid on yet — and
 * fresh bidder ids, or the self-raise scenario would depend on who bid last time.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pool = createPool({ max: 1 });

try {
  const open = await pool.query(
    `INSERT INTO auctions (ends_at, min_increment_cents, reserve_cents)
     VALUES (now() + interval '1 hour', 100, 50000) RETURNING id`,
  );
  // Deadline already past, status still OPEN: the clock predicate is the gate,
  // the status flag is derived and eventual. Bids here must still be refused.
  const closed = await pool.query(
    `INSERT INTO auctions (ends_at, min_increment_cents)
     VALUES (now() - interval '1 minute', 100) RETURNING id`,
  );

  const values = {
    // 127.0.0.1 rather than localhost: under Node 22 the newman CLI fails to
    // resolve localhost and reports "Invalid IP address: undefined". The Postman
    // GUI is fine with either, so the literal address works everywhere.
    baseUrl: process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`,
    auctionId: open.rows[0].id,
    closedAuctionId: closed.rows[0].id,
    missingAuctionId: randomUUID(),
    alice: randomUUID(),
    bob: randomUUID(),
    carol: randomUUID(),
    retryKey: `retry-${randomUUID()}`,
  };

  const environment = {
    id: randomUUID(),
    name: 'auctions — local',
    values: Object.entries(values).map(([key, value]) => ({
      key, value, type: 'default', enabled: true,
    })),
    _postman_variable_scope: 'environment',
  };

  await mkdir(join(root, 'postman'), { recursive: true });
  await writeFile(
    join(root, 'postman', 'auctions.postman_environment.json'),
    JSON.stringify(environment, null, 2) + '\n',
  );

  console.log('wrote postman/auctions.postman_environment.json');
  for (const [k, v] of Object.entries(values)) console.log(`  ${k.padEnd(17)} ${v}`);
} finally {
  await pool.end();
}
