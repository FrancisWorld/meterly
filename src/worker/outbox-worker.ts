import type { Clock } from "../clock.ts";
import type { Db } from "../db/client.ts";
import type { Logger } from "../logger.ts";
import { claim, markDead, markDone, markRetry, type OutboxJob } from "../services/outbox.ts";
import { lockStripeInvoice, replayOrphans } from "../services/webhooks.ts";
import { StripeError, type StripeGateway } from "../stripe/gateway.ts";

export interface WorkerOptions {
  batchSize: number;
  maxAttempts: number;
  leaseSeconds: number;
  pollMs: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface RunSummary {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
}

/** Exponential backoff: base * 2^(attempt-1), capped. Deterministic so tests can assert on it. */
export function backoffMs(attempt: number, base: number, cap: number): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

export class OutboxWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<unknown> = Promise.resolve();
  private stopped = true;

  constructor(
    private readonly db: Db,
    private readonly gateway: StripeGateway,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: WorkerOptions,
  ) {}

  /** Process one batch. Safe to call from many workers at once. */
  async runOnce(): Promise<RunSummary> {
    const jobs = await claim(this.db, this.clock.now(), this.options.batchSize, this.options.leaseSeconds);
    const summary: RunSummary = { claimed: jobs.length, done: 0, retried: 0, dead: 0 };
    for (const job of jobs) {
      try {
        await this.handle(job);
        await markDone(this.db, job.id, this.clock.now());
        summary.done += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = error instanceof StripeError ? error.retryable : true;
        if (!retryable || job.attempts >= this.options.maxAttempts) {
          await markDead(this.db, job.id, message);
          summary.dead += 1;
          this.logger.error("outbox job dead", { job: job.id, kind: job.kind, attempts: job.attempts, error: message });
        } else {
          const delay = backoffMs(
            job.attempts,
            this.options.baseBackoffMs ?? 1000,
            this.options.maxBackoffMs ?? 3_600_000,
          );
          await markRetry(this.db, job.id, new Date(this.clock.now().getTime() + delay), message);
          summary.retried += 1;
          this.logger.warn("outbox job will retry", {
            job: job.id,
            kind: job.kind,
            attempts: job.attempts,
            delay_ms: delay,
            error: message,
          });
        }
      }
    }
    return summary;
  }

  private async handle(job: OutboxJob): Promise<void> {
    if (job.kind === "stripe.customer.sync") await this.syncCustomer(job.aggregateId);
    else await this.pushInvoice(job.aggregateId);
  }

  /** Create (or find, via the idempotency key) the Stripe customer and remember its id. */
  private async ensureStripeCustomer(customerId: string): Promise<string> {
    const rows = await this.db`SELECT name, email, stripe_customer_id FROM customers WHERE id = ${customerId}`;
    const customer = rows[0];
    if (!customer) throw new StripeError(`customer ${customerId} no longer exists`, "local_missing", false);
    if (customer.stripe_customer_id) return customer.stripe_customer_id as string;
    const created = await this.gateway.createCustomer(
      { name: customer.name, email: customer.email, metadata: { meterly_customer_id: customerId } },
      { idempotencyKey: `customer:${customerId}` },
    );
    await this.db`UPDATE customers SET stripe_customer_id = ${created.id}
                  WHERE id = ${customerId} AND stripe_customer_id IS NULL`;
    return created.id;
  }

  private async syncCustomer(customerId: string): Promise<void> {
    await this.ensureStripeCustomer(customerId);
  }

  private async pushInvoice(invoiceId: string): Promise<void> {
    const rows = await this.db`SELECT customer_id, currency, number::text AS number,
                                      credits_applied::text AS credits, lines, stripe_invoice_id
                               FROM invoices WHERE id = ${invoiceId}`;
    const invoice = rows[0];
    if (!invoice) throw new StripeError(`invoice ${invoiceId} no longer exists`, "local_missing", false);
    if (invoice.stripe_invoice_id) return;

    const stripeCustomerId = await this.ensureStripeCustomer(invoice.customer_id);
    const lines = (invoice.lines as { description: string; amount_minor: string }[]).map((l) => ({
      description: l.description,
      amountMinor: BigInt(l.amount_minor),
    }));
    // Stripe has no concept of our credit ledger, so applied credits become an explicit negative line
    // and the Stripe invoice total always equals amount_due.
    const credits = BigInt(invoice.credits);
    if (credits > 0n) lines.push({ description: "Account credit applied", amountMinor: -credits });

    const created = await this.gateway.createInvoice(
      {
        customerId: stripeCustomerId,
        currency: invoice.currency,
        lines,
        metadata: { meterly_invoice_id: invoiceId, meterly_invoice_number: invoice.number },
      },
      { idempotencyKey: `invoice:${invoiceId}` },
    );
    await this.db.begin(async (tx) => {
      await lockStripeInvoice(tx, created.id);
      await tx`UPDATE invoices SET stripe_invoice_id = ${created.id} WHERE id = ${invoiceId} AND stripe_invoice_id IS NULL`;
      await replayOrphans(tx, created.id);
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = (): void => {
      this.running = this.runOnce()
        .catch((error) => this.logger.error("outbox tick failed", { error: String(error) }))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, this.options.pollMs);
        });
    };
    tick();
  }

  /** Stop polling and wait for the batch in flight to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
