import { encodePricing } from "../domain/pricing-codec.ts";
import type { Meter, Plan } from "../services/catalog.ts";
import type { CreditEntry } from "../services/credits.ts";
import type { Customer } from "../services/customers.ts";
import type { IngestResult } from "../services/ingestion.ts";
import type { Invoice, InvoiceDraft } from "../services/invoicing.ts";
import type { Subscription } from "../services/subscriptions.ts";

export const meterView = (m: Meter) => ({ id: m.id, code: m.code, aggregation: m.aggregation, property: m.property });

export const planView = (p: Plan) => ({
  id: p.id,
  code: p.code,
  currency: p.currency,
  base_fee: p.baseFeeMinor,
  items: p.items.map((i) => ({ meter: i.meterCode, aggregation: i.aggregation, pricing: encodePricing(i.pricing) })),
});

export const customerView = (c: Customer) => ({
  id: c.id,
  external_id: c.externalId,
  name: c.name,
  email: c.email,
  stripe_customer_id: c.stripeCustomerId,
});

export const creditView = (e: CreditEntry) => ({
  id: e.id,
  currency: e.currency,
  amount: e.amountMinor,
  reason: e.reason,
  invoice_id: e.invoiceId,
  created_at: e.createdAt,
});

export const subscriptionView = (s: Subscription) => ({
  id: s.id,
  customer_id: s.customerId,
  plan_id: s.planId,
  billing_anchor: s.billingAnchor,
  current_period_start: s.currentPeriodStart,
  current_period_end: s.currentPeriodEnd,
});

const draftFields = (d: InvoiceDraft) => ({
  subscription_id: d.subscriptionId,
  customer_id: d.customerId,
  currency: d.currency,
  period_start: d.periodStart,
  period_end: d.periodEnd,
  lines: d.lines.map((l) => ({
    kind: l.kind,
    description: l.description,
    meter: l.meter,
    quantity: l.quantity,
    amount: l.amountMinor,
    breakdown: l.breakdown.map((b) => ({
      label: b.label,
      quantity: b.quantity,
      unit_amount: b.unitAmount,
      flat_amount: b.flatAmount,
    })),
  })),
  subtotal: d.subtotalMinor,
  credits_applied: d.creditsAppliedMinor,
  amount_due: d.amountDueMinor,
});

export const previewView = (d: InvoiceDraft) => ({ status: "preview", ...draftFields(d) });

export const invoiceView = (i: Invoice) => ({
  id: i.id,
  number: i.number,
  status: i.status,
  stripe_invoice_id: i.stripeInvoiceId,
  finalized_at: i.finalizedAt,
  ...draftFields(i),
});

export const ingestView = (r: IngestResult) => {
  switch (r.status) {
    case "accepted":
      return { idempotency_key: r.idempotencyKey, status: r.status, late: r.late, effective_at: r.effectiveAt };
    case "duplicate":
      return { idempotency_key: r.idempotencyKey, status: r.status };
    default:
      return { idempotency_key: r.idempotencyKey, status: r.status, reason: r.reason };
  }
};
