import { describe, expect, test } from "bun:test";
import { event, seedBilling, useWorld } from "../harness.ts";

const world = useWorld();
const post = (events: unknown[]) => world().api("POST", "/v1/events", { events });
const usageLine = (invoice: { lines: { kind: string; meter: string; quantity: string }[] }, meter: string) =>
  invoice.lines.find((l) => l.kind === "usage" && l.meter === meter)?.quantity;

describe("late events and the watermark", () => {
  test("an event for a closed period is accepted, flagged late, and billed in the open period", async () => {
    const { sub } = await seedBilling(world());
    await post([event("on-time", { quantity: 100, timestamp: "2026-03-10T00:00:00Z" })]);
    world().clock.set(new Date("2026-04-02T00:00:00Z"));
    const first = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {});
    expect(first.status).toBe(201);
    expect(usageLine(first.body, "api_calls")).toBe("100");

    const late = await post([event("straggler", { quantity: 40, timestamp: "2026-03-20T00:00:00Z" })]);
    expect(late.body.results[0]).toMatchObject({
      status: "accepted",
      late: true,
      effective_at: "2026-04-01T00:00:00.000Z",
    });

    // The finalized invoice is immutable.
    const reread = await world().api("GET", `/v1/invoices/${first.body.id}`);
    expect(usageLine(reread.body, "api_calls")).toBe("100");

    const preview = await world().api("GET", `/v1/subscriptions/${sub.id}/invoice-preview`);
    expect(preview.body.period_start).toBe("2026-04-01T00:00:00.000Z");
    expect(usageLine(preview.body, "api_calls")).toBe("40");
  });

  test("events from the future of the watermark are not late", async () => {
    const { sub } = await seedBilling(world());
    world().clock.set(new Date("2026-04-02T00:00:00Z"));
    await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {});
    const res = await post([event("fresh", { timestamp: "2026-04-01T12:00:00Z" })]);
    expect(res.body.results[0]).toMatchObject({ status: "accepted", late: false });
  });

  test("events past the maximum age are rejected instead of billed late", async () => {
    await seedBilling(world());
    world().clock.set(new Date("2026-05-01T00:00:00Z"));
    const res = await post([event("old", { timestamp: "2026-03-10T00:00:00Z" })]);
    expect(res.body.results[0]).toEqual({ idempotency_key: "old", status: "rejected", reason: "too_old" });
  });

  test("ingestion racing finalization never loses or double-counts an event", async () => {
    const { sub, customer } = await seedBilling(world());
    world().clock.set(new Date("2026-04-02T00:00:00Z"));
    const total = 30 * 10;
    const batches = Array.from({ length: 30 }, (_, b) =>
      Array.from({ length: 10 }, (_, i) =>
        event(`race-${b}-${i}`, {
          quantity: 1,
          timestamp: `2026-03-${String(10 + (b % 15)).padStart(2, "0")}T00:00:00Z`,
        }),
      ),
    );
    const [finalize, ...ingests] = await Promise.all([
      world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {}),
      ...batches.map(post),
    ]);
    expect(finalize?.status).toBe(201);
    expect(ingests.every((r) => r.status === 200)).toBe(true);

    const billedInInvoice = Number(usageLine(finalize?.body, "api_calls") ?? 0);
    const rows = await world().db`
      SELECT count(*) FILTER (WHERE effective_at <  '2026-04-01')::int AS before_close,
             count(*) FILTER (WHERE effective_at >= '2026-04-01')::int AS after_close,
             count(*)::int AS total
      FROM events WHERE customer_id = ${customer.id}`;
    // Every event is either inside the closed invoice or deferred to the next period: none vanish, none are in both.
    expect(rows[0].total).toBe(total);
    expect(rows[0].before_close).toBe(billedInInvoice);
    expect(rows[0].before_close + rows[0].after_close).toBe(total);

    const next = await world().api("GET", `/v1/subscriptions/${sub.id}/invoice-preview`);
    expect(Number(usageLine(next.body, "api_calls") ?? 0)).toBe(rows[0].after_close);
  });
});
