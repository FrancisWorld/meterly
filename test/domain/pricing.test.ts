import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { PRICE_SCALE } from "../../src/domain/money.ts";
import { calculatePrice, type Pricing, PricingError, type Tier, validatePricing } from "../../src/domain/pricing.ts";
import { decodePricing, encodePricing } from "../../src/domain/pricing-codec.ts";

const whole = (n: number | bigint): bigint => BigInt(n) * PRICE_SCALE;
const graduated = (tiers: Tier[]): Pricing => ({ model: "graduated", tiers });
const volume = (tiers: Tier[]): Pricing => ({ model: "volume", tiers });
const tier = (upTo: number | null, unit: bigint, flat = 0n): Tier => ({
  upTo: upTo === null ? null : BigInt(upTo),
  unitAmount: unit,
  flatAmount: flat,
});

const STEPS = [tier(1000, 0n), tier(10_000, whole(1) / 2n), tier(null, whole(1) / 5n)];

describe("graduated", () => {
  const pricing = graduated(STEPS);
  test("prices each tier only for the units inside it", () => {
    expect(calculatePrice(pricing, 0n).amount).toBe(0n);
    expect(calculatePrice(pricing, 1000n).amount).toBe(0n);
    expect(calculatePrice(pricing, 1001n).amount).toBe(1n); // 0.5 rounds half up
    expect(calculatePrice(pricing, 10_000n).amount).toBe(4500n);
    expect(calculatePrice(pricing, 10_001n).amount).toBe(4500n); // 0.2 rounds down
    expect(calculatePrice(pricing, 20_000n).amount).toBe(6500n);
  });

  test("breakdown names the tiers that were reached", () => {
    const { breakdown } = calculatePrice(pricing, 12_000n);
    expect(breakdown.map((b) => [b.label, b.quantity, b.unitAmount])).toEqual([
      ["1-1000", 1000n, "0"],
      ["1001-10000", 9000n, "0.5"],
      ["10001+", 2000n, "0.2"],
    ]);
  });

  test("flat fee is charged once usage enters the tier, not before", () => {
    const p = graduated([tier(100, whole(1), 0n), tier(null, whole(2), 500n)]);
    expect(calculatePrice(p, 100n).amount).toBe(100n);
    expect(calculatePrice(p, 101n).amount).toBe(100n + 2n + 500n);
  });

  test("fractional cent prices stay exact until the single final rounding", () => {
    const p = graduated([tier(null, 400_000n)]); // 0.0004 per unit
    expect(calculatePrice(p, 2_500n).amount).toBe(1n);
    expect(calculatePrice(p, 1_249n).amount).toBe(0n); // 0.4996 -> 0
    expect(calculatePrice(p, 1_250n).amount).toBe(1n); // 0.5 -> 1
    expect(calculatePrice(p, 10n ** 30n).amount).toBe(4n * 10n ** 26n);
  });
});

describe("volume", () => {
  const pricing = volume([tier(10, whole(100)), tier(100, whole(80)), tier(null, whole(60), 1000n)]);
  test("the tier containing the total prices every unit", () => {
    expect(calculatePrice(pricing, 10n).amount).toBe(1000n);
    expect(calculatePrice(pricing, 11n).amount).toBe(880n);
    expect(calculatePrice(pricing, 100n).amount).toBe(8000n);
    expect(calculatePrice(pricing, 101n).amount).toBe(101n * 60n + 1000n);
  });
  test("is intentionally not monotonic across a boundary", () => {
    expect(calculatePrice(pricing, 11n).amount).toBeLessThan(calculatePrice(pricing, 10n).amount);
  });
});

describe("package", () => {
  const pricing: Pricing = { model: "package", packageSize: 25n, packageAmount: whole(1500) };
  test("charges whole packages, rounding partial ones up", () => {
    expect(calculatePrice(pricing, 0n).amount).toBe(0n);
    expect(calculatePrice(pricing, 1n).amount).toBe(1500n);
    expect(calculatePrice(pricing, 25n).amount).toBe(1500n);
    expect(calculatePrice(pricing, 26n).amount).toBe(3000n);
  });
});

describe("validation", () => {
  test("tiers must be increasing, finite except the last", () => {
    expect(() => validatePricing(graduated([]))).toThrow(PricingError);
    expect(() => validatePricing(graduated([tier(100, 1n)]))).toThrow("unbounded");
    expect(() => validatePricing(graduated([tier(null, 1n), tier(null, 1n)]))).toThrow("only the last");
    expect(() => validatePricing(graduated([tier(10, 1n), tier(10, 1n), tier(null, 1n)]))).toThrow("increasing");
    expect(() => validatePricing(graduated([tier(0, 1n), tier(null, 1n)]))).toThrow("increasing");
    expect(() => validatePricing({ model: "package", packageSize: 0n, packageAmount: 1n })).toThrow(PricingError);
    expect(() => calculatePrice(graduated(STEPS), -1n)).toThrow(PricingError);
  });

  test("codec round-trips and rejects invalid wire input", () => {
    const wire = {
      model: "graduated",
      tiers: [
        { up_to: 5, unit_amount: "1.5", flat_amount: 10 },
        { up_to: null, unit_amount: "1" },
      ],
    };
    const decoded = decodePricing(wire);
    expect(encodePricing(decoded)).toEqual({
      model: "graduated",
      tiers: [
        { up_to: "5", unit_amount: "1.5", flat_amount: "10" },
        { up_to: null, unit_amount: "1", flat_amount: "0" },
      ],
    });
    expect(decodePricing(encodePricing(decoded))).toEqual(decoded);
    expect(() => decodePricing({ model: "graduated", tiers: [{ up_to: null, unit_amount: 1.5 }] })).toThrow();
    expect(() => decodePricing({ model: "graduated", tiers: [{ up_to: 5, unit_amount: "1" }] })).toThrow();
    expect(() => decodePricing({ model: "mystery" })).toThrow();
    const pkg = decodePricing({ model: "package", package_size: "10", package_amount: "2.5" });
    expect(encodePricing(pkg)).toEqual({ model: "package", package_size: "10", package_amount: "2.5" });
  });
});

// ---- property tests ------------------------------------------------------------------------------

/** Random valid tier ladders: strictly increasing bounds, last tier unbounded. */
const tiersArb = fc
  .tuple(
    fc.uniqueArray(fc.integer({ min: 1, max: 5000 }), { minLength: 0, maxLength: 5 }),
    fc.array(fc.tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 500 })), {
      minLength: 6,
      maxLength: 6,
    }),
  )
  .map(([bounds, prices]) => {
    const sorted = [...bounds].sort((a, b) => a - b);
    const bounded = sorted.map((upTo, i) => tier(upTo, whole(prices[i]?.[0] ?? 0), BigInt(prices[i]?.[1] ?? 0)));
    const last = prices[sorted.length] ?? [1, 0];
    return [...bounded, tier(null, whole(last[0]), BigInt(last[1]))];
  });

/** Unit-by-unit reference implementation: obviously correct, far too slow for real use. */
function referenceGraduated(tiers: Tier[], quantity: number): bigint {
  let total = 0n;
  const entered = new Set<number>();
  for (let unit = 1; unit <= quantity; unit++) {
    const index = tiers.findIndex((t) => t.upTo === null || BigInt(unit) <= t.upTo);
    const t = tiers[index] as Tier;
    total += t.unitAmount;
    if (!entered.has(index)) {
      entered.add(index);
      total += t.flatAmount * PRICE_SCALE;
    }
  }
  return (2n * total + PRICE_SCALE) / (2n * PRICE_SCALE);
}

describe("pricing properties", () => {
  test("graduated matches the unit-by-unit reference", () => {
    fc.assert(
      fc.property(tiersArb, fc.integer({ min: 0, max: 12_000 }), (tiers, quantity) => {
        expect(calculatePrice(graduated(tiers), BigInt(quantity)).amount).toBe(referenceGraduated(tiers, quantity));
      }),
      { numRuns: 150 },
    );
  });

  test("graduated is non-negative, zero at zero, and monotonic in quantity", () => {
    fc.assert(
      fc.property(
        tiersArb,
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        (tiers, a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          const p = graduated(tiers);
          expect(calculatePrice(p, 0n).amount).toBe(0n);
          expect(calculatePrice(p, low).amount >= 0n).toBe(true);
          expect(calculatePrice(p, high).amount >= calculatePrice(p, low).amount).toBe(true);
        },
      ),
    );
  });

  test("graduated crossing a boundary adds exactly the next tier's unit price (+ flat)", () => {
    fc.assert(
      fc.property(tiersArb, (tiers) => {
        const p = graduated(tiers);
        tiers.slice(0, -1).forEach((t, i) => {
          const upTo = t.upTo as bigint;
          const next = tiers[i + 1] as Tier;
          const at = calculatePrice(p, upTo).amount;
          const after = calculatePrice(p, upTo + 1n).amount;
          // Prices here are whole minor units, so no rounding can intervene.
          expect(after - at).toBe(next.unitAmount / PRICE_SCALE + next.flatAmount);
        });
      }),
    );
  });

  test("graduated is exact for astronomically large quantities (no float anywhere)", () => {
    fc.assert(
      fc.property(tiersArb, fc.bigInt({ min: 10n ** 20n, max: 10n ** 40n }), (tiers, quantity) => {
        const result = calculatePrice(graduated(tiers), quantity);
        let scaled = 0n;
        for (const line of result.breakdown) {
          const unit = BigInt(Math.round(Number(line.unitAmount))) * PRICE_SCALE;
          scaled += line.quantity * unit + line.flatAmount * PRICE_SCALE;
        }
        expect(result.amount).toBe(scaled / PRICE_SCALE);
        expect(result.breakdown.reduce((n, l) => n + l.quantity, 0n)).toBe(quantity);
      }),
    );
  });

  test("volume prices every unit at the tier that contains the total", () => {
    fc.assert(
      fc.property(tiersArb, fc.integer({ min: 1, max: 12_000 }), (tiers, quantity) => {
        const q = BigInt(quantity);
        const t = tiers.find((x) => x.upTo === null || q <= x.upTo) as Tier;
        expect(calculatePrice(volume(tiers), q).amount).toBe((q * t.unitAmount) / PRICE_SCALE + t.flatAmount);
      }),
    );
  });

  test("volume switches tier exactly at the boundary", () => {
    fc.assert(
      fc.property(tiersArb, (tiers) => {
        const p = volume(tiers);
        tiers.slice(0, -1).forEach((t, i) => {
          const upTo = t.upTo as bigint;
          const inner = calculatePrice(p, upTo);
          const outer = calculatePrice(p, upTo + 1n);
          expect(inner.breakdown[0]?.unitAmount).toBe(String(Number(t.unitAmount / PRICE_SCALE)));
          const next = tiers[i + 1] as Tier;
          expect(outer.amount).toBe(((upTo + 1n) * next.unitAmount) / PRICE_SCALE + next.flatAmount);
        });
      }),
    );
  });

  test("package is ceil(quantity / size) packages, monotonic, with whole-package steps", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        (size, price, quantity) => {
          const p: Pricing = { model: "package", packageSize: size, packageAmount: whole(price) };
          const packages = (quantity + size - 1n) / size;
          expect(calculatePrice(p, quantity).amount).toBe(packages * price);
          expect(calculatePrice(p, quantity + 1n).amount >= calculatePrice(p, quantity).amount).toBe(true);
          // Anything within the same package costs the same.
          if (quantity > 0n && quantity % size !== 0n) {
            expect(calculatePrice(p, quantity + 1n).amount).toBe(
              (quantity + 1n) % size === 1n ? (packages + 0n) * price : calculatePrice(p, quantity).amount,
            );
          }
        },
      ),
    );
  });
});
