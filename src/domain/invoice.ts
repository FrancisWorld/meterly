import { maxBig, minBig } from "./money.ts";
import { calculatePrice, type PriceBreakdownLine, type Pricing } from "./pricing.ts";

export interface InvoiceLine {
  kind: "base_fee" | "usage" | "adjustment";
  description: string;
  meter: string | null;
  quantity: bigint | null;
  amountMinor: bigint;
  breakdown: PriceBreakdownLine[];
}

export interface InvoiceInput {
  baseFeeMinor: bigint;
  usage: { meter: string; aggregation: string; quantity: bigint; pricing: Pricing }[];
  /** Signed pending items such as plan-change proration. */
  adjustments: { description: string; amountMinor: bigint }[];
  creditBalanceMinor: bigint;
}

export interface InvoiceTotals {
  lines: InvoiceLine[];
  subtotalMinor: bigint;
  creditsAppliedMinor: bigint;
  amountDueMinor: bigint;
}

export function computeInvoice(input: InvoiceInput): InvoiceTotals {
  const lines: InvoiceLine[] = [];
  if (input.baseFeeMinor > 0n) {
    lines.push({
      kind: "base_fee",
      description: "Base fee",
      meter: null,
      quantity: null,
      amountMinor: input.baseFeeMinor,
      breakdown: [],
    });
  }
  for (const item of input.usage) {
    if (item.quantity === 0n) continue;
    const price = calculatePrice(item.pricing, item.quantity);
    lines.push({
      kind: "usage",
      description: `${item.meter} (${item.aggregation})`,
      meter: item.meter,
      quantity: item.quantity,
      amountMinor: price.amount,
      breakdown: price.breakdown,
    });
  }
  for (const adjustment of input.adjustments) {
    lines.push({
      kind: "adjustment",
      description: adjustment.description,
      meter: null,
      quantity: null,
      amountMinor: adjustment.amountMinor,
      breakdown: [],
    });
  }
  // Adjustments are plan-change prorations bounded by the new base fee, so the subtotal cannot go negative.
  const subtotalMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0n);
  const creditsAppliedMinor = minBig(subtotalMinor, maxBig(0n, input.creditBalanceMinor));
  return { lines, subtotalMinor, creditsAppliedMinor, amountDueMinor: subtotalMinor - creditsAppliedMinor };
}
