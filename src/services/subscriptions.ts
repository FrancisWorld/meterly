import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.ts";
import { type Db, isUniqueViolation, type Queryable } from "../db/client.ts";
import { periodAt } from "../domain/periods.ts";
import { planChangeAdjustment } from "../domain/proration.ts";
import { conflict, invalid, notFound } from "../errors.ts";

export interface Subscription {
  id: string;
  customerId: string;
  planId: string;
  billingAnchor: Date;
  periodIndex: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

export const toSubscription = (row: Record<string, unknown>): Subscription => ({
  id: row.id as string,
  customerId: row.customer_id as string,
  planId: row.plan_id as string,
  billingAnchor: row.billing_anchor as Date,
  periodIndex: Number(row.period_index),
  currentPeriodStart: row.current_period_start as Date,
  currentPeriodEnd: row.current_period_end as Date,
});

const COLUMNS = `id, customer_id, plan_id, billing_anchor, period_index, current_period_start, current_period_end`;

export async function createSubscription(
  db: Db,
  clock: Clock,
  tenantId: string,
  input: { customerId: string; planId: string; startedAt?: Date | undefined },
): Promise<Subscription> {
  const now = clock.now();
  const anchor = input.startedAt ?? now;
  if (anchor.getTime() > now.getTime()) throw invalid("started_at cannot be in the future");
  const period = periodAt(anchor, 0);
  const id = randomUUID();
  try {
    await db.begin(async (tx) => {
      const customer = await tx`SELECT id FROM customers WHERE id = ${input.customerId} AND tenant_id = ${tenantId}`;
      if (!customer[0]) throw notFound("customer");
      const plan = await tx`SELECT id FROM plans WHERE id = ${input.planId} AND tenant_id = ${tenantId}`;
      if (!plan[0]) throw notFound("plan");
      await tx`INSERT INTO subscriptions (id, tenant_id, customer_id, plan_id, billing_anchor, period_index,
                                          current_period_start, current_period_end, created_at)
               VALUES (${id}, ${tenantId}, ${input.customerId}, ${input.planId}, ${anchor}, 0,
                       ${period.start}, ${period.end}, ${now})`;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("customer already has a subscription");
    throw error;
  }
  return getSubscription(db, tenantId, id);
}

export async function getSubscription(db: Queryable, tenantId: string, id: string): Promise<Subscription> {
  const rows = await db.unsafe(`SELECT ${COLUMNS} FROM subscriptions WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!rows[0]) throw notFound("subscription");
  return toSubscription(rows[0]);
}

/**
 * Switch plans mid-period. The base-fee difference for the time already spent on
 * the old plan is queued as a signed pending item for the next invoice.
 */
export async function changePlan(
  db: Db,
  clock: Clock,
  tenantId: string,
  subscriptionId: string,
  newPlanId: string,
): Promise<{ subscription: Subscription; adjustmentMinor: bigint }> {
  const now = clock.now();
  const adjustmentMinor = await db.begin(async (tx) => {
    const rows = await tx.unsafe(`SELECT ${COLUMNS} FROM subscriptions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
      subscriptionId,
      tenantId,
    ]);
    if (!rows[0]) throw notFound("subscription");
    const sub = toSubscription(rows[0]);
    if (sub.planId === newPlanId) throw invalid("subscription is already on this plan");
    const plans = await tx`SELECT id, currency, base_fee_minor::text AS fee FROM plans
                           WHERE tenant_id = ${tenantId} AND id IN (${sub.planId}, ${newPlanId})`;
    const oldPlan = plans.find((p: { id: string }) => p.id === sub.planId);
    const newPlan = plans.find((p: { id: string }) => p.id === newPlanId);
    if (!newPlan) throw notFound("plan");
    if (oldPlan.currency !== newPlan.currency) throw invalid("plans must share a currency to switch");
    const adjustment = planChangeAdjustment(
      BigInt(oldPlan.fee),
      BigInt(newPlan.fee),
      sub.currentPeriodStart,
      sub.currentPeriodEnd,
      now,
    );
    if (adjustment !== 0n) {
      await tx`INSERT INTO pending_items (id, tenant_id, subscription_id, description, amount_minor, created_at)
               VALUES (${randomUUID()}, ${tenantId}, ${subscriptionId},
                       ${`Plan change proration (${now.toISOString()})`}, ${adjustment}, ${now})`;
    }
    await tx`UPDATE subscriptions SET plan_id = ${newPlanId} WHERE id = ${subscriptionId}`;
    return adjustment;
  });
  return { subscription: await getSubscription(db, tenantId, subscriptionId), adjustmentMinor };
}
