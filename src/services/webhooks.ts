import { z } from "zod";
import type { Clock } from "../clock.ts";
import { asJson, type Db, type Queryable } from "../db/client.ts";
import { decideInvoiceEvent, type InvoiceStatus } from "../domain/invoice-events.ts";
import { AppError, invalid } from "../errors.ts";
import { verifySignature } from "../stripe/signature.ts";

export type WebhookOutcome = "applied" | "stale" | "ignored" | "orphaned" | "duplicate";

const eventSchema = z
  .object({
    id: z.string().min(1).max(255),
    type: z.string().min(1).max(255),
    created: z.number().int().nonnegative(),
    data: z.object({ object: z.object({ id: z.string().min(1).max(255) }).passthrough() }).passthrough(),
  })
  .passthrough();

export interface WebhookConfig {
  secret: string;
  toleranceSeconds: number;
}

/**
 * Receive a Stripe event.
 *
 * 1. The signature is verified against the *raw* body with a constant-time compare, and the
 *    timestamp must be within the tolerance window (replay protection).
 * 2. The event id is claimed with an INSERT in the same transaction that applies it, so a
 *    duplicate delivery, even a concurrent one, is applied exactly once.
 * 3. Application is ordered by the event's own `created` time, not by arrival (see decideInvoiceEvent).
 *    Events for invoices we have not linked yet are parked as `orphaned` and replayed once the
 *    outbox worker records the Stripe invoice id.
 */
export async function receiveWebhook(
  db: Db,
  clock: Clock,
  config: WebhookConfig,
  rawBody: string,
  signatureHeader: string | null,
): Promise<WebhookOutcome> {
  const now = clock.now();
  const verified = verifySignature({
    header: signatureHeader,
    rawBody,
    secret: config.secret,
    nowMs: now.getTime(),
    toleranceSeconds: config.toleranceSeconds,
  });
  if (!verified.ok)
    throw new AppError("invalid_signature", "webhook signature verification failed", { reason: verified.reason });

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw invalid("webhook body is not valid JSON");
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) throw invalid("webhook body is not a recognised event", parsed.error.issues);
  const event = parsed.data;
  const created = new Date(event.created * 1000);
  const objectId = event.data.object.id;

  return db.begin(async (tx): Promise<WebhookOutcome> => {
    const claimed = await tx`
      INSERT INTO webhook_events (event_id, type, created_at, object_id, payload, outcome, received_at)
      VALUES (${event.id}, ${event.type}, ${created}, ${objectId}, ${asJson(event)}::text::jsonb, 'ignored', ${now})
      ON CONFLICT (event_id) DO NOTHING RETURNING event_id`;
    if (claimed.length === 0) return "duplicate";
    if (!event.type.startsWith("invoice.")) return "ignored";

    const outcome = await applyToInvoice(tx, objectId, event.type, created);
    if (outcome !== "ignored") await tx`UPDATE webhook_events SET outcome = ${outcome} WHERE event_id = ${event.id}`;
    return outcome;
  });
}

/**
 * Serialises "link this Stripe invoice id" (outbox worker) against "apply an event for it" (webhook), so an
 * event can never be parked as orphaned after the replay that would have picked it up has already run.
 */
export async function lockStripeInvoice(tx: Queryable, stripeInvoiceId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${stripeInvoiceId}, 0))`;
}

async function applyToInvoice(
  tx: Queryable,
  stripeInvoiceId: string,
  type: string,
  created: Date,
): Promise<"applied" | "stale" | "ignored" | "orphaned"> {
  await lockStripeInvoice(tx, stripeInvoiceId);
  const rows =
    await tx`SELECT id, status, status_event_at FROM invoices WHERE stripe_invoice_id = ${stripeInvoiceId} FOR UPDATE`;
  const invoice = rows[0];
  if (!invoice) return "orphaned";
  const decision = decideInvoiceEvent(
    { status: invoice.status as InvoiceStatus, statusEventAt: invoice.status_event_at as Date | null },
    { type, created },
  );
  if (decision.action === "apply") {
    await tx`UPDATE invoices SET status = ${decision.status}, status_event_at = ${created} WHERE id = ${invoice.id}`;
    return "applied";
  }
  return decision.action === "stale" ? "stale" : "ignored";
}

/** Apply events that arrived before the invoice was linked to its Stripe id, oldest first. */
export async function replayOrphans(tx: Queryable, stripeInvoiceId: string): Promise<number> {
  const orphans = await tx`SELECT event_id, type, created_at FROM webhook_events
                           WHERE object_id = ${stripeInvoiceId} AND outcome = 'orphaned'
                           ORDER BY created_at, event_id FOR UPDATE`;
  for (const orphan of orphans as { event_id: string; type: string; created_at: Date }[]) {
    const outcome = await applyToInvoice(tx, stripeInvoiceId, orphan.type, orphan.created_at);
    await tx`UPDATE webhook_events SET outcome = ${outcome} WHERE event_id = ${orphan.event_id}`;
  }
  return orphans.length;
}
