import { afterAll, beforeAll, beforeEach } from "bun:test";
import type { Hono } from "hono";
import { ManualClock } from "../src/clock.ts";
import { createDb, type Db } from "../src/db/client.ts";
import { createApp } from "../src/http/app.ts";
import type { Env } from "../src/http/context.ts";
import { silentLogger } from "../src/logger.ts";
import { createTenant } from "../src/services/tenants.ts";
import { FakeStripe } from "../src/stripe/fake.ts";
import { buildSignatureHeader } from "../src/stripe/signature.ts";
import { OutboxWorker } from "../src/worker/outbox-worker.ts";

export const WEBHOOK_SECRET = "replace-me-test-webhook-secret";
export const T0 = new Date("2026-03-20T00:00:00.000Z");

export const config = {
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  WEBHOOK_TOLERANCE_SECONDS: 300,
  MAX_EVENT_AGE_DAYS: 35,
  MAX_CLOCK_SKEW_SECONDS: 300,
};

// biome-ignore lint/suspicious/noExplicitAny: API responses are inspected dynamically by the tests
export type Json = any;

export const jsonOf = (res: Response): Promise<Json> => res.json() as Promise<Json>;

export interface World {
  db: Db;
  clock: ManualClock;
  stripe: FakeStripe;
  app: Hono<Env>;
  tenantId: string;
  apiKey: string;
  worker(overrides?: Partial<ConstructorParameters<typeof OutboxWorker>[4]>): OutboxWorker;
  api(method: string, path: string, body?: unknown, key?: string | null): Promise<{ status: number; body: Json }>;
  webhook(
    event: Record<string, unknown>,
    opts?: { timestamp?: number; secret?: string },
  ): Promise<{ status: number; body: Json }>;
}

const TABLES = "tenants, webhook_events";

/** Registers hooks that give every test a clean database, a fresh tenant and a fixed clock. */
export function useWorld(): () => World {
  let db: Db;
  let world: World;

  beforeAll(() => {
    db = createDb(process.env.TEST_DATABASE_URL as string, 20);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.unsafe(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    const clock = new ManualClock(T0);
    const stripe = new FakeStripe();
    const tenant = await createTenant(db, clock, "acme");
    const app = createApp({ db, clock, logger: silentLogger, config });
    const call = async (method: string, path: string, body?: unknown, key: string | null = tenant.apiKey) => {
      const res = await app.request(path, {
        method,
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    world = {
      db,
      clock,
      stripe,
      app,
      tenantId: tenant.tenantId,
      apiKey: tenant.apiKey,
      worker: (overrides = {}) =>
        new OutboxWorker(db, stripe, clock, silentLogger, {
          batchSize: 25,
          maxAttempts: 5,
          leaseSeconds: 60,
          pollMs: 10,
          ...overrides,
        }),
      api: call,
      webhook: async (event, opts = {}) => {
        const raw = JSON.stringify(event);
        const ts = opts.timestamp ?? Math.floor(clock.now().getTime() / 1000);
        const res = await app.request("/webhooks/stripe", {
          method: "POST",
          headers: { "stripe-signature": buildSignatureHeader(opts.secret ?? WEBHOOK_SECRET, ts, raw) },
          body: raw,
        });
        return { status: res.status, body: await res.json() };
      },
    };
  });
  return () => world;
}

/** Seed a typical catalog through the public API and return the ids. */
export async function seedBilling(w: World) {
  const ok = (r: { status: number; body: Json }) => {
    if (r.status >= 300) throw new Error(`seed failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  await w.api("POST", "/v1/meters", { code: "api_calls", aggregation: "sum" }).then(ok);
  await w.api("POST", "/v1/meters", { code: "peak_seats", aggregation: "max" }).then(ok);
  await w.api("POST", "/v1/meters", { code: "active_users", aggregation: "unique", property: "user" }).then(ok);
  const plan = await w
    .api("POST", "/v1/plans", {
      code: "growth",
      currency: "usd",
      base_fee: 4900,
      items: [
        {
          meter: "api_calls",
          pricing: {
            model: "graduated",
            tiers: [
              { up_to: 1000, unit_amount: "0" },
              { up_to: 10000, unit_amount: "0.5" },
              { up_to: null, unit_amount: "0.2" },
            ],
          },
        },
        {
          meter: "peak_seats",
          pricing: {
            model: "volume",
            tiers: [
              { up_to: 10, unit_amount: "100" },
              { up_to: null, unit_amount: "80" },
            ],
          },
        },
        { meter: "active_users", pricing: { model: "package", package_size: 25, package_amount: "1500" } },
      ],
    })
    .then(ok);
  const customer = await w
    .api("POST", "/v1/customers", { external_id: "cust-1", name: "Initech", email: "ap@initech.example" })
    .then(ok);
  const sub = await w
    .api("POST", "/v1/subscriptions", {
      customer_id: customer.id,
      plan_id: plan.id,
      started_at: "2026-03-01T00:00:00Z",
    })
    .then(ok);
  return { plan, customer, sub };
}

export const event = (key: string, over: Record<string, unknown> = {}) => ({
  idempotency_key: key,
  customer: "cust-1",
  meter: "api_calls",
  timestamp: "2026-03-10T12:00:00Z",
  quantity: 1,
  ...over,
});
