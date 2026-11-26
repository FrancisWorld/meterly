-- Meterly initial schema. All money is stored as bigint minor units, all
-- quantities as bigint, all sums as numeric(40,0) so nothing is ever floating point.

CREATE TABLE tenants (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE TABLE api_keys (
  key_hash    text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  label       text NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE TABLE meters (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  code         text NOT NULL,
  aggregation  text NOT NULL CHECK (aggregation IN ('sum', 'max', 'unique')),
  -- For 'unique' meters: the event property whose distinct values are counted.
  property     text,
  created_at   timestamptz NOT NULL,
  UNIQUE (tenant_id, code),
  CHECK ((aggregation = 'unique') = (property IS NOT NULL))
);

CREATE TABLE plans (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  code            text NOT NULL,
  currency        text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  base_fee_minor  bigint NOT NULL CHECK (base_fee_minor >= 0),
  created_at      timestamptz NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE plan_items (
  plan_id    uuid NOT NULL REFERENCES plans (id),
  meter_id   uuid NOT NULL REFERENCES meters (id),
  pricing    jsonb NOT NULL,
  PRIMARY KEY (plan_id, meter_id)
);

CREATE TABLE customers (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  external_id         text NOT NULL,
  name                text NOT NULL,
  email               text,
  stripe_customer_id  text,
  -- Usage older than this is "late": it is billed in the open period instead.
  usage_watermark     timestamptz,
  created_at          timestamptz NOT NULL,
  UNIQUE (tenant_id, external_id)
);

CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  customer_id           uuid NOT NULL REFERENCES customers (id) UNIQUE,
  plan_id               uuid NOT NULL REFERENCES plans (id),
  billing_anchor        timestamptz NOT NULL,
  period_index          integer NOT NULL DEFAULT 0 CHECK (period_index >= 0),
  current_period_start  timestamptz NOT NULL,
  current_period_end    timestamptz NOT NULL,
  created_at            timestamptz NOT NULL
);

-- Charges or credits (negative) waiting for the next invoice, e.g. proration.
CREATE TABLE pending_items (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  subscription_id  uuid NOT NULL REFERENCES subscriptions (id),
  description      text NOT NULL,
  amount_minor     bigint NOT NULL,
  invoice_id       uuid,
  created_at       timestamptz NOT NULL
);
CREATE INDEX pending_items_open ON pending_items (subscription_id) WHERE invoice_id IS NULL;

CREATE TABLE events (
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  id               uuid NOT NULL,
  idempotency_key  text NOT NULL,
  payload_hash     text NOT NULL,
  customer_id      uuid NOT NULL REFERENCES customers (id),
  meter_id         uuid NOT NULL REFERENCES meters (id),
  quantity         bigint NOT NULL CHECK (quantity >= 0),
  dimension        text,
  occurred_at      timestamptz NOT NULL,
  -- occurred_at, or the customer's watermark when the event arrived after the
  -- period it belongs to was finalized. Aggregation always uses this column.
  effective_at     timestamptz NOT NULL,
  received_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE INDEX events_agg ON events (customer_id, meter_id, effective_at);

CREATE TABLE invoices (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  customer_id        uuid NOT NULL REFERENCES customers (id),
  subscription_id    uuid NOT NULL REFERENCES subscriptions (id),
  number             bigint NOT NULL,
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL,
  currency           text NOT NULL,
  subtotal_minor     bigint NOT NULL,
  credits_applied    bigint NOT NULL CHECK (credits_applied >= 0),
  amount_due_minor   bigint NOT NULL CHECK (amount_due_minor >= 0),
  status             text NOT NULL CHECK (status IN ('open', 'paid', 'payment_failed', 'void')),
  status_event_at    timestamptz,
  stripe_invoice_id  text UNIQUE,
  lines              jsonb NOT NULL,
  finalized_at       timestamptz NOT NULL,
  UNIQUE (subscription_id, period_start),
  UNIQUE (tenant_id, number)
);

CREATE TABLE credit_ledger (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  customer_id  uuid NOT NULL REFERENCES customers (id),
  currency     text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  reason       text NOT NULL,
  invoice_id   uuid REFERENCES invoices (id),
  grant_key    text,
  created_at   timestamptz NOT NULL
);
CREATE UNIQUE INDEX credit_grant_key ON credit_ledger (tenant_id, grant_key) WHERE grant_key IS NOT NULL;
CREATE INDEX credit_balance ON credit_ledger (customer_id, currency);

CREATE TABLE tenant_counters (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants (id),
  last_invoice_no bigint NOT NULL DEFAULT 0
);

CREATE TABLE outbox (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  kind             text NOT NULL CHECK (kind IN ('stripe.customer.sync', 'stripe.invoice.push')),
  aggregate_id     uuid NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  leased_until     timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL,
  done_at          timestamptz
);
CREATE INDEX outbox_due ON outbox (next_attempt_at) WHERE status = 'pending';

CREATE TABLE webhook_events (
  event_id     text PRIMARY KEY,
  type         text NOT NULL,
  created_at   timestamptz NOT NULL,
  object_id    text,
  payload      jsonb NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('applied', 'stale', 'ignored', 'orphaned')),
  received_at  timestamptz NOT NULL
);
CREATE INDEX webhook_orphans ON webhook_events (object_id) WHERE outcome = 'orphaned';
