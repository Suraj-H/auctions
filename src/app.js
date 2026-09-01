import express from 'express';
import { parseBidRequest } from './bid-request.js';
import { AuctionNotFoundError, IdempotencyConflictError } from './repository.js';
import { isAccepted } from './resolver.js';

/**
 * The endpoint is a thin adapter. The decision lives in one SQL statement and
 * the request rules live in parseBidRequest; what is left here is choosing a
 * status code and shaping the body.
 *
 * Status codes carry transport semantics only. A refused bid is a request that
 * was processed successfully and answered "no", so it is a 200 with the reason
 * in the body — not a 4xx. The client should never have to infer what happened
 * to its bid from the status line.
 */
export function createApp({ repository }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));

  app.post('/bid', async (req, res) => {
    const parsed = parseBidRequest(req.body, req.get('Idempotency-Key'));
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error, message: parsed.message });
    }

    try {
      const result = await repository.placeBid(parsed.value);
      return res.status(isAccepted(result.outcome) ? 201 : 200).json(result);
    } catch (error) {
      return respondToFault(res, error);
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // express.json() rejects a malformed body before any route runs, so this is
  // the only place that failure can be turned into JSON instead of an HTML 400.
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    respondToFault(res, error);
  });

  return app;
}

/**
 * One table rather than parallel status/body ladders: adding a fault means
 * adding a row, not remembering to edit two switches in the same order.
 */
const CLIENT_FAULTS = [
  {
    match: (e) => e instanceof AuctionNotFoundError,
    status: 404, error: 'auction_not_found', message: 'no auction with that id',
  },
  {
    match: (e) => e instanceof IdempotencyConflictError,
    status: 409, error: 'idempotency_key_reused',
    message: 'that key was already used for a different bid',
  },
  {
    match: (e) => e instanceof SyntaxError && 'body' in e,
    status: 400, error: 'invalid_json', message: 'request body is not valid JSON',
  },
  {
    match: (e) => e?.type === 'entity.too.large',
    status: 413, error: 'body_too_large', message: 'request body exceeds the size limit',
  },
];

function respondToFault(res, error) {
  const fault = CLIENT_FAULTS.find((f) => f.match(error));
  if (fault) {
    return res.status(fault.status).json({ error: fault.error, message: fault.message });
  }
  // Anything unrecognised is our bug, not the caller's. Say so where an
  // operator will see it; a 500 nobody logged is the failure found weeks later.
  console.error('unhandled error serving POST /bid:', error);
  return res.status(500).json({ error: 'internal_error' });
}
