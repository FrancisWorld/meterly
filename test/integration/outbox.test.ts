import { describe, expect, test } from "bun:test";
import { claim } from "../../src/services/outbox.ts";
import { backoffMs } from "../../src/worker/outbox-worker.ts";
import { event, seedBilling, useWorld } from "../harness.ts";

const world = useWorld();

const outbox = () => world().db`SELECT kind, status, attempts, last_error, next_attempt_at FROM outbox ORDER BY id`;

async function closedInvoice() {
  const seeded = await seedBilling(world());
  await world().api("POST", "/v1/events", { events: [event("c1", { quantity: 3000 })] });
  world().clock.set(new Date("2026-04-01T00:00:00Z"));
  const invoice = (await world().api("POST", `/v1/subscriptions/${seeded.sub.id}/invoices`, {})).body;
  return { ...seeded, invoice };
}

describe("outbox -> Stripe", () => {
  test("customer creation is mirrored to Stripe and the id is stored", async () => {
    const { customer } = await seedBilling(world());
    const summary = await world().worker().runOnce();
    expect(summary).toMatchObject({ claimed: 1, done: 1 });
    const stored = await world().api("GET", `/v1/customers/${customer.id}`);
    expect(stored.body.stripe_customer_id).toStartWith("cus_fake_");
    expect(world().stripe.customers.size).toBe(1);
    expect([...world().stripe.customers.values()][0]?.metadata).toEqual({ meterly_customer_id: customer.id });
  });

  test("a rolled-back customer insert leaves no job behind", async () => {
    await seedBilling(world());
    await world().api("POST", "/v1/customers", { external_id: "cust-1", name: "dup" });
    expect(await outbox()).toHaveLength(1);
  });

  test("a finalized invoice is pushed with credit lines so Stripe's total equals the amount due", async () => {
    const { customer, invoice } = await closedInvoice();
    await world().api("POST", `/v1/customers/${customer.id}/credits`, { amount: 100, currency: "usd", reason: "x" });
    // The credit was granted after finalization, so it is not on the invoice: Stripe sees exactly the lines.
    await world().worker().runOnce();
    const pushed = [...world().stripe.invoices.values()][0];
    expect(pushed?.currency).toBe("usd");
    expect(pushed?.lines.reduce((sum, l) => sum + l.amountMinor, 0n)).toBe(BigInt(invoice.amount_due));
    expect(pushed?.metadata).toEqual({ meterly_invoice_id: invoice.id, meterly_invoice_number: "1" });
    const stored = await world().api("GET", `/v1/invoices/${invoice.id}`);
    expect(stored.body.stripe_invoice_id).toStartWith("in_fake_");
    expect((await outbox()).every((j: { status: string }) => j.status === "done")).toBe(true);
  });

  test("applied credits become a negative line", async () => {
    const seeded = await seedBilling(world());
    await world().api("POST", `/v1/customers/${seeded.customer.id}/credits`, {
      amount: 1200,
      currency: "usd",
      reason: "x",
    });
    world().clock.set(new Date("2026-04-01T00:00:00Z"));
    const invoice = (await world().api("POST", `/v1/subscriptions/${seeded.sub.id}/invoices`, {})).body;
    await world().worker().runOnce();
    const lines = [...world().stripe.invoices.values()][0]?.lines ?? [];
    expect(lines.at(-1)).toEqual({ description: "Account credit applied", amountMinor: -1200n });
    expect(lines.reduce((s, l) => s + l.amountMinor, 0n)).toBe(BigInt(invoice.amount_due));
  });

  test("transient failures retry with exponential backoff and then succeed", async () => {
    await closedInvoice();
    await world().worker().runOnce(); // customer sync + (no failure yet) clean slate
    const w = world().worker({ baseBackoffMs: 1000 });
    await world()
      .db`UPDATE outbox SET status = 'pending', done_at = NULL, attempts = 0 WHERE kind = 'stripe.invoice.push'`;
    await world().db`UPDATE invoices SET stripe_invoice_id = NULL`;
    world().stripe.failNext(2, { retryable: true });

    expect(await w.runOnce()).toMatchObject({ claimed: 1, retried: 1 });
    expect(await w.runOnce()).toMatchObject({ claimed: 0 }); // not due yet
    world().clock.advance(1000);
    expect(await w.runOnce()).toMatchObject({ claimed: 1, retried: 1 });
    world().clock.advance(1999);
    expect(await w.runOnce()).toMatchObject({ claimed: 0 }); // second delay is 2000ms
    world().clock.advance(1);
    expect(await w.runOnce()).toMatchObject({ claimed: 1, done: 1 });
    const [job] = (await outbox()).filter((j: { kind: string }) => j.kind === "stripe.invoice.push");
    expect(job).toMatchObject({ status: "done", attempts: 3, last_error: null });
  });

  test("a permanent failure goes straight to dead with the error recorded", async () => {
    await closedInvoice();
    await world().worker().runOnce();
    await world().db`UPDATE outbox SET status = 'pending', attempts = 0 WHERE kind = 'stripe.invoice.push'`;
    await world().db`UPDATE invoices SET stripe_invoice_id = NULL`;
    world().stripe.failNext(1, { retryable: false });
    expect(await world().worker().runOnce()).toMatchObject({ dead: 1 });
    const [job] = (await outbox()).filter((j: { kind: string }) => j.kind === "stripe.invoice.push");
    expect(job).toMatchObject({ status: "dead", attempts: 1, last_error: "injected failure" });
    world().clock.advance(86_400_000);
    expect(await world().worker().runOnce()).toMatchObject({ claimed: 0 });
  });

  test("gives up after the maximum number of attempts", async () => {
    await seedBilling(world());
    world().stripe.failNext(100, { retryable: true });
    const w = world().worker({ maxAttempts: 3, baseBackoffMs: 10 });
    const summaries = [];
    for (let i = 0; i < 3; i++) {
      summaries.push(await w.runOnce());
      world().clock.advance(1000);
    }
    expect(summaries.map((s) => [s.retried, s.dead])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ]);
    expect((await outbox())[0]).toMatchObject({ status: "dead", attempts: 3 });
  });

  test("timeout after Stripe succeeded: the retry reuses the idempotency key and creates nothing twice", async () => {
    await closedInvoice();
    const w = world().worker({ baseBackoffMs: 10, batchSize: 1 });
    await w.runOnce(); // customer job only
    world().stripe.failNext(1, { mode: "after", retryable: true }); // next call succeeds at Stripe but "times out"
    expect(await w.runOnce()).toMatchObject({ retried: 1 });
    expect(world().stripe.invoices.size).toBe(1);
    world().clock.advance(1000);
    expect(await w.runOnce()).toMatchObject({ done: 1 });
    expect(world().stripe.invoices.size).toBe(1);
    const invoiceCalls = world().stripe.calls.filter((c) => c.operation === "createInvoice");
    expect(invoiceCalls.map((c) => c.replayed)).toEqual([false, true]);
    expect(new Set(invoiceCalls.map((c) => c.idempotencyKey)).size).toBe(1);
  });

  test("pushing an invoice before the customer sync ran creates the customer once", async () => {
    await closedInvoice();
    const w = world().worker({ batchSize: 1 });
    // Make the invoice job run first by pretending the customer job already ran elsewhere.
    await world().db`UPDATE outbox SET status = 'done' WHERE kind = 'stripe.customer.sync'`;
    await w.runOnce();
    await world().db`UPDATE outbox SET status = 'pending' WHERE kind = 'stripe.customer.sync'`;
    await w.runOnce();
    expect(world().stripe.customers.size).toBe(1);
    expect(world().stripe.invoices.size).toBe(1);
  });

  test("three concurrent workers deliver every job exactly once", async () => {
    const created = await Promise.all(
      Array.from({ length: 45 }, (_, i) =>
        world().api("POST", "/v1/customers", { external_id: `bulk-${i}`, name: `c${i}` }),
      ),
    );
    expect(created.every((r) => r.status === 201)).toBe(true);
    const workers = [1, 2, 3].map(() => world().worker({ batchSize: 7 }));
    const totals = await Promise.all(
      workers.map(async (w) => {
        let done = 0;
        for (;;) {
          const s = await w.runOnce();
          if (s.claimed === 0) return done;
          done += s.done;
        }
      }),
    );
    expect(totals.reduce((a, b) => a + b, 0)).toBe(45);
    const calls = world().stripe.calls;
    expect(calls).toHaveLength(45); // no job was delivered twice
    expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(45);
    expect(world().stripe.customers.size).toBe(45);
    expect(
      (await outbox()).every((j: { status: string; attempts: number }) => j.status === "done" && j.attempts === 1),
    ).toBe(true);
  });

  test("a crashed worker's lease expires and another worker takes the job over", async () => {
    await seedBilling(world());
    const claimed = await claim(world().db, world().clock.now(), 10, 60); // "worker A" leases, then dies
    expect(claimed).toHaveLength(1);
    expect(await world().worker().runOnce()).toMatchObject({ claimed: 0 });
    world().clock.advance(61_000);
    expect(await world().worker().runOnce()).toMatchObject({ claimed: 1, done: 1 });
    expect((await outbox())[0]).toMatchObject({ status: "done", attempts: 2 });
  });

  test("start() polls in the background and stop() waits for the batch in flight", async () => {
    await seedBilling(world());
    const w = world().worker({ pollMs: 5 });
    w.start();
    w.start(); // idempotent
    const deadline = Date.now() + 5000;
    while (world().stripe.customers.size === 0 && Date.now() < deadline) await Bun.sleep(10);
    await w.stop();
    expect(world().stripe.customers.size).toBe(1);
    expect((await outbox())[0]?.status).toBe("done");
  });
});

describe("backoffMs", () => {
  test("doubles per attempt and respects the cap", () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 1000, 60_000))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffMs(30, 1000, 60_000)).toBe(60_000);
    expect(backoffMs(0, 1000, 60_000)).toBe(1000);
  });
});
