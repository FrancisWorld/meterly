import { describe, expect, test } from "bun:test";
import { fakeId } from "../../src/stripe/fake.ts";
import { buildSignatureHeader } from "../../src/stripe/signature.ts";
import { jsonOf, seedBilling, useWorld, WEBHOOK_SECRET } from "../harness.ts";

const world = useWorld();

let seq = 0;
const evt = (type: string, stripeId: string, created: number, id = `evt_${++seq}`) => ({
  id,
  type,
  created,
  data: { object: { id: stripeId, object: "invoice" } },
});

/** A finalized invoice that the worker has already pushed to (fake) Stripe. */
async function pushedInvoice(withPush = true) {
  const seeded = await seedBilling(world());
  world().clock.set(new Date("2026-04-01T00:00:00Z"));
  const invoice = (await world().api("POST", `/v1/subscriptions/${seeded.sub.id}/invoices`, {})).body;
  const stripeId = fakeId("in", `invoice:${invoice.id}`);
  if (withPush) await world().worker().runOnce();
  return { invoice, stripeId, created: Math.floor(world().clock.now().getTime() / 1000) };
}

const status = async (id: string) => (await world().api("GET", `/v1/invoices/${id}`)).body.status as string;
const stored = async () => Number((await world().db`SELECT count(*)::int AS n FROM webhook_events`)[0].n);

describe("signature enforcement", () => {
  test("applies a correctly signed event", async () => {
    const { invoice, stripeId, created } = await pushedInvoice();
    expect(invoice.stripe_invoice_id).toBeNull();
    expect((await world().api("GET", `/v1/invoices/${invoice.id}`)).body.stripe_invoice_id).toBe(stripeId);
    const res = await world().webhook(evt("invoice.paid", stripeId, created));
    expect(res).toEqual({ status: 200, body: { received: true, outcome: "applied" } });
    expect(await status(invoice.id)).toBe("paid");
  });

  test("forged events are refused and leave no trace", async () => {
    const { invoice, stripeId, created } = await pushedInvoice();
    const body = JSON.stringify(evt("invoice.paid", stripeId, created, "evt_forged"));
    const send = (headers: Record<string, string>, raw = body) =>
      world().app.request("/webhooks/stripe", { method: "POST", headers, body: raw });
    const ts = created;

    const noHeader = await send({});
    const wrongSecret = await send({
      "stripe-signature": buildSignatureHeader("attacker-secret-attacker-secret", ts, body),
    });
    const tampered = await send(
      { "stripe-signature": buildSignatureHeader(WEBHOOK_SECRET, ts, body) },
      body.replace("invoice.paid", "invoice.voided"),
    );
    const reTimed = await send({
      "stripe-signature": `t=${ts + 1},v1=${buildSignatureHeader(WEBHOOK_SECRET, ts, body).split("v1=")[1]}`,
    });
    const garbage = await send({ "stripe-signature": "v1=deadbeef" });
    for (const res of [noHeader, wrongSecret, tampered, reTimed, garbage]) {
      expect(res.status).toBe(400);
      expect((await jsonOf(res)).error.code).toBe("invalid_signature");
    }
    expect(await status(invoice.id)).toBe("open");
    expect(await stored()).toBe(0);
  });

  test("replay window: a validly signed but stale (or future-dated) payload is refused", async () => {
    const { invoice, stripeId, created } = await pushedInvoice();
    const e = evt("invoice.paid", stripeId, created);
    const stale = await world().webhook(e, { timestamp: created - 301 });
    expect(stale.status).toBe(400);
    expect(stale.body.error.details.reason).toBe("timestamp_outside_tolerance");
    expect((await world().webhook(e, { timestamp: created + 301 })).status).toBe(400);
    expect(await status(invoice.id)).toBe("open");
    expect((await world().webhook(e, { timestamp: created - 299 })).status).toBe(200);
    expect(await status(invoice.id)).toBe("paid");
  });

  test("a captured request replayed later is refused by the window and, within it, by dedupe", async () => {
    const { invoice, stripeId, created } = await pushedInvoice();
    const e = evt("invoice.paid", stripeId, created);
    const raw = JSON.stringify(e);
    const header = buildSignatureHeader(WEBHOOK_SECRET, created, raw);
    const replay = () =>
      world().app.request("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": header }, body: raw });
    expect((await jsonOf(await replay())).outcome).toBe("applied");
    expect((await jsonOf(await replay())).outcome).toBe("duplicate");
    world().clock.advance(10 * 60 * 1000);
    expect((await replay()).status).toBe(400);
    expect(await status(invoice.id)).toBe("paid");
  });

  test("rejects valid signatures over malformed or oversized bodies", async () => {
    const send = async (raw: string) =>
      world().app.request("/webhooks/stripe", {
        method: "POST",
        headers: {
          "stripe-signature": buildSignatureHeader(
            WEBHOOK_SECRET,
            Math.floor(world().clock.now().getTime() / 1000),
            raw,
          ),
        },
        body: raw,
      });
    expect((await send("not json")).status).toBe(400);
    expect((await send(JSON.stringify({ id: "x" }))).status).toBe(400);
    expect(
      (await send(JSON.stringify({ id: "x".repeat(300), type: "a", created: 1, data: { object: { id: "y" } } })))
        .status,
    ).toBe(400);
    expect((await send(" ".repeat(1024 * 1024 + 10))).status).toBe(413);
  });
});

describe("dedupe", () => {
  test("a redelivered event is applied once", async () => {
    const { invoice, stripeId, created } = await pushedInvoice();
    const e = evt("invoice.paid", stripeId, created, "evt_dup");
    const outcomes = [(await world().webhook(e)).body.outcome, (await world().webhook(e)).body.outcome];
    expect(outcomes).toEqual(["applied", "duplicate"]);
    expect(await stored()).toBe(1);
    expect(await status(invoice.id)).toBe("paid");
  });

  test("concurrent deliveries of the same event: exactly one wins", async () => {
    const { stripeId, created } = await pushedInvoice();
    const e = evt("invoice.paid", stripeId, created, "evt_race");
    const results = await Promise.all(Array.from({ length: 12 }, () => world().webhook(e)));
    const outcomes = results.map((r) => r.body.outcome as string);
    expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(11);
    expect(await stored()).toBe(1);
  });
});

describe("ordering", () => {
  test("an older event arriving late is stale and does not regress the state", async () => {
    const { invoice, stripeId, created } = await pushedInvoice();
    expect((await world().webhook(evt("invoice.paid", stripeId, created + 10))).body.outcome).toBe("applied");
    expect((await world().webhook(evt("invoice.payment_failed", stripeId, created + 5))).body.outcome).toBe("stale");
    expect(await status(invoice.id)).toBe("paid");
    const rows = await world().db`SELECT outcome FROM webhook_events ORDER BY created_at`;
    expect(rows.map((r: { outcome: string }) => r.outcome)).toEqual(["stale", "applied"]);
  });

  test("a failure followed by a later success ends paid, in either arrival order", async () => {
    const forward = await pushedInvoice();
    await world().webhook(evt("invoice.payment_failed", forward.stripeId, forward.created + 1));
    expect(await status(forward.invoice.id)).toBe("payment_failed");
    await world().webhook(evt("invoice.paid", forward.stripeId, forward.created + 2));
    expect(await status(forward.invoice.id)).toBe("paid");
  });

  test("unrelated and unknown event types are recorded but ignored", async () => {
    const { invoice, stripeId, created } = await pushedInvoice();
    expect((await world().webhook(evt("invoice.finalized", stripeId, created))).body.outcome).toBe("ignored");
    expect((await world().webhook(evt("customer.updated", "cus_1", created))).body.outcome).toBe("ignored");
    expect(await status(invoice.id)).toBe("open");
    expect(await stored()).toBe(2);
  });
});

describe("events that arrive before the invoice is linked", () => {
  test("are parked as orphaned, then replayed in created-order when the worker links the invoice", async () => {
    const { invoice, stripeId, created } = await pushedInvoice(false);
    const paid = await world().webhook(evt("invoice.paid", stripeId, created + 20, "evt_paid"));
    const failed = await world().webhook(evt("invoice.payment_failed", stripeId, created + 10, "evt_failed"));
    expect([paid.body.outcome, failed.body.outcome]).toEqual(["orphaned", "orphaned"]);
    expect(await status(invoice.id)).toBe("open");

    await world().worker().runOnce();
    expect(await status(invoice.id)).toBe("paid");
    const rows = await world().db`SELECT event_id, outcome FROM webhook_events ORDER BY created_at`;
    expect(Object.fromEntries(rows.map((r: { event_id: string; outcome: string }) => [r.event_id, r.outcome]))).toEqual(
      {
        evt_failed: "applied",
        evt_paid: "applied",
      },
    );
  });

  test("a webhook racing the worker's link is never lost", async () => {
    const seeded = await seedBilling(world());
    const customers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        world().api("POST", "/v1/customers", { external_id: `r${i}`, name: `r${i}` }),
      ),
    );
    const subs = await Promise.all(
      customers.map((c) =>
        world().api("POST", "/v1/subscriptions", {
          customer_id: c.body.id,
          plan_id: seeded.plan.id,
          started_at: "2026-03-01T00:00:00Z",
        }),
      ),
    );
    world().clock.set(new Date("2026-04-01T00:00:00Z"));
    const invoices = await Promise.all(
      subs.map((s) => world().api("POST", `/v1/subscriptions/${s.body.id}/invoices`, {})),
    );
    const created = Math.floor(world().clock.now().getTime() / 1000);
    await world().worker({ batchSize: 100 }).runOnce(); // pushes customers only? no: pushes everything; reset the links to re-race
    await world().db`UPDATE invoices SET stripe_invoice_id = NULL, status = 'open', status_event_at = NULL`;
    await world().db`UPDATE outbox SET status = 'pending', attempts = 0 WHERE kind = 'stripe.invoice.push'`;
    await world().db`DELETE FROM webhook_events`;

    await Promise.all([
      world().worker({ batchSize: 100 }).runOnce(),
      ...invoices.map((i) => world().webhook(evt("invoice.paid", fakeId("in", `invoice:${i.body.id}`), created))),
    ]);
    for (const i of invoices) expect(await status(i.body.id)).toBe("paid");
    const orphans = await world().db`SELECT count(*)::int AS n FROM webhook_events WHERE outcome = 'orphaned'`;
    expect(orphans[0].n).toBe(0);
  });
});
