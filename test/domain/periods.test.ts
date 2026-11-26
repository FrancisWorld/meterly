import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { addMonthsUtc, periodAt } from "../../src/domain/periods.ts";
import { elapsedShare, planChangeAdjustment } from "../../src/domain/proration.ts";

const d = (s: string): Date => new Date(s);

describe("periods", () => {
  test("clamps the day instead of overflowing", () => {
    expect(addMonthsUtc(d("2026-01-31T10:00:00Z"), 1).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addMonthsUtc(d("2028-01-31T00:00:00Z"), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(addMonthsUtc(d("2026-11-15T00:00:00Z"), 3).toISOString()).toBe("2027-02-15T00:00:00.000Z");
  });

  test("periods are computed from the anchor, so clamping never drifts", () => {
    const anchor = d("2026-01-31T00:00:00Z");
    expect(periodAt(anchor, 1).start.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(periodAt(anchor, 2).start.toISOString()).toBe("2026-03-31T00:00:00.000Z");
    expect(periodAt(anchor, 2).end.toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  test("consecutive periods are contiguous and strictly increasing", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2020-01-01"), max: new Date("2035-01-01"), noInvalidDate: true }),
        fc.integer({ min: 0, max: 240 }),
        (anchor, index) => {
          const current = periodAt(anchor, index);
          expect(periodAt(anchor, index + 1).start.getTime()).toBe(current.end.getTime());
          expect(current.end.getTime()).toBeGreaterThan(current.start.getTime());
        },
      ),
    );
  });
});

describe("proration", () => {
  const start = d("2026-03-01T00:00:00Z");
  const end = d("2026-04-01T00:00:00Z");

  test("half way through a period is half the amount", () => {
    expect(elapsedShare(3100n, start, end, d("2026-03-16T12:00:00Z"))).toBe(1550n);
  });

  test("clamps outside the period", () => {
    expect(elapsedShare(1000n, start, end, d("2026-02-01T00:00:00Z"))).toBe(0n);
    expect(elapsedShare(1000n, start, end, d("2026-05-01T00:00:00Z"))).toBe(1000n);
    expect(() => elapsedShare(1n, end, start, start)).toThrow(RangeError);
  });

  test("upgrade at the midpoint corrects the invoice to the time-weighted fee", () => {
    const at = d("2026-03-16T12:00:00Z");
    const adjustment = planChangeAdjustment(1000n, 3000n, start, end, at);
    expect(adjustment).toBe(-1000n);
    expect(3000n + adjustment).toBe(2000n); // half at 1000, half at 3000
  });

  test("successive plan changes telescope to the time-weighted sum", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 50_000 }), { minLength: 2, maxLength: 5 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 2_678_400_000 }), { minLength: 1, maxLength: 4 }),
        (fees, offsets) => {
          const changes = [...offsets].sort((a, b) => a - b).slice(0, fees.length - 1);
          const times = changes.map((o) => new Date(start.getTime() + o));
          let invoiceFee = BigInt(fees[0] as number);
          let adjustments = 0n;
          let expectedScaled = 0n;
          let previousAt = start.getTime();
          const total = BigInt(end.getTime() - start.getTime());
          times.forEach((at, i) => {
            const oldFee = BigInt(fees[i] as number);
            const newFee = BigInt(fees[i + 1] as number);
            adjustments += planChangeAdjustment(oldFee, newFee, start, end, at);
            expectedScaled += oldFee * BigInt(at.getTime() - previousAt);
            previousAt = at.getTime();
            invoiceFee = newFee;
          });
          expectedScaled += invoiceFee * BigInt(end.getTime() - previousAt);
          const exact = Number(expectedScaled) / Number(total);
          // Each adjustment rounds once, so the error is bounded by half a minor unit per change.
          expect(Math.abs(Number(invoiceFee + adjustments) - exact)).toBeLessThanOrEqual(0.5 * times.length + 1e-6);
        },
      ),
    );
  });
});
