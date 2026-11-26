import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.ts";
import type { Db, Queryable } from "../db/client.ts";
import { conflict, notFound } from "../errors.ts";

export interface CreditEntry {
  id: string;
  currency: string;
  amountMinor: bigint;
  reason: string;
  invoiceId: string | null;
  createdAt: Date;
}

export async function balance(db: Queryable, customerId: string, currency: string): Promise<bigint> {
  const rows = await db`SELECT COALESCE(SUM(amount_minor), 0)::text AS total
                        FROM credit_ledger WHERE customer_id = ${customerId} AND currency = ${currency}`;
  return BigInt(rows[0].total);
}

export interface GrantInput {
  currency: string;
  amountMinor: bigint;
  reason: string;
  /** Makes the grant safe to retry: the same key never grants twice. */
  idempotencyKey?: string | undefined;
}

export interface GrantResult {
  entry: CreditEntry;
  created: boolean;
}

export async function grantCredit(
  db: Db,
  clock: Clock,
  tenantId: string,
  customerId: string,
  input: GrantInput,
): Promise<GrantResult> {
  return db.begin(async (tx) => {
    const customer = await tx`SELECT id FROM customers WHERE id = ${customerId} AND tenant_id = ${tenantId}`;
    if (!customer[0]) throw notFound("customer");
    const id = randomUUID();
    const inserted = await tx`
      INSERT INTO credit_ledger (id, tenant_id, customer_id, currency, amount_minor, reason, grant_key, created_at)
      VALUES (${id}, ${tenantId}, ${customerId}, ${input.currency}, ${input.amountMinor}, ${input.reason},
              ${input.idempotencyKey ?? null}, ${clock.now()})
      ON CONFLICT (tenant_id, grant_key) WHERE grant_key IS NOT NULL DO NOTHING
      RETURNING id`;
    if (inserted.length === 1) {
      return { entry: await readEntry(tx, id), created: true };
    }
    const existing = await tx`SELECT id, customer_id, currency, amount_minor::text AS amount, reason
                              FROM credit_ledger WHERE tenant_id = ${tenantId} AND grant_key = ${input.idempotencyKey}`;
    const row = existing[0];
    if (
      !row ||
      row.customer_id !== customerId ||
      row.currency !== input.currency ||
      BigInt(row.amount) !== input.amountMinor
    ) {
      throw conflict("idempotency key was already used with different parameters");
    }
    return { entry: await readEntry(tx, row.id), created: false };
  });
}

async function readEntry(db: Queryable, id: string): Promise<CreditEntry> {
  const rows = await db`SELECT id, currency, amount_minor::text AS amount, reason, invoice_id, created_at
                        FROM credit_ledger WHERE id = ${id}`;
  return toEntry(rows[0]);
}

export async function listCredits(
  db: Queryable,
  tenantId: string,
  customerId: string,
): Promise<{ balances: Record<string, bigint>; entries: CreditEntry[] }> {
  const customer = await db`SELECT id FROM customers WHERE id = ${customerId} AND tenant_id = ${tenantId}`;
  if (!customer[0]) throw notFound("customer");
  const entries = await db`SELECT id, currency, amount_minor::text AS amount, reason, invoice_id, created_at
                           FROM credit_ledger WHERE customer_id = ${customerId} ORDER BY created_at, id`;
  const totals = await db`SELECT currency, SUM(amount_minor)::text AS total
                          FROM credit_ledger WHERE customer_id = ${customerId} GROUP BY currency`;
  const balances: Record<string, bigint> = {};
  for (const row of totals as { currency: string; total: string }[]) balances[row.currency] = BigInt(row.total);
  return { balances, entries: entries.map(toEntry) };
}

function toEntry(row: Record<string, unknown>): CreditEntry {
  return {
    id: row.id as string,
    currency: row.currency as string,
    amountMinor: BigInt(row.amount as string),
    reason: row.reason as string,
    invoiceId: (row.invoice_id as string | null) ?? null,
    createdAt: row.created_at as Date,
  };
}
