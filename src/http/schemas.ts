import { z } from "zod";
import { countSchema, pricingSchema } from "../domain/pricing-codec.ts";

const code = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, "1-64 chars of letters, digits and _ . : -");
const currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "ISO 4217 alphabetic code")
  .transform((c) => c.toLowerCase());
const timestamp = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));
export const uuid = z.string().uuid();

const positiveCount = countSchema.refine((n) => n > 0n, "must be greater than zero");

export const meterBody = z
  .object({
    code,
    aggregation: z.enum(["sum", "max", "unique"]),
    property: z.string().min(1).max(128).optional(),
  })
  .strict();

export const planBody = z
  .object({
    code,
    currency,
    base_fee: countSchema.default("0"),
    items: z.array(z.object({ meter: code, pricing: pricingSchema }).strict()).max(100),
  })
  .strict();

export const customerBody = z
  .object({
    external_id: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    email: z.string().email().max(255).optional(),
  })
  .strict();

export const creditBody = z
  .object({
    amount: positiveCount,
    currency,
    reason: z.string().min(1).max(500),
    idempotency_key: z.string().min(1).max(255).optional(),
  })
  .strict();

export const subscriptionBody = z
  .object({ customer_id: uuid, plan_id: uuid, started_at: timestamp.optional() })
  .strict();

export const changePlanBody = z.object({ plan_id: uuid }).strict();

export const finalizeBody = z.object({ period_start: timestamp.optional() }).strict();

export const MAX_BATCH = 1000;

export const eventsBody = z
  .object({
    events: z
      .array(
        z
          .object({
            idempotency_key: z.string().min(1).max(255),
            customer: z.string().min(1).max(255),
            meter: code,
            timestamp,
            quantity: countSchema.default(1),
            properties: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BATCH),
  })
  .strict();

export const usageQuery = z
  .object({
    customer_id: uuid,
    meter: code,
    from: timestamp,
    to: timestamp,
    window: z.enum(["hour", "day", "month"]).optional(),
  })
  .strict();
