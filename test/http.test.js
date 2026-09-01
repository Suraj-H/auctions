import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { atomicRepository } from '../src/repository.js';
import { createApp } from '../src/app.js';
import { createAuction, newUserId } from './support/db.js';

let pool, server, baseUrl;

before(async () => {
  pool = createPool({ max: 10 });
  server = createApp({ repository: atomicRepository(pool) }).listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const postBid = (body, raw = false) =>
  fetch(`${baseUrl}/bid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });

const bidBody = (auctionId, over = {}) => ({
  auction_id: auctionId,
  user_id: newUserId(),
  amount: 15000,
  idempotency_key: randomUUID(),
  ...over,
});

test('an accepted bid answers 201 with the outcome in the body', async () => {
  const auction = await createAuction(pool);
  const response = await postBid(bidBody(auction.id));

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.outcome, 'ACCEPTED_LEADING');
  assert.equal(body.currentTopCents, 15000);
  assert.equal(body.replayed, false);
  assert.equal(typeof body.seq, 'number');
});

test('a refused bid answers 200 — it was processed, not rejected as a request', async () => {
  const auction = await createAuction(pool);
  await postBid(bidBody(auction.id, { amount: 50000 }));

  const response = await postBid(bidBody(auction.id, { amount: 20000 }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).outcome, 'REJECTED_NOT_HIGHER');
});

test('a retried bid answers with the original result, marked as a replay', async () => {
  const auction = await createAuction(pool);
  const body = bidBody(auction.id);

  const first = await (await postBid(body)).json();
  const response = await postBid(body);
  const retry = await response.json();

  assert.equal(response.status, 201, 'a replay keeps the status of the original');
  assert.equal(retry.replayed, true);
  assert.deepEqual({ ...retry, replayed: false }, first);
});

test('the same key with a different amount answers 409', async () => {
  const auction = await createAuction(pool);
  const body = bidBody(auction.id);
  await postBid(body);

  const response = await postBid({ ...body, amount: 999999 });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'idempotency_key_reused');
});

test('a bid on an auction that does not exist answers 404', async () => {
  const response = await postBid(bidBody(randomUUID()));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'auction_not_found');
});

test('a fractional amount answers 400 without reaching the database', async () => {
  const response = await postBid(bidBody(randomUUID(), { amount: 1.5 }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_amount');
});

test('an amount in exponent notation answers 400', async () => {
  const auction = await createAuction(pool);
  const response = await postBid(
    `{"auction_id":"${auction.id}","user_id":"${newUserId()}","amount":1e999,"idempotency_key":"k"}`,
    true,
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_amount');
});

test('a malformed JSON body answers 400 rather than 500', async () => {
  const response = await postBid('{"amount":', true);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_json');
});

test('an unknown route answers 404 as JSON, not HTML', async () => {
  const response = await fetch(`${baseUrl}/nope`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-type')?.split(';')[0], 'application/json');
});

test('a body over the size limit answers 413, not 500', async () => {
  const response = await postBid(bidBody(randomUUID(), { note: 'x'.repeat(8000) }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, 'body_too_large');
});
