import { describe, expect, test } from "bun:test";
import { FakeStripe } from "../../src/stripe/fake.ts";
import { StripeError } from "../../src/stripe/gateway.ts";

const customer = { name: "Acme", email: null, metadata: { a: "1" } };

describe("FakeStripe", () => {
  test("ids derive deterministically from the idempotency key", async () => {
    const one = await new FakeStripe().createCustomer(customer, { idempotencyKey: "k1" });
    const two = await new FakeStripe().createCustomer(customer, { idempotencyKey: "k1" });
    expect(one.id).toBe(two.id);
    expect(one.id).toStartWith("cus_fake_");
  });

  test("a repeated key replays the first response without creating a second resource", async () => {
    const stripe = new FakeStripe();
    const first = await stripe.createCustomer(customer, { idempotencyKey: "k1" });
    const second = await stripe.createCustomer(customer, { idempotencyKey: "k1" });
    expect(second).toEqual(first);
    expect(stripe.customers.size).toBe(1);
    expect(stripe.calls.map((c) => c.replayed)).toEqual([false, true]);
  });

  test("reusing a key with different parameters is a permanent error", async () => {
    const stripe = new FakeStripe();
    await stripe.createCustomer(customer, { idempotencyKey: "k1" });
    const error = await stripe.createCustomer({ ...customer, name: "Other" }, { idempotencyKey: "k1" }).catch((e) => e);
    expect(error).toBeInstanceOf(StripeError);
    expect(error).toMatchObject({ code: "idempotency_error", retryable: false });
  });

  test("invoices need an existing customer and fingerprint bigint amounts", async () => {
    const stripe = new FakeStripe();
    const input = {
      customerId: "cus_nope",
      currency: "usd",
      lines: [{ description: "x", amountMinor: 5n }],
      metadata: {},
    };
    expect(await stripe.createInvoice(input, { idempotencyKey: "i1" }).catch((e) => e)).toMatchObject({
      code: "resource_missing",
      retryable: false,
    });
    const c = await stripe.createCustomer(customer, { idempotencyKey: "k1" });
    const ok = { ...input, customerId: c.id };
    const inv = await stripe.createInvoice(ok, { idempotencyKey: "i2" });
    expect(inv.status).toBe("open");
    expect(
      await stripe
        .createInvoice({ ...ok, lines: [{ description: "x", amountMinor: 6n }] }, { idempotencyKey: "i2" })
        .catch((e) => e),
    ).toMatchObject({
      code: "idempotency_error",
    });
  });

  test("failures before the operation leave no trace; failures after it keep the effect", async () => {
    const stripe = new FakeStripe();
    stripe.failNext(1, { mode: "before", retryable: true });
    await expect(stripe.createCustomer(customer, { idempotencyKey: "k1" })).rejects.toMatchObject({ retryable: true });
    expect(stripe.customers.size).toBe(0);

    stripe.failNext(1, { mode: "after", retryable: true });
    await expect(stripe.createCustomer(customer, { idempotencyKey: "k2" })).rejects.toBeInstanceOf(StripeError);
    expect(stripe.customers.size).toBe(1);
    const retry = await stripe.createCustomer(customer, { idempotencyKey: "k2" });
    expect(stripe.customers.size).toBe(1);
    expect(retry.id).toStartWith("cus_fake_");
  });

  test("failNext(n) fails exactly n calls", async () => {
    const stripe = new FakeStripe();
    stripe.failNext(2);
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) => stripe.createCustomer(customer, { idempotencyKey: `k${i}` })),
    );
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "fulfilled"]);
  });
});
