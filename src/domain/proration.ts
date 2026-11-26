import { divRoundHalfUp } from "./money.ts";

/**
 * Billing is in arrears: the invoice at period end charges the subscription's
 * *current* base fee for the whole period. When the plan changes mid-period the
 * share of the period already spent on the old plan is corrected by a signed
 * adjustment, so that successive changes telescope to
 *   sum(fee_i * share_i)   over the plan history.
 */
export function elapsedShare(amount: bigint, periodStart: Date, periodEnd: Date, at: Date): bigint {
  const total = BigInt(periodEnd.getTime() - periodStart.getTime());
  if (total <= 0n) throw new RangeError("period must have positive length");
  const clamped = Math.min(Math.max(at.getTime(), periodStart.getTime()), periodEnd.getTime());
  const elapsed = BigInt(clamped - periodStart.getTime());
  return divRoundHalfUp(amount * elapsed, total);
}

/** Signed minor units to add to the next invoice when switching base fee at `at`. */
export function planChangeAdjustment(
  oldFee: bigint,
  newFee: bigint,
  periodStart: Date,
  periodEnd: Date,
  at: Date,
): bigint {
  return elapsedShare(oldFee - newFee, periodStart, periodEnd, at);
}
