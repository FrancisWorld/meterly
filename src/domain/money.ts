/** Prices are fixed-point decimals: bigint scaled by 10^PRICE_DECIMALS minor units. */
export const PRICE_DECIMALS = 9;
export const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);

const DECIMAL_RE = new RegExp(`^(\\d+)(?:\\.(\\d{1,${PRICE_DECIMALS}}))?$`);

export class MoneyError extends Error {}

/** Largest value a PostgreSQL bigint column can hold. */
export const MAX_INT64 = 9_223_372_036_854_775_807n;

/** Parse a non-negative decimal such as "0.0004" into a scaled bigint. */
export function parseDecimal(input: string): bigint {
  const match = DECIMAL_RE.exec(input);
  if (!match) {
    throw new MoneyError(
      `invalid decimal "${input}": expected a non-negative number with at most ${PRICE_DECIMALS} fraction digits`,
    );
  }
  const whole = BigInt(match[1] as string);
  const fraction = (match[2] ?? "").padEnd(PRICE_DECIMALS, "0");
  return whole * PRICE_SCALE + BigInt(fraction === "" ? "0" : fraction);
}

/** Inverse of parseDecimal, with trailing zeros trimmed. */
export function formatDecimal(scaled: bigint): string {
  const whole = scaled / PRICE_SCALE;
  const fraction = (scaled % PRICE_SCALE).toString().padStart(PRICE_DECIMALS, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/** Parse a non-negative integer given as a JSON number or a decimal string. */
export function parseCount(input: string | number): bigint {
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input < 0) {
      throw new MoneyError("expected a non-negative safe integer; send larger values as strings");
    }
    return BigInt(input);
  }
  if (!/^\d+$/.test(input)) throw new MoneyError(`invalid integer "${input}"`);
  const value = BigInt(input);
  if (value > MAX_INT64) throw new MoneyError(`integer out of range: the maximum is ${MAX_INT64}`);
  return value;
}

/** Integer division rounding half away from zero. Divisor must be positive. */
export function divRoundHalfUp(numerator: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new MoneyError("divisor must be positive");
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = (2n * abs + divisor) / (2n * divisor);
  return negative ? -quotient : quotient;
}

export function ceilDiv(numerator: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new MoneyError("divisor must be positive");
  return (numerator + divisor - 1n) / divisor;
}

export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
