import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { computeInvoice, type InvoiceInput } from "../../src/domain/invoice.ts";
import { decideInvoiceEvent, type InvoiceState, type InvoiceStatus } from "../../src/domain/invoice-events.ts";
import { PRICE_SCALE } from "../../src/domain/money.ts";

const flat = (unit: bigint) => ({
  model: "graduated" as const,
  tiers: [{ upTo: null, unitAmount: unit * PRICE_SCALE, flatAmount: 0n }],
});

const base: InvoiceInput = {
  baseFeeMinor: 5000n,
  usage: [{ meter: "calls", aggregation: "sum", quantity: 100n, pricing: flat(2n) }],
  adjustments: [],
  creditBalanceMinor: 0n,
};

describe("computeInvoice", () => {
  test("sums base fee, usage and adjustments", () => {
    const t = computeInvoice({ ...base, adjustments: [{ description: "proration", amountMinor: -700n }] });
    expect(t.lines.map((l) => [l.kind, l.amountMinor])).toEqual([
      ["base_fee", 5000n],
      ["usage", 200n],
      ["adjustment", -700n],
    ]);
    expect(t.subtotalMinor).toBe(4500n);
    expect(t.amountDueMinor).toBe(4500n);
  });

  test("skips zero base fee and zero usage lines", () => {
    const t = computeInvoice({ ...base, baseFeeMinor: 0n, usage: base.usage.map((u) => ({ ...u, quantity: 0n })) });
    expect(t.lines).toEqual([]);
    expect(t.amountDueMinor).toBe(0n);
  });

  test("credits are applied up to the subtotal and never beyond", () => {
    expect(computeInvoice({ ...base, creditBalanceMinor: 1000n })).toMatchObject({
      creditsAppliedMinor: 1000n,
      amountDueMinor: 4200n,
    });
    expect(computeInvoice({ ...base, creditBalanceMinor: 99_999n })).toMatchObject({
      creditsAppliedMinor: 5200n,
      amountDueMinor: 0n,
    });
  });

  test("invariants: due + credits = subtotal; credits never exceed the balance", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 100n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        (fee, qty, percent, credit) => {
          const adj = -((fee * percent) / 100n); // proration never exceeds the base fee it corrects
          const t = computeInvoice({
            baseFeeMinor: fee,
            usage: [{ meter: "m", aggregation: "sum", quantity: qty, pricing: flat(3n) }],
            adjustments: [{ description: "x", amountMinor: adj }],
            creditBalanceMinor: credit,
          });
          expect(t.amountDueMinor >= 0n && t.creditsAppliedMinor >= 0n).toBe(true);
          expect(t.creditsAppliedMinor <= credit).toBe(true);
          expect(t.amountDueMinor + t.creditsAppliedMinor).toBe(t.subtotalMinor);
        },
      ),
    );
  });
});

describe("decideInvoiceEvent", () => {
  const at = (s: number): Date => new Date(s * 1000);
  const open: InvoiceState = { status: "open", statusEventAt: null };

  test("applies known events and ignores the rest", () => {
    expect(decideInvoiceEvent(open, { type: "invoice.paid", created: at(10) })).toEqual({
      action: "apply",
      status: "paid",
    });
    expect(decideInvoiceEvent(open, { type: "invoice.voided", created: at(10) })).toEqual({
      action: "apply",
      status: "void",
    });
    expect(decideInvoiceEvent(open, { type: "invoice.finalized", created: at(10) })).toEqual({ action: "ignore" });
  });

  test("an older event never overwrites a newer state", () => {
    const paid: InvoiceState = { status: "paid", statusEventAt: at(20) };
    expect(decideInvoiceEvent(paid, { type: "invoice.payment_failed", created: at(10) })).toEqual({ action: "stale" });
  });

  test("ties are broken by status rank, so money received wins", () => {
    const failed: InvoiceState = { status: "payment_failed", statusEventAt: at(20) };
    expect(decideInvoiceEvent(failed, { type: "invoice.paid", created: at(20) })).toEqual({
      action: "apply",
      status: "paid",
    });
    const paid: InvoiceState = { status: "paid", statusEventAt: at(20) };
    expect(decideInvoiceEvent(paid, { type: "invoice.payment_failed", created: at(20) })).toEqual({ action: "stale" });
  });

  test("any delivery order converges to the same final state", () => {
    const types = ["invoice.paid", "invoice.payment_failed", "invoice.voided", "invoice.finalized"];
    const eventArb = fc.record({ type: fc.constantFrom(...types), created: fc.integer({ min: 1, max: 6 }).map(at) });
    const run = (events: { type: string; created: Date }[]): InvoiceState => {
      let state: InvoiceState = open;
      for (const e of events) {
        const d = decideInvoiceEvent(state, e);
        if (d.action === "apply") state = { status: d.status as InvoiceStatus, statusEventAt: e.created };
      }
      return state;
    };
    fc.assert(
      fc.property(
        fc
          .array(eventArb, { minLength: 1, maxLength: 8 })
          .chain((evs) =>
            fc.tuple(fc.constant(evs), fc.shuffledSubarray(evs, { minLength: evs.length, maxLength: evs.length })),
          ),
        ([a, b]) => {
          expect(run(a)).toEqual(run(b));
        },
      ),
    );
  });
});
