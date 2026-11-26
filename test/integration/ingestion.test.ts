import { describe, expect, test } from "bun:test";
import { event, seedBilling, useWorld } from "../harness.ts";

const world = useWorld();

const post = (events: unknown[]) => world().api("POST", "/v1/events", { events });
const count = async () => Number((await world().db`SELECT count(*)::int AS n FROM events`)[0].n);
const usage = async (customerId: string, meter: string, extra = "") =>
  (
    await world().api(
      "GET",
      `/v1/usage?customer_id=${customerId}&meter=${meter}&from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z${extra}`,
    )
  ).body;

describe("idempotent ingestion", () => {
  test("accepts a batch and reports per-event status", async () => {
    await seedBilling(world());
    const res = await post([event("e1", { quantity: 5 }), event("e2", { quantity: "7" })]);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ accepted: 2, duplicate: 0, rejected: 0, conflict: 0 });
    expect(res.body.results[0]).toMatchObject({ idempotency_key: "e1", status: "accepted", late: false });
    expect(await count()).toBe(2);
  });

  test("replaying a batch changes nothing", async () => {
    const { customer } = await seedBilling(world());
    const batch = [event("e1", { quantity: 5 }), event("e2", { quantity: 7 })];
    await post(batch);
    const replay = await post(batch);
    expect(replay.body.summary).toEqual({ accepted: 0, duplicate: 2, rejected: 0, conflict: 0 });
    expect(await count()).toBe(2);
    expect((await usage(customer.id, "api_calls")).total).toBe("12");
  });

  test("property order inside an event does not change its identity", async () => {
    await seedBilling(world());
    await post([event("e1", { meter: "active_users", properties: { user: "u1", plan: "x" } })]);
    const replay = await post([event("e1", { meter: "active_users", properties: { plan: "x", user: "u1" } })]);
    expect(replay.body.results[0].status).toBe("duplicate");
  });

  test("reusing a key with a different payload is a conflict and keeps the original", async () => {
    const { customer } = await seedBilling(world());
    await post([event("e1", { quantity: 5 })]);
    const res = await post([event("e1", { quantity: 6 })]);
    expect(res.body.results[0]).toEqual({
      idempotency_key: "e1",
      status: "conflict",
      reason: "idempotency_key_reused_with_different_payload",
    });
    expect((await usage(customer.id, "api_calls")).total).toBe("5");
  });

  test("duplicates inside one batch are resolved deterministically (first wins)", async () => {
    await seedBilling(world());
    const res = await post([event("e1", { quantity: 1 }), event("e1", { quantity: 1 }), event("e1", { quantity: 2 })]);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(["accepted", "duplicate", "conflict"]);
    expect(await count()).toBe(1);
  });

  test("bad events are rejected individually without failing the batch", async () => {
    await seedBilling(world());
    const res = await post([
      event("ok"),
      event("nocust", { customer: "ghost" }),
      event("nometer", { meter: "ghost" }),
      event("noprop", { meter: "active_users", properties: {} }),
      event("ancient", { timestamp: "2026-01-01T00:00:00Z" }),
      event("future", { timestamp: "2026-03-20T01:00:00Z" }),
    ]);
    expect(res.body.results.map((r: { status: string; reason?: string }) => r.reason ?? r.status)).toEqual([
      "accepted",
      "unknown_customer",
      "unknown_meter",
      "missing_property",
      "too_old",
      "in_future",
    ]);
    expect(await count()).toBe(1);
  });

  test("validates the request shape", async () => {
    await seedBilling(world());
    expect((await post([])).status).toBe(400);
    expect((await post([{ ...event("x"), quantity: -1 }])).status).toBe(400);
    expect((await post([{ ...event("x"), timestamp: "yesterday" }])).status).toBe(400);
    expect((await post([{ ...event("x"), surprise: true }])).status).toBe(400);
    expect((await post(Array.from({ length: 1001 }, (_, i) => event(`k${i}`)))).status).toBe(400);
  });
});

describe("aggregation", () => {
  test("sum, max and unique with hourly and daily windows", async () => {
    const { customer } = await seedBilling(world());
    await post([
      event("a1", { quantity: 10, timestamp: "2026-03-05T10:15:00Z" }),
      event("a2", { quantity: 20, timestamp: "2026-03-05T10:45:00Z" }),
      event("a3", { quantity: 5, timestamp: "2026-03-05T11:00:00Z" }),
      event("a4", { quantity: 100, timestamp: "2026-03-06T00:00:00Z" }),
      event("s1", { meter: "peak_seats", quantity: 4, timestamp: "2026-03-05T10:00:00Z" }),
      event("s2", { meter: "peak_seats", quantity: 9, timestamp: "2026-03-05T10:30:00Z" }),
      event("s3", { meter: "peak_seats", quantity: 6, timestamp: "2026-03-06T10:30:00Z" }),
      event("u1", { meter: "active_users", properties: { user: "ann" }, timestamp: "2026-03-05T10:00:00Z" }),
      event("u2", { meter: "active_users", properties: { user: "ann" }, timestamp: "2026-03-05T10:05:00Z" }),
      event("u3", { meter: "active_users", properties: { user: "bob" }, timestamp: "2026-03-05T10:06:00Z" }),
      event("u4", { meter: "active_users", properties: { user: "ann" }, timestamp: "2026-03-06T10:00:00Z" }),
    ]);

    const sum = await usage(customer.id, "api_calls", "&window=hour");
    expect(sum.total).toBe("135");
    expect(sum.buckets).toEqual([
      { start: "2026-03-05T10:00:00.000Z", quantity: "30" },
      { start: "2026-03-05T11:00:00.000Z", quantity: "5" },
      { start: "2026-03-06T00:00:00.000Z", quantity: "100" },
    ]);

    const max = await usage(customer.id, "peak_seats", "&window=day");
    expect(max.total).toBe("9");
    expect(max.buckets.map((b: { quantity: string }) => b.quantity)).toEqual(["9", "6"]);

    const unique = await usage(customer.id, "active_users", "&window=day");
    expect(unique.total).toBe("2"); // ann + bob across the range, not 2 + 1
    expect(unique.buckets.map((b: { quantity: string }) => b.quantity)).toEqual(["2", "1"]);
  });

  test("range is half-open and an empty range is zero", async () => {
    const { customer } = await seedBilling(world());
    await post([event("a1", { quantity: 3, timestamp: "2026-03-05T00:00:00Z" })]);
    const res = await world().api(
      "GET",
      `/v1/usage?customer_id=${customer.id}&meter=api_calls&from=2026-03-05T00:00:00Z&to=2026-03-05T00:00:00.001Z`,
    );
    expect(res.body.total).toBe("3");
    const none = await world().api(
      "GET",
      `/v1/usage?customer_id=${customer.id}&meter=api_calls&from=2026-03-01T00:00:00Z&to=2026-03-05T00:00:00Z`,
    );
    expect(none.body.total).toBe("0");
    const inverted = await world().api(
      "GET",
      `/v1/usage?customer_id=${customer.id}&meter=api_calls&from=2026-03-05T00:00:00Z&to=2026-03-01T00:00:00Z`,
    );
    expect(inverted.status).toBe(400);
    const unknown = await world().api(
      "GET",
      `/v1/usage?customer_id=${customer.id}&meter=nope&from=2026-03-01T00:00:00Z&to=2026-03-02T00:00:00Z`,
    );
    expect(unknown.status).toBe(404);
  });

  test("sums beyond 2^53 stay exact", async () => {
    const { customer } = await seedBilling(world());
    await post([
      event("big1", { quantity: "9007199254740993" }),
      event("big2", { quantity: "9007199254740993" }),
      event("big3", { quantity: "1" }),
    ]);
    expect((await usage(customer.id, "api_calls")).total).toBe("18014398509481987");
  });
});

describe("concurrency", () => {
  test("overlapping concurrent batches ingest every key exactly once", async () => {
    const { customer } = await seedBilling(world());
    const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
    // 40 batches of 25 events drawn with heavy overlap: every key is sent ~5 times, concurrently.
    const batches = Array.from({ length: 40 }, (_, b) =>
      Array.from({ length: 25 }, (_, i) => event(keys[(b * 7 + i * 8) % 200] as string, { quantity: 3 })),
    );
    const responses = await Promise.all(batches.map(post));
    const results = responses.flatMap((r) => r.body.results as { idempotency_key: string; status: string }[]);
    expect(responses.every((r) => r.status === 200)).toBe(true);

    const sent = new Set(batches.flat().map((e) => e.idempotency_key));
    const accepted = results.filter((r) => r.status === "accepted");
    expect(new Set(accepted.map((r) => r.idempotency_key)).size).toBe(accepted.length); // never accepted twice
    expect(accepted.length).toBe(sent.size);
    expect(await count()).toBe(sent.size);
    expect((await usage(customer.id, "api_calls")).total).toBe(String(sent.size * 3));
  });

  test("a concurrent conflicting payload never overwrites the winner", async () => {
    const { customer } = await seedBilling(world());
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => post([event("same", { quantity: i + 1 })])),
    );
    const statuses = responses.map((r) => r.body.results[0].status as string);
    expect(statuses.filter((s) => s === "accepted")).toHaveLength(1);
    expect(statuses.filter((s) => s === "conflict").length).toBeGreaterThanOrEqual(10);
    expect(await count()).toBe(1);
    const winner = responses.findIndex((r) => r.body.results[0].status === "accepted") + 1;
    expect((await usage(customer.id, "api_calls")).total).toBe(String(winner));
  });
});
