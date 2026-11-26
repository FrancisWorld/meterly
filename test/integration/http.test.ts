import { describe, expect, test } from "bun:test";
import { createTenant } from "../../src/services/tenants.ts";
import { event, jsonOf, seedBilling, useWorld } from "../harness.ts";

const world = useWorld();

describe("authentication and tenancy", () => {
  test("every /v1 route needs a valid bearer key", async () => {
    const w = world();
    const anon = await w.api("GET", "/v1/meters", undefined, null);
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe("unauthorized");
    expect((await w.api("GET", "/v1/meters", undefined, "mtk_not-a-real-key")).status).toBe(401);
    const res = await w.app.request("/v1/meters", { headers: { authorization: `Basic ${w.apiKey}` } });
    expect(res.status).toBe(401);
    const spoof = await w.app.request("/v1/meters", { headers: { "x-tenant-id": w.tenantId } });
    expect(spoof.status).toBe(401); // the tenant can only come from the key
  });

  test("only a hash of the key is stored", async () => {
    const rows = await world().db`SELECT key_hash FROM api_keys`;
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].key_hash).not.toContain(world().apiKey);
  });

  test("tenants cannot see or touch each other's data", async () => {
    const w = world();
    const { customer, plan, sub } = await seedBilling(w);
    const other = await createTenant(w.db, w.clock, "globex");
    const asOther = (method: string, path: string, body?: unknown) => w.api(method, path, body, other.apiKey);

    expect((await asOther("GET", `/v1/customers/${customer.id}`)).status).toBe(404);
    expect((await asOther("GET", `/v1/plans/${plan.id}`)).status).toBe(404);
    expect((await asOther("GET", `/v1/subscriptions/${sub.id}`)).status).toBe(404);
    expect((await asOther("GET", `/v1/subscriptions/${sub.id}/invoice-preview`)).status).toBe(404);
    expect((await asOther("POST", `/v1/subscriptions/${sub.id}/invoices`, {})).status).toBe(404);
    expect((await asOther("GET", `/v1/customers/${customer.id}/credits`)).status).toBe(404);
    expect(
      (await asOther("POST", `/v1/customers/${customer.id}/credits`, { amount: 5, currency: "usd", reason: "x" }))
        .status,
    ).toBe(404);
    expect((await asOther("POST", "/v1/subscriptions", { customer_id: customer.id, plan_id: plan.id })).status).toBe(
      404,
    );
    expect((await asOther("GET", "/v1/meters")).body.data).toEqual([]);

    const ingest = await asOther("POST", "/v1/events", { events: [event("x1")] });
    expect(ingest.body.results[0]).toMatchObject({ status: "rejected", reason: "unknown_customer" });
    // The same idempotency key is independent per tenant.
    const mine = await w.api("POST", "/v1/events", { events: [event("x1")] });
    expect(mine.body.results[0].status).toBe("accepted");
    // And the same meter code / customer id can exist in both tenants.
    expect((await asOther("POST", "/v1/meters", { code: "api_calls", aggregation: "sum" })).status).toBe(201);
  });
});

describe("HTTP behaviour", () => {
  test("health and readiness", async () => {
    const w = world();
    expect((await w.app.request("/healthz")).status).toBe(200);
    const ready = await w.app.request("/readyz");
    expect(await ready.json()).toEqual({ status: "ready" });
  });

  test("errors have one stable shape; ids and routes that do not exist are 404", async () => {
    const w = world();
    const bad = await w.api("POST", "/v1/meters", { code: "!!", aggregation: "median" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("validation_error");
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["aggregation", "code"]);
    expect((await w.api("POST", "/v1/meters", "{broken")).body.error.message).toContain("valid JSON");
    expect((await w.api("GET", "/v1/customers/not-a-uuid")).status).toBe(404);
    expect((await w.api("GET", `/v1/customers/${crypto.randomUUID()}`)).status).toBe(404);
    const missing = await w.app.request("/nope");
    expect(missing.status).toBe(404);
    expect((await jsonOf(missing)).error.code).toBe("not_found");
    expect((await w.api("POST", "/v1/meters", { code: "x", aggregation: "sum", extra: 1 })).status).toBe(400);
  });

  test("requests carry an id that is echoed back", async () => {
    const res = await world().app.request("/healthz", { headers: { "x-request-id": "abc-123" } });
    expect(res.headers.get("x-request-id")).toBe("abc-123");
    expect((await world().app.request("/healthz")).headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("oversized bodies are refused", async () => {
    const res = await world().api("POST", "/v1/events", " ".repeat(4 * 1024 * 1024 + 10));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });

  test("unexpected failures become a generic 500 without leaking details", async () => {
    const w = world();
    await w.db.unsafe("ALTER TABLE meters RENAME TO meters_tmp");
    try {
      const res = await w.api("GET", "/v1/meters");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: "internal_error", message: "internal server error" } });
      expect((await w.app.request("/readyz")).status).toBe(200);
    } finally {
      await w.db.unsafe("ALTER TABLE meters_tmp RENAME TO meters");
    }
  });
});

describe("end to end", () => {
  test("amounts and quantities beyond 2^53 survive the whole pipeline as exact strings", async () => {
    const w = world();
    await w.api("POST", "/v1/meters", { code: "bytes", aggregation: "sum" });
    const plan = (
      await w.api("POST", "/v1/plans", {
        code: "huge",
        currency: "usd",
        base_fee: "9007199254740993",
        items: [{ meter: "bytes", pricing: { model: "graduated", tiers: [{ up_to: null, unit_amount: "1.5" }] } }],
      })
    ).body;
    const customer = (await w.api("POST", "/v1/customers", { external_id: "c", name: "C" })).body;
    const sub = (
      await w.api("POST", "/v1/subscriptions", {
        customer_id: customer.id,
        plan_id: plan.id,
        started_at: "2026-03-01T00:00:00Z",
      })
    ).body;
    await w.api("POST", "/v1/events", {
      events: [
        event("b1", { meter: "bytes", customer: "c", quantity: "9007199254740993" }),
        event("b2", { meter: "bytes", customer: "c", quantity: "9007199254740993" }),
      ],
    });
    w.clock.set(new Date("2026-04-01T00:00:00Z"));
    const invoice = (await w.api("POST", `/v1/subscriptions/${sub.id}/invoices`, {})).body;
    // 2 * 9007199254740993 * 1.5 = 27021597764222979, plus the base fee 9007199254740993.
    expect(invoice.lines.find((l: { meter: string }) => l.meter === "bytes").amount).toBe("27021597764222979");
    expect(invoice.amount_due).toBe("36028797018963972");
    expect(BigInt(invoice.amount_due)).toBe(9007199254740993n + 27021597764222979n);
  });
});
