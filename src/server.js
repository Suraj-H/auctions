import { createApp } from './app.js';
import { createPool, CONNECTION_STRING } from './db.js';
import { atomicRepository } from './repository.js';

const port = Number(process.env.PORT ?? 3000);
const pool = createPool();
const server = createApp({ repository: atomicRepository(pool) }).listen(port, () => {
  console.log(`auctions listening on :${port}`);
  console.log(`database ${CONNECTION_STRING.replace(/:[^:@]*@/, ':***@')}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))));
}
