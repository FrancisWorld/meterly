import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  ceilDiv,
  divRoundHalfUp,
  formatDecimal,
  MAX_INT64,
  MoneyError,
  maxBig,
  minBig,
  PRICE_SCALE,
  parseCount,
  parseDecimal,
} from "../../src/domain/money.ts";

describe("decimals", () => {
  test("parse and format round-trip", () => {
    expect(parseDecimal("0.0004")).toBe(400_000n);
    expect(parseDecimal("12")).toBe(12n * PRICE_SCALE);
    expect(formatDecimal(parseDecimal("12.50"))).toBe("12.5");
    expect(formatDecimal(0n)).toBe("0");
  });

  test.each(["", "-1", "1.", ".5", "1e3", "1,5", "0.1234567891", "abc"])("rejects %p", (input) => {
    expect(() => parseDecimal(input)).toThrow(MoneyError);
  });

  test("round trip for any canonical decimal", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), (scaled) => {
        expect(parseDecimal(formatDecimal(scaled))).toBe(scaled);
      }),
    );
  });
});

describe("counts", () => {
  test("accepts safe integers and digit strings", () => {
    expect(parseCount(5)).toBe(5n);
    expect(parseCount("9007199254740993")).toBe(9007199254740993n);
  });
  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN])("rejects number %p", (n) => {
    expect(() => parseCount(n)).toThrow(MoneyError);
  });
  test("enforces the PostgreSQL bigint range", () => {
    expect(parseCount("9223372036854775807")).toBe(MAX_INT64);
    expect(() => parseCount("9223372036854775808")).toThrow(/out of range/);
    expect(() => parseCount("9".repeat(80))).toThrow(MoneyError);
  });
  test.each(["", "-3", "1.0", "0x10"])("rejects string %p", (s) => {
    expect(() => parseCount(s)).toThrow(MoneyError);
  });
});

describe("division", () => {
  test("rounds half away from zero", () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(-4n, 3n)).toBe(-1n);
    expect(divRoundHalfUp(0n, 7n)).toBe(0n);
  });
  test("is within half a unit of the exact quotient", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 25n), max: 10n ** 25n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (n, d) => {
          const q = divRoundHalfUp(n, d);
          expect(2n * (n - q * d) <= d && 2n * (q * d - n) <= d).toBe(true);
        },
      ),
    );
  });
  test("ceilDiv and helpers", () => {
    expect(ceilDiv(10n, 5n)).toBe(2n);
    expect(ceilDiv(11n, 5n)).toBe(3n);
    expect(ceilDiv(0n, 5n)).toBe(0n);
    expect(maxBig(1n, 2n)).toBe(2n);
    expect(minBig(1n, 2n)).toBe(1n);
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(MoneyError);
    expect(() => ceilDiv(1n, -1n)).toThrow(MoneyError);
  });
});
