-- Auctions and bids.
--
-- The auction row carries denormalised current-top state so that accepting a
-- bid is a single conditional UPDATE on one row, rather than an aggregate over
-- the bid table. bids is an append-only ledger of every attempt, accepted or
-- refused, so nothing is lost when a bid is superseded and every refusal stays
-- explainable long after the fact.
--
-- "_cents" means integer minor units of the row's currency. Never a float.

CREATE TYPE auction_status AS ENUM ('OPEN', 'CLOSED');

CREATE TYPE bid_outcome AS ENUM (
  'ACCEPTED_LEADING',
  'ACCEPTED_SELF_RAISE',
  'REPLAYED',
  'REJECTED_NOT_HIGHER',
  'REJECTED_BELOW_INCREMENT',
  'REJECTED_AUCTION_CLOSED',
  'CONFLICT_KEY_REUSED'
);

CREATE TABLE auctions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status              auction_status NOT NULL DEFAULT 'OPEN',
  ends_at             timestamptz NOT NULL,
  currency            char(3) NOT NULL DEFAULT 'INR',
  reserve_cents       bigint NOT NULL DEFAULT 0,
  min_increment_cents bigint NOT NULL DEFAULT 100,

  -- Monotonic per auction. Deliberately a column and not a Postgres SEQUENCE:
  -- nextval allocates outside the row lock, which would let sequence order
  -- diverge from commit order and destroy the ordering this exists to provide.
  seq                 bigint NOT NULL DEFAULT 0,

  top_amount_cents    bigint NOT NULL DEFAULT 0,
  top_user_id         uuid,
  top_bid_at          timestamptz,

  -- Reserved for proxy/absentee bidding, deliberately unimplemented. Present so
  -- that enabling it later is a feature flag rather than a migration.
  max_cents           bigint,
  proxy_enabled       boolean NOT NULL DEFAULT false,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reserve_non_negative   CHECK (reserve_cents >= 0),
  CONSTRAINT increment_positive     CHECK (min_increment_cents > 0),
  CONSTRAINT top_amount_non_negative CHECK (top_amount_cents >= 0),
  -- A top bid exists, or it does not. Never half of one.
  CONSTRAINT top_bid_is_whole CHECK (
    (top_user_id IS NULL AND top_bid_at IS NULL AND top_amount_cents = 0)
    OR (top_user_id IS NOT NULL AND top_bid_at IS NOT NULL AND top_amount_cents > 0)
  )
);

CREATE TABLE bids (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id   uuid NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,

  -- Populated only when the bid was accepted. A refused attempt is still a row.
  seq          bigint,

  user_id      uuid NOT NULL,
  amount_cents bigint NOT NULL,
  outcome      bid_outcome NOT NULL,

  idem_key     text NOT NULL,
  request_hash bytea NOT NULL,
  response_body jsonb,

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT amount_positive CHECK (amount_cents > 0)
);

-- Retry dedup, scoped per user. A global key table would let a guessed or
-- collided key replay another user's stored response, leaking their position.
CREATE UNIQUE INDEX bids_idempotency ON bids (auction_id, user_id, idem_key);

-- Ordering integrity: one accepted bid per sequence number per auction.
CREATE UNIQUE INDEX bids_sequence ON bids (auction_id, seq) WHERE seq IS NOT NULL;

CREATE INDEX bids_history ON bids (auction_id, created_at DESC);

CREATE INDEX auctions_open_by_end ON auctions (ends_at) WHERE status = 'OPEN';
