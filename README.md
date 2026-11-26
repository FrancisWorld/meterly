# Meterly

[Português (Brasil)](README.pt-BR.md)

[![ci](https://github.com/FrancisWorld/meterly/actions/workflows/ci.yml/badge.svg)](https://github.com/FrancisWorld/meterly/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A usage-based billing engine on Bun, Hono and PostgreSQL: idempotent high-volume ingestion, late-event watermark, exact tiered/volume/package pricing, invoices with credits and proration, and Stripe sync through a transactional outbox.**

## Why it exists / what is hard about it

Metered billing looks like "sum the events, multiply by a price". The parts that bite in practice:

- **Events are retried, duplicated and late.** Ingestion must be idempotent per key, must notice a key reused with a *different* payload, and must decide what happens to an event that belongs to a period that is already invoiced.
- **Money must be exact.** Quantities exceed 2^53, unit prices are fractions of a cent (`0.0004`), and tiers have flat fees. Everything here is `bigint` on fixed-point decimals with exactly one rounding step per line.
- **Closing a period races with ingestion.** An event must land either in the invoice or in the next period, never both and never nowhere.
- **Talking to a payment provider is a distributed-systems problem.** A timeout after Stripe already created the invoice must not create a second one; an invoice event can arrive before we even know the Stripe id, or out of order.

Stripe sits behind a `StripeGateway` interface. This repository ships a deterministic in-memory fake and **no real Stripe client**; nothing here ever calls Stripe. Webhook signatures are generated locally in tests with the same scheme Stripe documents (`t=...,v1=HMAC-SHA256`).

## Architecture

```mermaid
flowchart LR
  client([API client]) -->|Bearer key| api[Hono API]
  api --> ing[Ingestion]
  api --> inv[Invoicing]
  api --> cat[Catalog / credits / subscriptions]
  ing -->|batch INSERT ... ON CONFLICT| pg[(PostgreSQL)]
  inv -->|FOR UPDATE customer, one txn| pg
  cat --> pg
  inv -->|same txn| ob[(outbox)]
  pg --- ob
  ob -->|"lease: FOR UPDATE SKIP LOCKED"| worker[Outbox worker]
  worker -->|idempotency key| gw{{StripeGateway}}
  gw --> fake[FakeStripe]
  stripe([Stripe events]) -->|"Stripe-Signature"| wh[Webhook receiver]
  wh -->|verify, dedupe, order by created| pg
  worker -->|link stripe id, replay parked events| pg
```

```
src/domain      pure, no I/O: pricing, proration, periods, invoice math, event ordering
src/services    one module per responsibility, all SQL lives here
src/stripe      gateway interface, deterministic fake, signature verification
src/worker      outbox worker (lease, backoff, dead-letter)
src/http        Hono app: auth, validation (zod), routes, views
migrations      plain SQL, applied by an advisory-locked runner
```

## Quickstart

Everything below was run on an Apple Silicon laptop (8 GB) with Docker (Colima).

```bash
export STRIPE_WEBHOOK_SECRET=$(openssl rand -hex 32)   # required: the server refuses to start without a strong secret
docker compose up -d --build                    # PostgreSQL + the API on :3000
docker compose exec app bun src/cli/create-tenant.ts acme   # prints a tenant id and an API key (shown once)

# in a checkout with bun installed:
bun install
export API_KEY=mtk_...                          # from the previous command
# STRIPE_WEBHOOK_SECRET is still exported from the first step: the demo signs webhooks with it
scripts/demo.sh                                 # catalog -> ingest -> preview -> finalize -> Stripe push -> webhook
docker compose down -v
```

Real output of `scripts/demo.sh` (trimmed):

```text
# ingest (twice: the replay must be all duplicates)
{"accepted":5,"duplicate":0,"rejected":0,"conflict":0}
{"accepted":0,"duplicate":5,"rejected":0,"conflict":0}
# invoice preview
  lines: Base fee 4900 | active_users (unique) qty 2 -> 1500 | api_calls (sum) qty 12000 -> 4900
  "subtotal": "11300", "amount_due": "11300"
# finalize
{ "number": "1", "status": "open", "amount_due": "11300", "stripe_invoice_id": null }
stripe invoice: in_fake_3402ad38e4a0f191            # the outbox worker pushed it
# signed webhook: invoice.paid
{"received":true,"outcome":"applied"}
{"received":true,"outcome":"duplicate"}
{"error":{"code":"invalid_signature","message":"webhook signature verification failed","details":{"reason":"no_matching_signature"}}}
{ "number": "1", "status": "paid", "amount_due": "11300", "stripe_invoice_id": "in_fake_3402ad38e4a0f191" }
```

The 12 000 calls priced `graduated` as 1 000 free + 9 000 x 0.5 + 2 000 x 0.2 = 4 900.

### API

All `/v1` routes need `Authorization: Bearer <key>`; the tenant is derived from the key (only its SHA-256 is stored). Quantities and amounts are returned as decimal **strings** so no client loses precision; inputs accept safe integers or strings. Errors are always `{"error":{"code","message","details?"}}`.

| Route | Purpose |
| --- | --- |
| `POST /v1/meters`, `GET /v1/meters` | `sum`, `max`, or `unique` (distinct values of an event property) |
| `POST /v1/plans`, `GET /v1/plans/:id` | currency, base fee, one pricing per meter: `graduated`, `volume`, `package` |
| `POST /v1/customers`, `GET /v1/customers/:id` | creating a customer enqueues a Stripe customer sync |
| `POST /v1/customers/:id/credits`, `GET .../credits` | credit grants (optional idempotency key) and the ledger |
| `POST /v1/subscriptions`, `POST .../:id/change-plan` | monthly subscription; plan change queues a proration adjustment |
| `POST /v1/events` | batch of up to 1000 events, per-event status |
| `GET /v1/usage` | aggregate over `[from, to)`, optionally bucketed by `hour`/`day`/`month` (UTC) |
| `GET /v1/subscriptions/:id/invoice-preview` | the invoice as it stands now, writes nothing |
| `POST /v1/subscriptions/:id/invoices` | finalize a ended period; pass `period_start` to make retries return the same invoice |
| `GET /v1/invoices/:id` | invoice with per-tier breakdown |
| `POST /webhooks/stripe` | signature-authenticated Stripe events |
| `GET /healthz`, `GET /readyz` | liveness, readiness (checks the database) |

Pricing in a plan item:

```json
{ "model": "graduated", "tiers": [
  { "up_to": 1000,  "unit_amount": "0" },
  { "up_to": 10000, "unit_amount": "0.5" },
  { "up_to": null,  "unit_amount": "0.2", "flat_amount": 0 } ] }
{ "model": "package", "package_size": 25, "package_amount": "1500" }
```

`unit_amount` is a decimal string in minor units (cents) with up to 9 fraction digits; `flat_amount` is whole minor units.

## Design decisions and trade-offs

**Pricing is exact and rounds once.** Prices are `bigint` scaled by 10^9. A line's total is summed across tiers at full precision and rounded half away from zero a single time. Zero usage costs zero in every model; a tier's flat fee applies once usage enters that tier. `volume` pricing is deliberately *not* monotonic across a boundary (101 units can cost less than 100); `graduated` and `package` are, and the property tests assert exactly that distinction.

**Idempotency is a primary key, not a cache.** `(tenant, idempotency_key)` is the events primary key and batches use `INSERT ... ON CONFLICT DO NOTHING`. Each event stores a hash of its canonical payload, so a replay is `duplicate` and a reuse with a different body is `conflict` (the original is never overwritten). Batch rows are inserted in key order so overlapping concurrent batches take index locks in the same order and cannot deadlock; the concurrency test originally caught exactly that deadlock.

**Late events use an `effective_at`, not a second invoice.** After finalizing a period, the customer's `usage_watermark` is that period's end. An event older than the watermark is accepted, flagged `late`, and its `effective_at` is clamped to the watermark so it is billed in the open period. The finalized invoice is never modified. Events older than `MAX_EVENT_AGE_DAYS` (35) or further than `MAX_CLOCK_SKEW_SECONDS` in the future are rejected.

**Ingestion vs. finalization is a lock, not a retry loop.** Ingestion reads the watermark under `FOR KEY SHARE` on the customer row; finalization takes `FOR UPDATE` on it first. They conflict, so a batch either commits before the invoice aggregates (and is in it) or sees the new watermark (and is deferred). Ingestion batches do not block each other.

**Finalization is one transaction.** Lock customer and subscription, aggregate, price, insert the invoice (unique per subscription and period), number it from a per-tenant counter, consume credits, advance the watermark and the period, enqueue the Stripe push. Concurrent finalizations of the same period yield one invoice.

**Proration corrects an in-arrears fee.** The invoice charges the current plan's base fee for the whole period; a mid-period plan change queues `(old_fee - new_fee) x elapsed_share`, so any number of changes telescopes to the time-weighted fee. Usage tiers are not prorated.

**Outbox, not dual writes.** The Stripe job is inserted in the same transaction as the invoice. Workers lease rows with `FOR UPDATE SKIP LOCKED` and a lease timeout (a crashed worker's jobs come back), retry transient errors with exponential backoff, dead-letter permanent ones, and always call Stripe with a deterministic idempotency key derived from the aggregate id, so "timeout after success" replays instead of duplicating.

**Webhooks are verified, deduplicated and ordered by the event's own time.** The HMAC is computed over the raw body and compared in constant time; several `v1` entries are accepted for secret rotation; the timestamp must be within the tolerance window (default 300 s). The event id is claimed by an `INSERT` in the same transaction that applies it, so concurrent duplicates apply once. State follows the event's `created`, never arrival order (ties: `paid` wins). An event for an invoice whose Stripe id is not linked yet is parked as `orphaned` and replayed, oldest first, when the worker links it; a per-invoice advisory lock makes "link" and "apply" mutually exclusive so a parked event can never be missed.

**Other choices.** `Bun.SQL` instead of an ORM so the locking and `ON CONFLICT` behaviour is visible in the code. Time comes from an injected `Clock`, so tests are deterministic. Aggregations are computed from the events table at read time (indexed on customer, meter, `effective_at`) rather than maintained as rollups: simpler and always consistent, at the cost of scan time on very large periods.

## Testing

`bun test` runs 148 tests across 13 files, including fast-check properties, against a real PostgreSQL (the suite creates and migrates `*_test` databases itself and refuses any other name).

| Area | What is proven |
| --- | --- |
| Pricing properties | graduated equals a unit-by-unit reference; non-negative and monotonic; crossing a boundary adds exactly the next tier's price; exact for quantities up to 10^40; volume switches tier exactly at the boundary; package is `ceil(q/size)` |
| Proration, periods | clamped month arithmetic never drifts; successive plan changes telescope within half a minor unit each |
| Event ordering | any delivery order of Stripe events converges to the same state |
| Ingestion concurrency | 40 overlapping concurrent batches ingest every key exactly once; 12 concurrent conflicting payloads yield one winner |
| Ingest vs. finalize | 300 events racing a finalization are conserved: in the invoice or deferred, never lost or doubled |
| Finalize concurrency | 8 parallel finalizations create one invoice, one credit consumption, one outbox job |
| Outbox | retry/backoff timing, dead-letter, max attempts, timeout-after-success reuses the idempotency key, 3 workers deliver 45 jobs exactly once, expired lease is taken over |
| Webhooks | missing/wrong/tampered/re-timed signatures, replay window edges, captured-request replay, concurrent duplicate delivery, out-of-order, orphan-then-link, webhook racing the link |
| HTTP | auth, tenant isolation across every route, validation shape, 413, generic 500, amounts beyond 2^53 end to end |

Coverage from `bun test --coverage` on the last full run: 99.4 % of lines and 97.4 % of functions (all of `src/` plus the test harness). No throughput benchmarks were run, so none are claimed.

```bash
bun install
docker compose up -d db                                     # or any PostgreSQL 16
export TEST_DATABASE_URL=postgres://meterly:meterly-dev-only@127.0.0.1:5432/meterly_test
bun run typecheck && bun run lint && bun test
```

## Limitations

- The shipped server wires the **in-memory fake** Stripe. State of the fake is lost on restart (the invoice ids already stored are not). A real client would implement `StripeGateway`; none is included.
- Integers are limited to the PostgreSQL bigint range (out-of-range input is a 400); an invoice whose computed amount would exceed it is refused with a 409.
- Monthly periods, one subscription per customer, no cancellation, trials, taxes or discounts. Base fees are billed in arrears.
- Late events are billed in the open period, not through a corrective invoice; beyond the maximum age they are rejected.
- Credits do not expire; a plan has one currency and credits are per currency.
- Tenants are created with a CLI; there is no key rotation or revocation endpoint, and no rate limiting.
- Outbox retries use deterministic exponential backoff without jitter; the worker polls rather than using `LISTEN/NOTIFY`.
- Not load-tested: ingestion throughput and aggregation cost on very large periods are unmeasured.

## License

[MIT](LICENSE)

---

Built by [Chico Oliveira](https://github.com/FrancisWorld)
