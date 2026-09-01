# Auctions — bidding service

A `POST /bid` endpoint for an auction platform, built around one invariant:

> At every instant an auction has exactly one top bid, and the sequence of top
> bids for that auction is strictly increasing.

Everything else here follows from defending that under concurrency.

## Running it

Requires Node 22+ and Docker.

```bash
npm install
npm run db:up        # postgres 16 in a container on :55432
npm run db:migrate
npm start            # listens on :3000
npm run seed         # creates an auction, prints runnable curl commands
```

`npm run seed` is there because the brief only asks for `POST /bid`, so there is
no endpoint that creates an auction. It prints seven ready-to-paste requests that
walk the whole design — an accepted bid, the same request retried and replayed, a
refusal, a self-raise, a key conflict, and a rejected fractional amount.

```bash
npm test             # the whole suite, ~65 tests
npm run db:reset     # tear down, recreate, re-migrate
```

The unit tests (`test/resolver.test.js`, `test/bid-request.test.js`) need no
database. The rest do.

## The API

```
POST /bid
Idempotency-Key: any-string        # optional, see below

{
  "auction_id": "uuid",
  "user_id":    "uuid",
  "amount":     15000              # integer minor units, never a float
}
```

**The body is exactly what the brief specifies** — `auction_id`, `user_id`, `amount`
and nothing else. That request works as written.

**The retry key is an optional `Idempotency-Key` header**, following
[draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07)
and Stripe's convention. It belongs in a header rather than the payload because it
describes how to treat the *delivery* of this request, not what is being bid — the
same reason idempotency is resolved before any bid rule runs. Sending it in the body
is refused with a `400` rather than ignored, so a caller never believes they hold a
guarantee they do not. The draft types the value as a quoted structured string while
everyone sends it bare, so `"k1"` and `k1` are normalised to the same key.

**With no header at all**, the request's own fingerprint becomes the key, so an
identical resend still replays instead of being re-judged. That fallback is
deliberately weaker, and the gap is the argument for the header: without a key a
*deliberate* resend of the same amount is byte-identical to a network retry, so it
replays too — a stale answer where a fresh refusal was correct. Nothing closes that
except the client saying which it meant.

| Status | When |
|---|---|
| `201` | Bid accepted — there is a new top bid |
| `200` | Bid processed and refused — reason in `outcome` |
| `400` | Malformed request (bad UUID, bad amount, bad JSON) |
| `404` | No such auction |
| `409` | Idempotency key reused for a different bid |
| `413` | Body over the size limit |
| `500` | Unhandled server error — logged server-side, never leaks internals |

Status codes carry transport semantics only. A refused bid is a request that was
processed successfully and answered "no", so it is a `200` with the reason in the
body — a caller should never have to infer what happened to its bid from the
status line.

```jsonc
// 201
{ "seq": 1, "outcome": "ACCEPTED_LEADING", "currentTopCents": 50000, "replayed": false }
// 200
{ "seq": null, "outcome": "REJECTED_NOT_HIGHER", "currentTopCents": 50000, "replayed": false }
```

Outcomes: `ACCEPTED_LEADING`, `ACCEPTED_SELF_RAISE`, `REJECTED_NOT_HIGHER`,
`REJECTED_BELOW_INCREMENT`, `REJECTED_AUCTION_CLOSED`.

### Seven requests that exercise the whole design

`npm run seed` prints these against a real auction id. Verbatim output:

```
1  Alice bids 500.00      {"seq":1,"outcome":"ACCEPTED_LEADING","currentTopCents":50000,"replayed":false}    201
2  the same request again {"seq":1,"outcome":"ACCEPTED_LEADING","currentTopCents":50000,"replayed":true}     201
3  Bob bids 400.00        {"seq":null,"outcome":"REJECTED_NOT_HIGHER","currentTopCents":50000}               200
4  Bob bids 600.00        {"seq":2,"outcome":"ACCEPTED_LEADING","currentTopCents":60000}                     201
5  Bob raises himself     {"seq":3,"outcome":"ACCEPTED_SELF_RAISE","currentTopCents":70000}                  201
6  same key, new amount   {"error":"idempotency_key_reused"}                                                 409
7  amount 1.5             {"error":"invalid_amount"}                                                         400
```

Request 2 is the one worth looking at: it carries no idempotency key, is
byte-identical to request 1, and comes back as a replay of the original decision
rather than a fresh judgement.

### Postman

`postman/auctions.postman_collection.json` runs one auction start to finish — 26
requests over 8 folders, every one asserting its own outcome, so a green run is an
acceptance suite rather than a set of requests that merely returned something.

```bash
npm run db:up && npm run db:migrate
npm start                  # in another shell
npm run postman:env        # seeds a fresh auction, writes the environment file
```

Import the collection and `postman/auctions.postman_environment.json`, select the
`auctions — local` environment, and Run. Headless:

```bash
newman run postman/auctions.postman_collection.json \
  -e postman/auctions.postman_environment.json
```

**Re-run `npm run postman:env` before every run.** The collection asserts exact
sequence numbers and prices, so it needs an auction nobody has bid on. The first
request checks precisely that and fails by name if you forget. It carries a
throwaway `{{$guid}}` key for a reason worth knowing: without one, the fingerprint
fallback would replay the previous run's answer and cheerfully report a fresh
auction on a dirty one — the guard would be defeated by the mechanism it sits
beside.

The environment file is generated and gitignored; its ids point at rows in
whichever database wrote it.

---

## Data model, and why

Two tables. `auctions` carries current state; `bids` carries history.

```
auctions   id, status, ends_at, currency, reserve_cents, min_increment_cents,
           seq, top_amount_cents, top_user_id, top_bid_at, previous_top_user_id,
           max_cents, proxy_enabled, created_at

bids       id, auction_id, seq, user_id, amount_cents, outcome,
           idem_key, request_hash, response_body, created_at
```

Three columns are deliberately carried but unread: `reserve_cents`, `max_cents` and
`proxy_enabled`. The reserve gates whether a lot *sells*, which is settlement and out
of scope here — it is not a bid rule, and treating it as one would break the
self-raise reasoning below. The other two reserve the shape of proxy bidding so
enabling it is a feature flag rather than a migration. They are listed here so their
absence from the logic reads as a decision rather than an oversight.

The migrations are append-only; `002` and `003` exist because the design changed
during the build rather than being edited into `001` after the fact.

**The auction row carries denormalised current-top state and its own sequence
counter so that accepting a bid is a single atomic conditional update on one row
rather than an aggregate over the bid table; `bids` is an append-only ledger of
every attempt, so nothing is lost when a bid is superseded and every refusal
stays explainable months later.**

Two details are load-bearing rather than incidental:

- **`seq` is a column, not a Postgres `SEQUENCE`.** `nextval` allocates outside
  the row lock, so sequence order could diverge from commit order — which is
  exactly the ordering the counter exists to guarantee.
- **The idempotency key is unique per `(auction, user, key)`, not globally.** A
  global key table would let a guessed or collided key replay another user's
  stored response, leaking their position and price.

### How a bid is accepted

The decision and the state change are one statement. There is no read-then-compare:

```sql
WITH claim AS (
  UPDATE auctions
     SET seq = seq + 1, previous_top_user_id = top_user_id,
         top_amount_cents = $3, top_user_id = $2, top_bid_at = clock_timestamp()
   WHERE id = $1
     AND status = 'OPEN'
     AND clock_timestamp() < ends_at              -- close gate
     AND $3 >  top_amount_cents                   -- strictly higher
     AND $3 >= top_amount_cents + min_increment_cents
  RETURNING seq, previous_top_user_id
)
-- LEFT JOIN claim ON true yields one row either way, so accept and refuse are
-- the same round trip and every attempt reaches the ledger.
```

A single auction's top-bid sequence is **inherently serial**. "Strictly higher
than the current top" *is* a total order, and a total order cannot be
partitioned — sharding the auction row would trade away the invariant being
defended. The available moves are to keep the critical section short, shed load
ahead of it, or funnel one auction's bids to one writer.

---

## The auction-close boundary

**A bid is accepted if and only if the database's clock, read inside the same
statement that performs the write, is strictly less than `ends_at`.** A bid
landing exactly at `ends_at` is late. The boundary is exclusive, and that is a
stated choice rather than an accident of `<` versus `<=`.

The reasoning matters more than the rule. Across several API servers "the exact
moment" is not a well-defined instant — NTP skew of tens of milliseconds is
ordinary, so two bids arriving at the "same" moment would be judged by two
different clocks. Naming *one* clock, and reading it while holding the row lock,
replaces a race between wall clocks with a single serialisation point.

`clock_timestamp()`, not `now()`: `now()` is the transaction's start time, read
before the lock was acquired, which would reintroduce the very race the statement
exists to close.

**Who closes the auction.** The time predicate is the source of truth. `CLOSED`
status is *derived and eventual* — set by a timer or lazily on the first request
after `ends_at`. Correctness never depends on the closer being punctual, because
the clock predicate refuses late bids whether or not the flag has flipped.
`test/close-boundary.test.js` asserts exactly this: an auction past its deadline
refuses bids while still reading `OPEN`.

---

## Duplicate and retried requests

The failure here is subtler than it first looks, and naming it correctly is most
of the answer. A client bids 110, times out, retries 110. The first attempt
already won, so the retry is not strictly higher and is refused — and the bidder
is told they lost an auction they are currently winning. **The stored state is
correct; the answer is a lie.** The bug is a wrong response, not corrupted data.

The unique index on `(auction_id, user_id, idem_key)` is the arbiter — not a
lookup before the write. Checking for an existing attempt first would be the same
read-then-write race this service exists to avoid: two concurrent retries would
both find nothing. The insert is attempted, and a unique violation means the key
is spent, at which point the stored response is returned verbatim.

- **Same key, same request** → the original response, replayed exactly.
- **Same key, different amount** → `409`, no state change.
- **No `Idempotency-Key` header** → the request fingerprint becomes the key, so a
  retry still replays. A deliberate resend of the same amount replays too, which is
  wrong but unfixable without the client distinguishing the two.
- **Key sent in the body** → `400` naming the header. Ignoring it would leave the
  caller believing they chose a guarantee they did not get.
- `response_body` is built *inside* the accepting statement from the state at the
  moment of the decision, so a replay answers with the price as it stood then
  rather than re-deriving it against a world that has moved on.

**`ON CONFLICT DO NOTHING` would have been wrong here, and quietly so.** The
`UPDATE` lives in a CTE that runs before the insert, and `DO NOTHING` does not
fail the statement — so the auction would keep the bid while the ledger dropped
it. Letting the violation raise is what rolls the `UPDATE` back with it. There is
a test for that specifically, because it is a property of statement atomicity
rather than anything visible in the code.

Idempotency resolves **before** any bid-validity rule. It is a transport concern,
not an auction concern, and getting that ordering wrong is what produces the
lying response above.

---

## A user bidding on their own top bid

**Accepted, and recorded under its own outcome, `ACCEPTED_SELF_RAISE`.**

The intuitive answer is to refuse. In a first-price English auction the top bid
*is* the price paid, so raising yourself looks like pure value destruction. I held
that position until it broke on a case worth stating:

> **Below the reserve, a self-raise is the only path to a sale.** Reserve
> 100,000, my own top bid 80,000, no other bidders — raising myself to 100,000 is
> rational, seller-positive, and the only way the lot sells at all. The "value
> destruction" argument silently assumes the top bid is already the clearing
> price. Below reserve it is not.

A blanket refusal hard-codes a product judgment into the ledger and blocks a
legitimate, revenue-generating action. Three supporting reasons:

- **Refusal destroys the support story.** To an angry customer a *refused*
  self-bid and a *lost* self-bid are indistinguishable. Accepting and typing it
  means the answer is always "you raised yourself at 21:04, here is the record."
- **It keeps the rule surface minimal.** The only rule stays "strictly higher".
  Special cases are where concurrency bugs live.
- **The policy stays reversible.** Every attempt is a typed ledger row, so this
  can be flipped later with no migration and no gap in history.

**The risk I am accepting:** this permits price-pumping — a top bidder
self-raising in the final seconds to walk rivals into their ceilings. On a
fine-art platform shill bidding is the endemic fraud, so this is a real cost, not
a theoretical one. I accept it because **shill defence is a detection and
identity problem, not a pricing gate**, and typed self-raise events are precisely
what a detector needs as input.

---

## What I would change about this brief

**1. It contradicts itself.** It requires handling duplicate and retried bids and
defines a request body with nowhere to carry an idempotency key. Both cannot
hold. With only `(auction_id, user_id, amount)` there is no way to distinguish a
network retry from a deliberate second submission of the same figure — they are
byte-identical.

Deduplicating on that triple alone is *almost* sound: once a user's 110 wins, no
later 110 can ever be strictly higher, so the triple can only succeed once. But it
conflates a retry with an intentional re-send and returns stale responses.

Rather than argue this in prose, the code does both. **The brief's exact three-field
body works and is retry-safe**, deduplicating on the request fingerprint. Send an
`Idempotency-Key` header and you get the stronger guarantee. The difference is the
whole point: with the fallback, a bidder who deliberately re-sends 110 after being
outbid gets their old "accepted" response replayed instead of a refusal, because
those two requests are byte-identical. Only the client knows which it meant.

**Change: specify an `Idempotency-Key` request header.** Note this needs no change
to the body the brief defines — the gap is not in the payload, it is that the brief
specifies a payload and says nothing about the protocol. The key is delivery
metadata, not bid data, which is why it goes in a header and why
[the IETF draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07)
puts it there.

**2. `user_id` in the request body is an authorization hole.** In production the
bidder's identity must come from the authenticated principal, never a
client-supplied field, or anyone can bid as anyone. Skipping auth is reasonable
for a scoped exercise — but the *contract shape* bakes the vulnerability in
permanently, and contracts outlive exercises. `user_id` should be derived from
the session; the field should not exist.

**3. `amount` has no specified type.** This implementation takes integer minor
units and rejects anything that is not a safe integer, which catches fractions,
values past 2^53 where JSON numbers stop being exact, and `1e999` (which
`JSON.parse` turns into `Infinity`). A production contract would carry the amount
as a *string* and parse it as a decimal, never trusting a JSON number with money.

---

## How the concurrency claim is proven

A green test suite that was never shown to detect the failure it rules out proves
nothing. So each claim here has a control:

| Claim | How it is falsified |
|---|---|
| The harness detects lost updates | `test/support/naive-repository.js` is a read-then-write control. 200 concurrent bids against it corrupt the ledger every run — including a lower bid holding a higher sequence number than a higher one, the exact case the brief rules out. The test passes by confirming that it breaks. |
| The atomic statement holds | The same 200-bid storm, zero violations, and the highest bid fired always wins. |
| The resolver and the SQL agree | The bid rules exist twice — a JS ladder and a SQL `CASE`. `test/conformance.test.js` drives one decision table through both. Changing the SQL increment predicate from `>=` to `>` fails two of its ten cases. |
| The close gate works under load | A 300-bid storm across an auction that ends mid-run. Removing the close predicate fails the test. |

The control stays in the suite permanently. If the real repository is ever
collapsed back into read-then-write, it still fails.

```
test/resolver.test.js        the decision table, no database
test/bid-request.test.js     request and money validation
test/conformance.test.js     resolver and SQL agree
test/concurrency.test.js     the race, and its absence
test/close-boundary.test.js  a deadline passing mid-storm
test/idempotency.test.js     retries, replays and conflicts
test/http.test.js            the endpoint end to end
```

---

## Alternatives considered and rejected

| Rejected | Why, here |
|---|---|
| **Proxy / ceiling bidding** — treat `amount` as a maximum and derive the price from the second-highest | Mechanically the best model, and how absentee bidding actually works at an auction house. It collapses retries, self-raises and the price rule into one mechanism. But it redefines what `amount` means on every bid, and the brief says "strictly higher than the current top bid" — shipping it silently would answer a different question. `max_cents` and `proxy_enabled` are reserved so this is a feature flag later, not a migration. |
| **Larger minimum increment for self-raises** | A tax, not a control. A determined shill pays it; a legitimate bidder is penalised for nothing; and the unusual jump leaks in the price ladder that the top bidder raised themselves. |
| **`SELECT … FOR UPDATE`** | Correct, but holds a lock across application logic. Ten thousand connections that open a transaction, take the lock and stall will exhaust the pool. A conditional update holds the row only for the arithmetic. |
| **Event sourcing as the primary read path** | Folding thousands of bids on every read contradicts the stated load. It belongs as a *verification* path — a reconciler replaying the ledger and alerting on divergence — not as the query. |
| **CRDTs / coordination-free merge at settlement** | Cannot enforce "strictly higher than the current top" without coordination. It answers a different question. |
| **Sealed-bid commit-reveal** | Removes concurrency as a category, and changes the auction type. This is no longer an English auction. |
| **Sharding the auction row** | The invariant *is* a total order. Partitioning it discards the thing being defended. |
| **Anti-snipe soft close** | Correct for a real auction house and cheap to add — one more assignment in a `SET` clause that already holds the lock. Left out because it changes the advertised end time, which is a product decision. First thing I would add. |

---

## Deliberately out of scope

Named so that absence reads as a decision rather than an oversight.

- **Funds and settlement.** A bid with nothing behind it is not a bid. An accepted
  bid should place a margin hold against a registered credit line, making
  "accepted" mean *collateralised* rather than merely *matched*. On high-value art,
  winner default is the real risk.
- **A reconciler** replaying each auction's ledger and alerting on divergence from
  the live row — catching a race at 4pm on a test auction rather than 3am on a
  Basquiat.
- **Shill detection**, fed by the typed self-raise events above.
- **Outbid notifications**, the other half of a real auction product.
- Authentication, rate limiting and deployment, per the brief.
