import type { Queryable } from "../db/client.ts";
import { invalid, notFound } from "../errors.ts";
import type { Aggregation } from "./catalog.ts";

export type Window = "hour" | "day" | "month";

export interface UsageBucket {
  start: Date;
  quantity: bigint;
}

/** Aggregate every meter of a customer over [start, end), keyed by meter id. */
export async function aggregatePeriod(
  db: Queryable,
  customerId: string,
  start: Date,
  end: Date,
): Promise<Map<string, { sum: bigint; max: bigint; unique: bigint }>> {
  const rows = await db`
    SELECT meter_id, SUM(quantity)::text AS sum, MAX(quantity)::text AS max, COUNT(DISTINCT dimension)::text AS uniq
    FROM events
    WHERE customer_id = ${customerId} AND effective_at >= ${start} AND effective_at < ${end}
    GROUP BY meter_id`;
  const out = new Map<string, { sum: bigint; max: bigint; unique: bigint }>();
  for (const row of rows as { meter_id: string; sum: string; max: string; uniq: string }[]) {
    out.set(row.meter_id, { sum: BigInt(row.sum), max: BigInt(row.max), unique: BigInt(row.uniq) });
  }
  return out;
}

export const pick = (
  aggregation: Aggregation,
  values: { sum: bigint; max: bigint; unique: bigint } | undefined,
): bigint => {
  if (!values) return 0n;
  return aggregation === "sum" ? values.sum : aggregation === "max" ? values.max : values.unique;
};

const AGG_SQL: Record<Aggregation, string> = {
  sum: "SUM(quantity)",
  max: "MAX(quantity)",
  unique: "COUNT(DISTINCT dimension)",
};

export interface UsageReport {
  meter: string;
  aggregation: Aggregation;
  from: Date;
  to: Date;
  /** Aggregate over the whole range. For `unique` this is distinct across the range, not the sum of buckets. */
  total: bigint;
  buckets: UsageBucket[];
}

/** Usage for one customer and meter over [from, to), optionally split into UTC time windows. */
export async function usageReport(
  db: Queryable,
  tenantId: string,
  input: { customerId: string; meterCode: string; from: Date; to: Date; window?: Window | undefined },
): Promise<UsageReport> {
  if (input.to.getTime() <= input.from.getTime()) throw invalid("`to` must be after `from`");
  const meters =
    await db`SELECT id, aggregation FROM meters WHERE tenant_id = ${tenantId} AND code = ${input.meterCode}`;
  const meter = meters[0];
  if (!meter) throw notFound("meter");
  const customer = await db`SELECT id FROM customers WHERE id = ${input.customerId} AND tenant_id = ${tenantId}`;
  if (!customer[0]) throw notFound("customer");
  const aggregation = meter.aggregation as Aggregation;
  const expr = AGG_SQL[aggregation];

  const totals = await db.unsafe(
    `SELECT COALESCE(${expr}, 0)::text AS total FROM events
     WHERE customer_id = $1 AND meter_id = $2 AND effective_at >= $3 AND effective_at < $4`,
    [input.customerId, meter.id, input.from, input.to],
  );
  let buckets: UsageBucket[] = [];
  if (input.window) {
    const rows = await db.unsafe(
      `SELECT date_trunc('${input.window}', effective_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
              ${expr}::text AS quantity
       FROM events
       WHERE customer_id = $1 AND meter_id = $2 AND effective_at >= $3 AND effective_at < $4
       GROUP BY bucket ORDER BY bucket`,
      [input.customerId, meter.id, input.from, input.to],
    );
    buckets = (rows as { bucket: Date; quantity: string }[]).map((r) => ({
      start: r.bucket,
      quantity: BigInt(r.quantity),
    }));
  }
  return {
    meter: input.meterCode,
    aggregation,
    from: input.from,
    to: input.to,
    total: BigInt(totals[0].total),
    buckets,
  };
}
