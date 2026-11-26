import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.ts";
import type { Db, Queryable } from "../db/client.ts";
import { asJson } from "../db/client.ts";
import { computeInvoice, type InvoiceLine, type InvoiceTotals } from "../domain/invoice.ts";
import type { InvoiceStatus } from "../domain/invoice-events.ts";
import { MAX_INT64 } from "../domain/money.ts";
import { periodAt } from "../domain/periods.ts";
import { conflict, notFound } from "../errors.ts";
import { getPlan } from "./catalog.ts";
import { balance } from "./credits.ts";
import { enqueue } from "./outbox.ts";
import { type Subscription, toSubscription } from "./subscriptions.ts";
import { aggregatePeriod, pick } from "./usage.ts";

export interface InvoiceDraft extends InvoiceTotals {
  subscriptionId: string;
  customerId: string;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface Invoice extends InvoiceDraft {
  id: string;
  number: bigint;
  status: InvoiceStatus;
  stripeInvoiceId: string | null;
  finalizedAt: Date;
}

const SUB_COLUMNS = `id, customer_id, plan_id, billing_anchor, period_index, current_period_start, current_period_end`;

async function assemble(
  db: Queryable,
  tenantId: string,
  sub: Subscription,
  period: { start: Date; end: Date },
): Promise<{ draft: InvoiceDraft; pendingIds: string[] }> {
  const plan = await getPlan(db, tenantId, sub.planId);
  const usage = await aggregatePeriod(db, sub.customerId, period.start, period.end);
  const pending = await db`SELECT id, description, amount_minor::text AS amount FROM pending_items
                           WHERE subscription_id = ${sub.id} AND invoice_id IS NULL ORDER BY created_at, id`;
  const creditBalanceMinor = await balance(db, sub.customerId, plan.currency);
  const totals = computeInvoice({
    baseFeeMinor: plan.baseFeeMinor,
    usage: plan.items.map((item) => ({
      meter: item.meterCode,
      aggregation: item.aggregation,
      quantity: pick(item.aggregation, usage.get(item.meterId)),
      pricing: item.pricing,
    })),
    adjustments: pending.map((p: { description: string; amount: string }) => ({
      description: p.description,
      amountMinor: BigInt(p.amount),
    })),
    creditBalanceMinor,
  });
  // Amounts are stored as bigint; refuse to price what the schema cannot represent instead of failing at INSERT.
  if (totals.subtotalMinor > MAX_INT64 || totals.lines.some((line) => line.amountMinor > MAX_INT64)) {
    throw conflict("invoice amount exceeds the supported range", { maximum: MAX_INT64.toString() });
  }
  return {
    draft: {
      ...totals,
      subscriptionId: sub.id,
      customerId: sub.customerId,
      currency: plan.currency,
      periodStart: period.start,
      periodEnd: period.end,
    },
    pendingIds: pending.map((p: { id: string }) => p.id),
  };
}

/** What the invoice for the current period would look like right now. Nothing is written. */
export async function previewInvoice(db: Db, tenantId: string, subscriptionId: string): Promise<InvoiceDraft> {
  const rows = await db.unsafe(`SELECT ${SUB_COLUMNS} FROM subscriptions WHERE id = $1 AND tenant_id = $2`, [
    subscriptionId,
    tenantId,
  ]);
  if (!rows[0]) throw notFound("subscription");
  const sub = toSubscription(rows[0]);
  const { draft } = await assemble(db, tenantId, sub, { start: sub.currentPeriodStart, end: sub.currentPeriodEnd });
  return draft;
}

export interface FinalizeResult {
  invoice: Invoice;
  /** False when the invoice for the requested period already existed. */
  created: boolean;
}

/**
 * Close a billing period: price its usage, consume credits, persist the invoice, move the usage
 * watermark and the subscription to the next period, and enqueue the Stripe push, all in one
 * transaction. The customer row is locked FOR UPDATE first, which waits for in-flight ingestion
 * batches and makes later ones see the new watermark.
 *
 * Passing `periodStart` makes the call idempotent: a repeat returns the existing invoice.
 */
export async function finalizeInvoice(
  db: Db,
  clock: Clock,
  tenantId: string,
  subscriptionId: string,
  periodStart?: Date,
): Promise<FinalizeResult> {
  return db.begin(async (tx) => {
    const owner = await tx`SELECT c.id FROM customers c JOIN subscriptions s ON s.customer_id = c.id
                           WHERE s.id = ${subscriptionId} AND s.tenant_id = ${tenantId} FOR UPDATE OF c`;
    if (!owner[0]) throw notFound("subscription");
    const rows = await tx.unsafe(`SELECT ${SUB_COLUMNS} FROM subscriptions WHERE id = $1 FOR UPDATE`, [subscriptionId]);
    const sub = toSubscription(rows[0]);

    if (periodStart) {
      const existing =
        await tx`SELECT id FROM invoices WHERE subscription_id = ${subscriptionId} AND period_start = ${periodStart}`;
      if (existing[0]) return { invoice: await getInvoice(tx, tenantId, existing[0].id), created: false };
      if (periodStart.getTime() !== sub.currentPeriodStart.getTime()) {
        throw conflict("period_start does not match the subscription's current period", {
          current_period_start: sub.currentPeriodStart.toISOString(),
        });
      }
    }
    const now = clock.now();
    if (now.getTime() < sub.currentPeriodEnd.getTime()) {
      throw conflict("the billing period has not ended yet", { period_end: sub.currentPeriodEnd.toISOString() });
    }

    const period = { start: sub.currentPeriodStart, end: sub.currentPeriodEnd };
    const { draft, pendingIds } = await assemble(tx, tenantId, sub, period);

    const counter = await tx`UPDATE tenant_counters SET last_invoice_no = last_invoice_no + 1
                             WHERE tenant_id = ${tenantId} RETURNING last_invoice_no::text AS n`;
    const number = BigInt(counter[0].n);
    const id = randomUUID();
    await tx`INSERT INTO invoices (id, tenant_id, customer_id, subscription_id, number, period_start, period_end,
                                   currency, subtotal_minor, credits_applied, amount_due_minor, status, lines, finalized_at)
             VALUES (${id}, ${tenantId}, ${sub.customerId}, ${sub.id}, ${number}, ${period.start}, ${period.end},
                     ${draft.currency}, ${draft.subtotalMinor}, ${draft.creditsAppliedMinor}, ${draft.amountDueMinor},
                     'open', ${asJson(draft.lines.map(encodeLine))}::text::jsonb, ${now})`;

    if (draft.creditsAppliedMinor > 0n) {
      await tx`INSERT INTO credit_ledger (id, tenant_id, customer_id, currency, amount_minor, reason, invoice_id, created_at)
               VALUES (${randomUUID()}, ${tenantId}, ${sub.customerId}, ${draft.currency}, ${-draft.creditsAppliedMinor},
                       ${`Applied to invoice #${number}`}, ${id}, ${now})`;
    }
    if (pendingIds.length > 0) {
      await tx`UPDATE pending_items SET invoice_id = ${id} WHERE id = ANY(${tx.array(pendingIds, "UUID")})`;
    }

    const next = periodAt(sub.billingAnchor, sub.periodIndex + 1);
    await tx`UPDATE subscriptions SET period_index = ${sub.periodIndex + 1},
             current_period_start = ${next.start}, current_period_end = ${next.end} WHERE id = ${sub.id}`;
    await tx`UPDATE customers SET usage_watermark = ${period.end} WHERE id = ${sub.customerId}`;
    await enqueue(tx, now, { tenantId, kind: "stripe.invoice.push", aggregateId: id });

    return { invoice: await getInvoice(tx, tenantId, id), created: true };
  });
}

export async function getInvoice(db: Queryable, tenantId: string, id: string): Promise<Invoice> {
  const rows = await db`SELECT id, subscription_id, customer_id, number::text AS number, period_start, period_end,
                               currency, subtotal_minor::text AS subtotal, credits_applied::text AS credits,
                               amount_due_minor::text AS due, status, stripe_invoice_id, lines, finalized_at
                        FROM invoices WHERE id = ${id} AND tenant_id = ${tenantId}`;
  const row = rows[0];
  if (!row) throw notFound("invoice");
  return {
    id: row.id,
    number: BigInt(row.number),
    status: row.status,
    stripeInvoiceId: row.stripe_invoice_id,
    finalizedAt: row.finalized_at,
    subscriptionId: row.subscription_id,
    customerId: row.customer_id,
    currency: row.currency,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    lines: (row.lines as EncodedLine[]).map(decodeLine),
    subtotalMinor: BigInt(row.subtotal),
    creditsAppliedMinor: BigInt(row.credits),
    amountDueMinor: BigInt(row.due),
  };
}

interface EncodedLine {
  kind: InvoiceLine["kind"];
  description: string;
  meter: string | null;
  quantity: string | null;
  amount_minor: string;
  breakdown: { label: string; quantity: string; unit_amount: string; flat_amount: string }[];
}

const encodeLine = (line: InvoiceLine): EncodedLine => ({
  kind: line.kind,
  description: line.description,
  meter: line.meter,
  quantity: line.quantity === null ? null : line.quantity.toString(),
  amount_minor: line.amountMinor.toString(),
  breakdown: line.breakdown.map((b) => ({
    label: b.label,
    quantity: b.quantity.toString(),
    unit_amount: b.unitAmount,
    flat_amount: b.flatAmount.toString(),
  })),
});

const decodeLine = (line: EncodedLine): InvoiceLine => ({
  kind: line.kind,
  description: line.description,
  meter: line.meter,
  quantity: line.quantity === null ? null : BigInt(line.quantity),
  amountMinor: BigInt(line.amount_minor),
  breakdown: line.breakdown.map((b) => ({
    label: b.label,
    quantity: BigInt(b.quantity),
    unitAmount: b.unit_amount,
    flatAmount: BigInt(b.flat_amount),
  })),
});
