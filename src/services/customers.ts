import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.ts";
import { type Db, isUniqueViolation, type Queryable } from "../db/client.ts";
import { conflict, notFound } from "../errors.ts";
import { enqueue } from "./outbox.ts";

export interface Customer {
  id: string;
  externalId: string;
  name: string;
  email: string | null;
  stripeCustomerId: string | null;
}

export interface NewCustomer {
  externalId: string;
  name: string;
  email?: string | undefined;
}

const toCustomer = (row: Record<string, unknown>): Customer => ({
  id: row.id as string,
  externalId: row.external_id as string,
  name: row.name as string,
  email: (row.email as string | null) ?? null,
  stripeCustomerId: (row.stripe_customer_id as string | null) ?? null,
});

export async function createCustomer(db: Db, clock: Clock, tenantId: string, input: NewCustomer): Promise<Customer> {
  const id = randomUUID();
  const now = clock.now();
  try {
    await db.begin(async (tx) => {
      await tx`INSERT INTO customers (id, tenant_id, external_id, name, email, created_at)
               VALUES (${id}, ${tenantId}, ${input.externalId}, ${input.name}, ${input.email ?? null}, ${now})`;
      await enqueue(tx, now, { tenantId, kind: "stripe.customer.sync", aggregateId: id });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(`customer "${input.externalId}" already exists`);
    throw error;
  }
  return { id, externalId: input.externalId, name: input.name, email: input.email ?? null, stripeCustomerId: null };
}

export async function getCustomer(db: Queryable, tenantId: string, id: string): Promise<Customer> {
  const rows = await db`SELECT id, external_id, name, email, stripe_customer_id
                        FROM customers WHERE id = ${id} AND tenant_id = ${tenantId}`;
  if (!rows[0]) throw notFound("customer");
  return toCustomer(rows[0]);
}
