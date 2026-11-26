import { describe, expect, test } from "bun:test";
import { event, seedBilling, useWorld } from "../harness.ts";

const world = useWorld();
const post = (events: unknown[]) => world().api("POST", "/v1/events", { events });

/** 12 000 calls, peak 12 seats, 30 distinct users (with repeats) in March. */
async function march(): Promise<void> {
  const users = Array.from({ length: 30 }, (_, i) =>
    event(`u${i}`, { meter: "active_users", properties: { user: `user-${i}` }, timestamp: "2026-03-08T00:00:00Z" }),
  );
  const repeats = [0, 1, 2].map((i) =>
    event(`ur${i}`, { meter: "active_users", properties: { user: `user-${i}` }, timestamp: "2026-03-09T00:00:00Z" }),
  );
  await post([
    event("c1", { quantity: 5000 }),
    event("c2", { quantity: 4000 }),
    event("c3", { quantity: 3000 }),
    event("s1", { meter: "peak_seats", quantity: 5 }),
    event("s2", { meter: "peak_seats", quantity: 12 }),
    event("s3", { meter: "peak_seats", quantity: 7 }),
    ...users,
    ...repeats,
  ]);
}

const lineAmounts = (invoice: { lines: { kind: string; meter: string | null; amount: string }[] }) =>
  Object.fromEntries(invoice.lines.map((l) => [l.meter ?? l.kind, l.amount]));

describe("invoice preview", () => {
  test("prices every meter exactly, with a per-tier breakdown", async () => {
    const { sub } = await seedBilling(world());
    await march();
    const res = await world().api("GET", `/v1/subscriptions/${sub.id}/invoice-preview`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("preview");
    expect(res.body.period_start).toBe("2026-03-01T00:00:00.000Z");
    expect(res.body.period_end).toBe("2026-04-01T00:00:00.000Z");
    // base 4900 + calls (9000*0.5 + 2000*0.2 = 4900) + seats (12 * 80 = 960) + users (ceil(30/25) * 1500 = 3000)
    expect(lineAmounts(res.body)).toEqual({
      base_fee: "4900",
      api_calls: "4900",
      peak_seats: "960",
      active_users: "3000",
    });
    expect(res.body.subtotal).toBe("13760");
    expect(res.body.amount_due).toBe("13760");
    const calls = res.body.lines.find((l: { meter: string }) => l.meter === "api_calls");
    expect(calls.breakdown.map((b: { label: string; quantity: string }) => [b.label, b.quantity])).toEqual([
      ["1-1000", "1000"],
      ["1001-10000", "9000"],
      ["10001+", "2000"],
    ]);
  });

  test("an idle customer owes only the base fee, and previewing writes nothing", async () => {
    const { sub } = await seedBilling(world());
    const res = await world().api("GET", `/v1/subscriptions/${sub.id}/invoice-preview`);
    expect(res.body.lines.map((l: { kind: string }) => l.kind)).toEqual(["base_fee"]);
    expect(res.body.amount_due).toBe("4900");
    expect(Number((await world().db`SELECT count(*)::int AS n FROM invoices`)[0].n)).toBe(0);
  });
});

describe("finalization", () => {
  test("cannot close a period that has not ended", async () => {
    const { sub } = await seedBilling(world());
    const res = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
    expect(res.body.error.details.period_end).toBe("2026-04-01T00:00:00.000Z");
  });

  test("closes the period, numbers the invoice, advances the subscription and enqueues the Stripe push", async () => {
    const { sub } = await seedBilling(world());
    await march();
    world().clock.set(new Date("2026-04-01T00:00:00Z"));
    const res = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: "1", status: "open", amount_due: "13760", stripe_invoice_id: null });

    const after = await world().api("GET", `/v1/subscriptions/${sub.id}`);
    expect(after.body.current_period_start).toBe("2026-04-01T00:00:00.000Z");
    expect(after.body.current_period_end).toBe("2026-05-01T00:00:00.000Z");
    const jobs = await world().db`SELECT kind, status FROM outbox WHERE kind = 'stripe.invoice.push'`;
    expect(jobs.map((j: { status: string }) => j.status)).toEqual(["pending"]);

    const fetched = await world().api("GET", `/v1/invoices/${res.body.id}`);
    expect(fetched.body).toEqual(res.body);

    const second = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {});
    expect(second.status).toBe(409); // April has not ended
  });

  test("repeating with period_start returns the same invoice", async () => {
    const { sub } = await seedBilling(world());
    world().clock.set(new Date("2026-04-01T00:00:00Z"));
    const first = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {
      period_start: "2026-03-01T00:00:00Z",
    });
    const again = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {
      period_start: "2026-03-01T00:00:00Z",
    });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.id).toBe(first.body.id);
    const wrong = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {
      period_start: "2026-02-01T00:00:00Z",
    });
    expect(wrong.status).toBe(409);
    const bad = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, "{nope");
    expect(bad.status).toBe(400);
  });

  test("concurrent finalizations create exactly one invoice, one usage deduction and one job", async () => {
    const { sub, customer } = await seedBilling(world());
    await march();
    await world().api("POST", `/v1/customers/${customer.id}/credits`, {
      amount: 1000,
      currency: "usd",
      reason: "welcome",
    });
    world().clock.set(new Date("2026-04-01T00:00:00Z"));
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, { period_start: "2026-03-01T00:00:00Z" }),
      ),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(7);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(Number((await world().db`SELECT count(*)::int AS n FROM invoices`)[0].n)).toBe(1);
    expect(
      Number((await world().db`SELECT count(*)::int AS n FROM outbox WHERE kind = 'stripe.invoice.push'`)[0].n),
    ).toBe(1);
    const credits = await world().api("GET", `/v1/customers/${customer.id}/credits`);
    expect(credits.body.balances.usd).toBe("0"); // consumed once, not eight times
  });

  test("concurrent finalizations without period_start still yield a single invoice", async () => {
    const { sub } = await seedBilling(world());
    world().clock.set(new Date("2026-04-01T00:00:00Z"));
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {})),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(5);
    expect(Number((await world().db`SELECT count(*)::int AS n FROM invoices`)[0].n)).toBe(1);
  });

  test("consecutive periods get consecutive numbers and only their own usage", async () => {
    const { sub } = await seedBilling(world());
    await post([event("m1", { quantity: 2000, timestamp: "2026-03-10T00:00:00Z" })]);
    world().clock.set(new Date("2026-04-05T00:00:00Z"));
    await post([event("a1", { quantity: 3000, timestamp: "2026-04-02T00:00:00Z" })]);
    const one = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {});
    world().clock.set(new Date("2026-05-01T00:00:00Z"));
    const two = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {});
    expect([one.body.number, two.body.number]).toEqual(["1", "2"]);
    expect(lineAmounts(one.body).api_calls).toBe("500"); // 1000 free, 1000 * 0.5
    expect(lineAmounts(two.body).api_calls).toBe("1000"); // 1000 free, 2000 * 0.5
  });
});

describe("credits", () => {
  test("are applied to the invoice and consumed from the ledger", async () => {
    const { sub, customer } = await seedBilling(world());
    await march();
    const grant = await world().api("POST", `/v1/customers/${customer.id}/credits`, {
      amount: 5000,
      currency: "USD",
      reason: "goodwill",
    });
    expect(grant.status).toBe(201);
    world().clock.set(new Date("2026-04-01T00:00:00Z"));
    const invoice = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {});
    expect(invoice.body).toMatchObject({ subtotal: "13760", credits_applied: "5000", amount_due: "8760" });
    const ledger = await world().api("GET", `/v1/customers/${customer.id}/credits`);
    expect(ledger.body.balances.usd).toBe("0");
    expect(ledger.body.entries.map((e: { amount: string }) => e.amount)).toEqual(["5000", "-5000"]);
    expect(ledger.body.entries[1].invoice_id).toBe(invoice.body.id);
  });

  test("a large balance covers the invoice and the remainder carries forward", async () => {
    const { sub, customer } = await seedBilling(world());
    await world().api("POST", `/v1/customers/${customer.id}/credits`, {
      amount: 10_000,
      currency: "usd",
      reason: "prepay",
    });
    world().clock.set(new Date("2026-04-01T00:00:00Z"));
    const invoice = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {});
    expect(invoice.body).toMatchObject({ subtotal: "4900", credits_applied: "4900", amount_due: "0" });
    const ledger = await world().api("GET", `/v1/customers/${customer.id}/credits`);
    expect(ledger.body.balances.usd).toBe("5100");
  });

  test("credits in another currency are not spent", async () => {
    const { sub, customer } = await seedBilling(world());
    await world().api("POST", `/v1/customers/${customer.id}/credits`, { amount: 10_000, currency: "eur", reason: "x" });
    world().clock.set(new Date("2026-04-01T00:00:00Z"));
    const invoice = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {});
    expect(invoice.body.credits_applied).toBe("0");
  });

  test("grants are idempotent by key and reject a reused key with different terms", async () => {
    const { customer } = await seedBilling(world());
    const body = { amount: 700, currency: "usd", reason: "promo", idempotency_key: "promo-1" };
    const first = await world().api("POST", `/v1/customers/${customer.id}/credits`, body);
    const replay = await world().api("POST", `/v1/customers/${customer.id}/credits`, body);
    expect([first.status, replay.status]).toEqual([201, 200]);
    expect(replay.body.id).toBe(first.body.id);
    const clash = await world().api("POST", `/v1/customers/${customer.id}/credits`, { ...body, amount: 800 });
    expect(clash.status).toBe(409);
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () =>
        world().api("POST", `/v1/customers/${customer.id}/credits`, { ...body, idempotency_key: "promo-2" }),
      ),
    );
    expect(concurrent.filter((r) => r.status === 201)).toHaveLength(1);
    const ledger = await world().api("GET", `/v1/customers/${customer.id}/credits`);
    expect(ledger.body.balances.usd).toBe("1400");
    expect((await world().api("POST", `/v1/customers/${customer.id}/credits`, { ...body, amount: 0 })).status).toBe(
      400,
    );
  });
});

describe("plan changes and proration", () => {
  async function pricierPlan() {
    return (
      await world().api("POST", "/v1/plans", {
        code: "scale",
        currency: "usd",
        base_fee: 9900,
        items: [{ meter: "api_calls", pricing: { model: "graduated", tiers: [{ up_to: null, unit_amount: "0.1" }] } }],
      })
    ).body;
  }

  test("an upgrade half way through bills the time-weighted base fee and the new plan's usage rates", async () => {
    const { sub } = await seedBilling(world());
    const scale = await pricierPlan();
    await post([event("c1", { quantity: 2000 })]);
    world().clock.set(new Date("2026-03-16T12:00:00Z")); // exactly half of March
    const change = await world().api("POST", `/v1/subscriptions/${sub.id}/change-plan`, { plan_id: scale.id });
    expect(change.status).toBe(200);
    expect(change.body.plan_id).toBe(scale.id);
    expect(change.body.proration_adjustment).toBe("-2500"); // (4900 - 9900) * 1/2

    const preview = await world().api("GET", `/v1/subscriptions/${sub.id}/invoice-preview`);
    expect(lineAmounts(preview.body)).toMatchObject({ base_fee: "9900", api_calls: "200" });
    expect(preview.body.lines.find((l: { kind: string }) => l.kind === "adjustment").amount).toBe("-2500");
    expect(preview.body.subtotal).toBe("7600");

    world().clock.set(new Date("2026-04-01T00:00:00Z"));
    const invoice = await world().api("POST", `/v1/subscriptions/${sub.id}/invoices`, {});
    expect(invoice.body.amount_due).toBe("7600");
    // Adjustments are consumed by the invoice that carries them.
    const next = await world().api("GET", `/v1/subscriptions/${sub.id}/invoice-preview`);
    expect(next.body.lines.map((l: { kind: string }) => l.kind)).not.toContain("adjustment");
  });

  test("a downgrade queues a positive adjustment for the time spent on the pricier plan", async () => {
    const { sub, plan } = await seedBilling(world());
    const scale = await pricierPlan();
    await world().api("POST", `/v1/subscriptions/${sub.id}/change-plan`, { plan_id: scale.id }); // at Mar 20
    world().clock.set(new Date("2026-03-25T00:00:00Z"));
    const back = await world().api("POST", `/v1/subscriptions/${sub.id}/change-plan`, { plan_id: plan.id });
    expect(BigInt(back.body.proration_adjustment) > 0n).toBe(true);
    const items = await world().db`SELECT amount_minor::text AS a FROM pending_items ORDER BY created_at`;
    expect(items).toHaveLength(2);
  });

  test("rejects a no-op change, an unknown plan and a currency switch", async () => {
    const { sub, plan } = await seedBilling(world());
    expect((await world().api("POST", `/v1/subscriptions/${sub.id}/change-plan`, { plan_id: plan.id })).status).toBe(
      400,
    );
    expect(
      (await world().api("POST", `/v1/subscriptions/${sub.id}/change-plan`, { plan_id: crypto.randomUUID() })).status,
    ).toBe(404);
    const eur = (await world().api("POST", "/v1/plans", { code: "eu", currency: "eur", base_fee: 1, items: [] })).body;
    expect((await world().api("POST", `/v1/subscriptions/${sub.id}/change-plan`, { plan_id: eur.id })).status).toBe(
      400,
    );
  });
});

describe("subscriptions and catalog", () => {
  test("one subscription per customer and no start in the future", async () => {
    const { customer, plan } = await seedBilling(world());
    expect(
      (await world().api("POST", "/v1/subscriptions", { customer_id: customer.id, plan_id: plan.id })).status,
    ).toBe(409);
    const other = (await world().api("POST", "/v1/customers", { external_id: "c2", name: "Other" })).body;
    const future = await world().api("POST", "/v1/subscriptions", {
      customer_id: other.id,
      plan_id: plan.id,
      started_at: "2027-01-01T00:00:00Z",
    });
    expect(future.status).toBe(400);
    const missing = await world().api("POST", "/v1/subscriptions", {
      customer_id: crypto.randomUUID(),
      plan_id: plan.id,
    });
    expect(missing.status).toBe(404);
    const noPlan = await world().api("POST", "/v1/subscriptions", {
      customer_id: other.id,
      plan_id: crypto.randomUUID(),
    });
    expect(noPlan.status).toBe(404);
  });

  test("duplicate codes conflict; invalid pricing and unknown meters are rejected", async () => {
    await seedBilling(world());
    expect((await world().api("POST", "/v1/meters", { code: "api_calls", aggregation: "sum" })).status).toBe(409);
    expect((await world().api("POST", "/v1/meters", { code: "bad", aggregation: "unique" })).status).toBe(400);
    expect((await world().api("POST", "/v1/meters", { code: "bad", aggregation: "sum", property: "x" })).status).toBe(
      400,
    );
    const tiers = (t: unknown) => ({
      code: "p2",
      currency: "usd",
      items: [{ meter: "api_calls", pricing: { model: "volume", tiers: t } }],
    });
    expect((await world().api("POST", "/v1/plans", tiers([{ up_to: 10, unit_amount: "1" }]))).status).toBe(400);
    expect((await world().api("POST", "/v1/plans", tiers([{ up_to: null, unit_amount: 1 }]))).status).toBe(400);
    const unknown = await world().api("POST", "/v1/plans", {
      code: "p3",
      currency: "usd",
      items: [{ meter: "ghost", pricing: { model: "package", package_size: 1, package_amount: "1" } }],
    });
    expect(unknown.status).toBe(400);
    const dup = { code: "growth", currency: "usd", items: [] };
    expect((await world().api("POST", "/v1/plans", dup)).status).toBe(409);
    const twice = {
      code: "p4",
      currency: "usd",
      items: [
        { meter: "api_calls", pricing: { model: "package", package_size: 1, package_amount: "1" } },
        { meter: "api_calls", pricing: { model: "package", package_size: 1, package_amount: "1" } },
      ],
    };
    expect((await world().api("POST", "/v1/plans", twice)).status).toBe(400);
    expect((await world().api("POST", "/v1/customers", { external_id: "cust-1", name: "again" })).status).toBe(409);
    const plan = await world().api("GET", `/v1/plans/${(await world().db`SELECT id FROM plans LIMIT 1`)[0].id}`);
    expect(plan.body.items.map((i: { meter: string }) => i.meter)).toEqual(["active_users", "api_calls", "peak_seats"]);
    const meters = await world().api("GET", "/v1/meters");
    expect(meters.body.data).toHaveLength(3);
  });
});
