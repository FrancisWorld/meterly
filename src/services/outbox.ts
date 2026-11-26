import type { Queryable } from "../db/client.ts";

export type OutboxKind = "stripe.customer.sync" | "stripe.invoice.push";

export interface OutboxJob {
  id: number;
  tenantId: string;
  kind: OutboxKind;
  aggregateId: string;
  idempotencyKey: string;
  attempts: number;
}

/**
 * Enqueue inside the same transaction as the domain change that causes it, so a
 * committed invoice always has a job and a rolled-back one never does. The
 * idempotency key doubles as the Stripe idempotency key, and its UNIQUE
 * constraint makes re-enqueueing harmless.
 */
export async function enqueue(
  tx: Queryable,
  now: Date,
  job: { tenantId: string; kind: OutboxKind; aggregateId: string },
): Promise<void> {
  const key = `${job.kind}:${job.aggregateId}`;
  await tx`INSERT INTO outbox (tenant_id, kind, aggregate_id, idempotency_key, next_attempt_at, created_at)
           VALUES (${job.tenantId}, ${job.kind}, ${job.aggregateId}, ${key}, ${now}, ${now})
           ON CONFLICT (idempotency_key) DO NOTHING`;
}

/** Lease up to `limit` due jobs. SKIP LOCKED lets any number of workers pull concurrently without double delivery. */
export async function claim(db: Queryable, now: Date, limit: number, leaseSeconds: number): Promise<OutboxJob[]> {
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
  const rows = await db`
    UPDATE outbox SET attempts = attempts + 1, leased_until = ${leaseUntil}
    WHERE id IN (
      SELECT id FROM outbox
      WHERE status = 'pending' AND next_attempt_at <= ${now}
        AND (leased_until IS NULL OR leased_until <= ${now})
      ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, tenant_id, kind, aggregate_id, idempotency_key, attempts`;
  return rows
    .map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      tenantId: r.tenant_id as string,
      kind: r.kind as OutboxKind,
      aggregateId: r.aggregate_id as string,
      idempotencyKey: r.idempotency_key as string,
      attempts: Number(r.attempts),
    }))
    .sort((a: OutboxJob, b: OutboxJob) => a.id - b.id);
}

export async function markDone(db: Queryable, id: number, now: Date): Promise<void> {
  await db`UPDATE outbox SET status = 'done', done_at = ${now}, leased_until = NULL, last_error = NULL WHERE id = ${id}`;
}

export async function markRetry(db: Queryable, id: number, at: Date, error: string): Promise<void> {
  await db`UPDATE outbox SET next_attempt_at = ${at}, leased_until = NULL, last_error = ${error} WHERE id = ${id}`;
}

export async function markDead(db: Queryable, id: number, error: string): Promise<void> {
  await db`UPDATE outbox SET status = 'dead', leased_until = NULL, last_error = ${error} WHERE id = ${id}`;
}

export interface OutboxStats {
  pending: number;
  done: number;
  dead: number;
}

export async function stats(db: Queryable): Promise<OutboxStats> {
  const rows = await db`SELECT status, count(*)::int AS n FROM outbox GROUP BY status`;
  const out: OutboxStats = { pending: 0, done: 0, dead: 0 };
  for (const row of rows as { status: keyof OutboxStats; n: number }[]) out[row.status] = row.n;
  return out;
}
