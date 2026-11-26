import { ceilDiv, divRoundHalfUp, formatDecimal, minBig, PRICE_SCALE } from "./money.ts";

/**
 * Pricing models. All arithmetic is exact bigint math on fixed-point prices;
 * the only rounding happens once, on the final line total (half away from zero).
 *
 * Zero usage always costs zero, whichever model is used.
 */
export interface Tier {
  /** Inclusive upper bound of the tier; null means "no limit" and is only valid on the last tier. */
  upTo: bigint | null;
  /** Price of one unit in minor units, scaled by PRICE_SCALE. */
  unitAmount: bigint;
  /** Whole minor units charged once when usage reaches this tier. */
  flatAmount: bigint;
}

export type Pricing =
  | { model: "graduated"; tiers: Tier[] }
  | { model: "volume"; tiers: Tier[] }
  | { model: "package"; packageSize: bigint; packageAmount: bigint };

export interface PriceBreakdownLine {
  label: string;
  quantity: bigint;
  unitAmount: string;
  flatAmount: bigint;
}

export interface PriceResult {
  /** Final amount in whole minor units. */
  amount: bigint;
  breakdown: PriceBreakdownLine[];
}

export class PricingError extends Error {}

export function validateTiers(tiers: Tier[]): void {
  if (tiers.length === 0) throw new PricingError("at least one tier is required");
  let previous = 0n;
  tiers.forEach((tier, index) => {
    const last = index === tiers.length - 1;
    if (last) {
      if (tier.upTo !== null) throw new PricingError("the last tier must be unbounded (up_to: null)");
    } else {
      if (tier.upTo === null) throw new PricingError("only the last tier may be unbounded");
      if (tier.upTo <= previous) throw new PricingError("tier up_to values must be strictly increasing and positive");
      previous = tier.upTo;
    }
  });
}

export function validatePricing(pricing: Pricing): void {
  if (pricing.model === "package") {
    if (pricing.packageSize <= 0n) throw new PricingError("package size must be positive");
    return;
  }
  validateTiers(pricing.tiers);
}

export function calculatePrice(pricing: Pricing, quantity: bigint): PriceResult {
  if (quantity < 0n) throw new PricingError("quantity must not be negative");
  if (quantity === 0n) return { amount: 0n, breakdown: [] };
  switch (pricing.model) {
    case "graduated":
      return graduated(pricing.tiers, quantity);
    case "volume":
      return volume(pricing.tiers, quantity);
    case "package":
      return packaged(pricing.packageSize, pricing.packageAmount, quantity);
  }
}

function tierLabel(lower: bigint, upTo: bigint | null): string {
  return upTo === null ? `${lower + 1n}+` : `${lower + 1n}-${upTo}`;
}

/** Each tier prices only the units that fall inside it; a tier's flat fee applies once usage enters it. */
function graduated(tiers: Tier[], quantity: bigint): PriceResult {
  let scaledTotal = 0n;
  let lower = 0n;
  const breakdown: PriceBreakdownLine[] = [];
  for (const tier of tiers) {
    if (quantity <= lower) break;
    const upper = tier.upTo === null ? quantity : minBig(tier.upTo, quantity);
    const inTier = upper - lower;
    scaledTotal += inTier * tier.unitAmount + tier.flatAmount * PRICE_SCALE;
    breakdown.push({
      label: tierLabel(lower, tier.upTo),
      quantity: inTier,
      unitAmount: formatDecimal(tier.unitAmount),
      flatAmount: tier.flatAmount,
    });
    if (tier.upTo === null) break;
    lower = tier.upTo;
  }
  return { amount: divRoundHalfUp(scaledTotal, PRICE_SCALE), breakdown };
}

/** The tier that contains the total quantity prices every unit. */
function volume(tiers: Tier[], quantity: bigint): PriceResult {
  let lower = 0n;
  for (const tier of tiers) {
    if (tier.upTo === null || quantity <= tier.upTo) {
      const scaled = quantity * tier.unitAmount + tier.flatAmount * PRICE_SCALE;
      return {
        amount: divRoundHalfUp(scaled, PRICE_SCALE),
        breakdown: [
          {
            label: tierLabel(lower, tier.upTo),
            quantity,
            unitAmount: formatDecimal(tier.unitAmount),
            flatAmount: tier.flatAmount,
          },
        ],
      };
    }
    lower = tier.upTo;
  }
  throw new PricingError("unreachable: validated tiers always end unbounded");
}

/** Usage is sold in blocks of packageSize; a partial block is charged in full. */
function packaged(packageSize: bigint, packageAmount: bigint, quantity: bigint): PriceResult {
  const packages = ceilDiv(quantity, packageSize);
  return {
    amount: divRoundHalfUp(packages * packageAmount, PRICE_SCALE),
    breakdown: [
      {
        label: `${packages} x package of ${packageSize}`,
        quantity: packages,
        unitAmount: formatDecimal(packageAmount),
        flatAmount: 0n,
      },
    ],
  };
}
