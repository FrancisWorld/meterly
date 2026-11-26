import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.ts";
import { asJson, type Db, isUniqueViolation, type Queryable } from "../db/client.ts";
import type { Pricing } from "../domain/pricing.ts";
import { decodePricing, encodePricing, type PricingWire } from "../domain/pricing-codec.ts";
import { conflict, invalid, notFound } from "../errors.ts";

export type Aggregation = "sum" | "max" | "unique";

export interface Meter {
  id: string;
  code: string;
  aggregation: Aggregation;
  property: string | null;
}

export interface NewMeter {
  code: string;
  aggregation: Aggregation;
  property?: string | undefined;
}

export interface PlanItem {
  meterId: string;
  meterCode: string;
  aggregation: Aggregation;
  pricing: Pricing;
}

export interface Plan {
  id: string;
  code: string;
  currency: string;
  baseFeeMinor: bigint;
  items: PlanItem[];
}

export interface NewPlan {
  code: string;
  currency: string;
  baseFeeMinor: bigint;
  items: { meterCode: string; pricing: Pricing }[];
}

const toMeter = (row: Record<string, unknown>): Meter => ({
  id: row.id as string,
  code: row.code as string,
  aggregation: row.aggregation as Aggregation,
  property: (row.property as string | null) ?? null,
});

export async function createMeter(db: Db, clock: Clock, tenantId: string, input: NewMeter): Promise<Meter> {
  if (input.aggregation === "unique" && !input.property) {
    throw invalid("unique meters need a `property` to count distinct values of");
  }
  if (input.aggregation !== "unique" && input.property) {
    throw invalid("`property` is only valid for unique meters");
  }
  const id = randomUUID();
  try {
    await db`INSERT INTO meters (id, tenant_id, code, aggregation, property, created_at)
             VALUES (${id}, ${tenantId}, ${input.code}, ${input.aggregation}, ${input.property ?? null}, ${clock.now()})`;
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(`meter "${input.code}" already exists`);
    throw error;
  }
  return { id, code: input.code, aggregation: input.aggregation, property: input.property ?? null };
}

export async function listMeters(db: Queryable, tenantId: string): Promise<Meter[]> {
  const rows = await db`SELECT id, code, aggregation, property FROM meters WHERE tenant_id = ${tenantId} ORDER BY code`;
  return rows.map(toMeter);
}

export async function createPlan(db: Db, clock: Clock, tenantId: string, input: NewPlan): Promise<Plan> {
  const codes = input.items.map((i) => i.meterCode);
  if (new Set(codes).size !== codes.length) throw invalid("a meter can appear only once per plan");
  const id = randomUUID();
  try {
    await db.begin(async (tx) => {
      const meters =
        await tx`SELECT id, code FROM meters WHERE tenant_id = ${tenantId} AND code = ANY(${tx.array(codes, "TEXT")})`;
      const byCode = new Map<string, string>(meters.map((m: { id: string; code: string }) => [m.code, m.id]));
      const missing = codes.filter((c) => !byCode.has(c));
      if (missing.length > 0) throw invalid(`unknown meters: ${missing.join(", ")}`);
      await tx`INSERT INTO plans (id, tenant_id, code, currency, base_fee_minor, created_at)
               VALUES (${id}, ${tenantId}, ${input.code}, ${input.currency}, ${input.baseFeeMinor}, ${clock.now()})`;
      for (const item of input.items) {
        await tx`INSERT INTO plan_items (plan_id, meter_id, pricing)
                 VALUES (${id}, ${byCode.get(item.meterCode)}, ${asJson(encodePricing(item.pricing))}::text::jsonb)`;
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(`plan "${input.code}" already exists`);
    throw error;
  }
  return getPlan(db, tenantId, id);
}

export async function getPlan(db: Queryable, tenantId: string, planId: string): Promise<Plan> {
  const rows = await db`SELECT id, code, currency, base_fee_minor::text AS base_fee_minor
                        FROM plans WHERE id = ${planId} AND tenant_id = ${tenantId}`;
  const row = rows[0];
  if (!row) throw notFound("plan");
  const items = await db`
    SELECT pi.meter_id, m.code, m.aggregation, pi.pricing
    FROM plan_items pi JOIN meters m ON m.id = pi.meter_id
    WHERE pi.plan_id = ${planId} ORDER BY m.code`;
  return {
    id: row.id,
    code: row.code,
    currency: row.currency,
    baseFeeMinor: BigInt(row.base_fee_minor),
    items: items.map(
      (item: { meter_id: string; code: string; aggregation: Aggregation; pricing: unknown }): PlanItem => ({
        meterId: item.meter_id,
        meterCode: item.code,
        aggregation: item.aggregation,
        pricing: decodePricing(item.pricing),
      }),
    ),
  };
}

export type { PricingWire };
