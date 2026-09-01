import { Pool } from 'pg';

export const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgres://auctions:auctions@localhost:55432/auctions';

export function createPool(options = {}) {
  return new Pool({
    connectionString: CONNECTION_STRING,
    // A bid is one statement. Anything holding a connection longer than this is
    // stuck, and waiting on it costs more than failing the request.
    statement_timeout: 5000,
    ...options,
  });
}
