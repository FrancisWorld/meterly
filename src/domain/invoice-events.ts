export type InvoiceStatus = "open" | "paid" | "payment_failed" | "void";

const EVENT_STATUS: Record<string, InvoiceStatus> = {
  "invoice.paid": "paid",
  "invoice.payment_failed": "payment_failed",
  "invoice.voided": "void",
};

/** Tie-breaker for events created in the same second: money received wins. */
const RANK: Record<InvoiceStatus, number> = { open: 0, payment_failed: 1, void: 2, paid: 3 };

export interface InvoiceState {
  status: InvoiceStatus;
  /** `created` of the last Stripe event applied to this invoice, if any. */
  statusEventAt: Date | null;
}

export type EventDecision = { action: "apply"; status: InvoiceStatus } | { action: "stale" } | { action: "ignore" };

/**
 * Stripe does not guarantee delivery order, so state is driven by the event's
 * own `created` timestamp, never by arrival order. An event older than the one
 * already applied is stale and discarded.
 */
export function decideInvoiceEvent(current: InvoiceState, event: { type: string; created: Date }): EventDecision {
  const next = EVENT_STATUS[event.type];
  if (next === undefined) return { action: "ignore" };
  if (current.statusEventAt !== null) {
    const diff = event.created.getTime() - current.statusEventAt.getTime();
    if (diff < 0) return { action: "stale" };
    if (diff === 0 && RANK[next] <= RANK[current.status]) return { action: "stale" };
  }
  return { action: "apply", status: next };
}
