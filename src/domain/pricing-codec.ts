import { z } from "zod";
import { formatDecimal, type MoneyError, parseCount, parseDecimal } from "./money.ts";
import { type Pricing, type PricingError, type Tier, validatePricing } from "./pricing.ts";

/** Integers travel as JSON numbers (when safe) or decimal strings. */
export const countSchema = z.union([z.number(), z.string()]).transform((value, ctx) => {
  try {
    return parseCount(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as MoneyError).message });
    return z.NEVER;
  }
});

/** Decimals (prices) are strings only: JSON numbers would reintroduce float rounding. */
export const decimalSchema = z.string().transform((value, ctx) => {
  try {
    return parseDecimal(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as MoneyError).message });
    return z.NEVER;
  }
});

const tierSchema = z
  .object({
    up_to: countSchema.nullable(),
    unit_amount: decimalSchema,
    flat_amount: countSchema.default("0"),
  })
  .strict()
  .transform((tier): Tier => ({ upTo: tier.up_to, unitAmount: tier.unit_amount, flatAmount: tier.flat_amount }));

export const pricingSchema = z
  .discriminatedUnion("model", [
    z.object({ model: z.literal("graduated"), tiers: z.array(tierSchema).min(1).max(100) }).strict(),
    z.object({ model: z.literal("volume"), tiers: z.array(tierSchema).min(1).max(100) }).strict(),
    z.object({ model: z.literal("package"), package_size: countSchema, package_amount: decimalSchema }).strict(),
  ])
  .transform((wire, ctx): Pricing => {
    const pricing: Pricing =
      wire.model === "package"
        ? { model: "package", packageSize: wire.package_size, packageAmount: wire.package_amount }
        : { model: wire.model, tiers: wire.tiers };
    try {
      validatePricing(pricing);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as PricingError).message });
      return z.NEVER;
    }
    return pricing;
  });

export type PricingWire =
  | { model: "graduated" | "volume"; tiers: { up_to: string | null; unit_amount: string; flat_amount: string }[] }
  | { model: "package"; package_size: string; package_amount: string };

/** Canonical JSON form that is stored in the database and returned by the API. */
export function encodePricing(pricing: Pricing): PricingWire {
  if (pricing.model === "package") {
    return {
      model: "package",
      package_size: pricing.packageSize.toString(),
      package_amount: formatDecimal(pricing.packageAmount),
    };
  }
  return {
    model: pricing.model,
    tiers: pricing.tiers.map((tier) => ({
      up_to: tier.upTo === null ? null : tier.upTo.toString(),
      unit_amount: formatDecimal(tier.unitAmount),
      flat_amount: tier.flatAmount.toString(),
    })),
  };
}

export function decodePricing(stored: unknown): Pricing {
  return pricingSchema.parse(stored);
}
