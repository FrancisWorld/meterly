import { createHash, randomUUID } from "node:crypto";
import type { Clock } from "../clock.ts";
import { asJson, type Db } from "../db/client.ts";

export interface IncomingEvent {
  idempotencyKey: string;
  /** The tenant's own customer identifier. */
  customer: string;
  meter: string;
  timestamp: Date;
  quantity: bigint;
  properties: Record<string, unknown>;
}

export type RejectReason = "unknown_customer" | "unknown_meter" | "missing_property" | "too_old" | "in_future";

export type IngestResult =
  | { idempotencyKey: string; status: "accepted"; late: boolean; effectiveAt: Date }
  | { idempotencyKey: string; status: "duplicate" }
  | { idempotencyKey: string; status: "conflict"; reason: "idempotency_key_reused_with_different_payload" }
  | { idempotencyKey: string; status: "rejected"; reason: RejectReason };

export interface IngestionLimits {
  maxEventAgeMs: number;
  maxClockSkewMs: number;
}

interface Prepared {
  event: IncomingEvent;
  hash: string;
  customerId: string;
  meterId: string;
  dimension: string | null;
}

/** Stable JSON: keys sorted, so equal payloads hash equally regardless of property order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(event: IncomingEvent): string {
  return createHash("sha256")
    .update(
      canonical({
        customer: event.customer,
        meter: event.meter,
        timestamp: event.timestamp.toISOString(),
        quantity: event.quantity.toString(),
        properties: event.properties,
      }),
    )
    .digest("hex");
}

function dimensionOf(property: string, properties: Record<string, unknown>): string | null {
  const value = properties[property];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

/**
 * Ingest a batch of usage events.
 *
 * - Idempotent: (tenant, idempotency_key) is the primary key; a replay is reported as
 *   `duplicate`, a reuse with a different payload as `conflict`.
 * - Late events: if an event's timestamp falls before the customer's watermark (the end of the
 *   last finalized period) it is accepted but billed in the open period (`effective_at` is
 *   clamped to the watermark). The watermark is read under a KEY SHARE row lock that
 *   finalization's FOR UPDATE conflicts with, so an event can never slip into an invoice that
 *   is being finalized concurrently.
 * - Rows are inserted in key order so overlapping concurrent batches take their index locks in the
 *   same order and cannot deadlock.
 */
export async function ingestEvents(
  db: Db,
  clock: Clock,
  tenantId: string,
  events: IncomingEvent[],
  limits: IngestionLimits,
): Promise<IngestResult[]> {
  const now = clock.now();
  const results = new Map<number, IngestResult>();

  const meterCodes = [...new Set(events.map((e) => e.meter))];
  const externalIds = [...new Set(events.map((e) => e.customer))];

  return db.begin(async (tx) => {
    const meterRows = await tx`SELECT id, code, aggregation, property FROM meters
                               WHERE tenant_id = ${tenantId} AND code = ANY(${tx.array(meterCodes, "TEXT")})`;
    const meters = new Map<string, { id: string; aggregation: string; property: string | null }>(
      meterRows.map((m: { id: string; code: string; aggregation: string; property: string | null }) => [m.code, m]),
    );
    const customerRows = await tx`SELECT id, external_id FROM customers
                                  WHERE tenant_id = ${tenantId} AND external_id = ANY(${tx.array(externalIds, "TEXT")})`;
    const customerIds = new Map<string, string>(
      customerRows.map((c: { id: string; external_id: string }) => [c.external_id, c.id]),
    );

    const prepared: { index: number; item: Prepared }[] = [];
    const firstByKey = new Map<string, string>();
    events.forEach((event, index) => {
      const key = event.idempotencyKey;
      const age = now.getTime() - event.timestamp.getTime();
      const meter = meters.get(event.meter);
      const customerId = customerIds.get(event.customer);
      let reject: RejectReason | undefined;
      let dimension: string | null = null;
      if (!customerId) reject = "unknown_customer";
      else if (!meter) reject = "unknown_meter";
      else if (age > limits.maxEventAgeMs) reject = "too_old";
      else if (-age > limits.maxClockSkewMs) reject = "in_future";
      else if (meter.aggregation === "unique") {
        dimension = dimensionOf(meter.property as string, event.properties);
        if (dimension === null) reject = "missing_property";
      }
      if (reject || !customerId || !meter) {
        results.set(index, { idempotencyKey: key, status: "rejected", reason: reject ?? "unknown_meter" });
        return;
      }
      const hash = payloadHash(event);
      const seen = firstByKey.get(key);
      if (seen !== undefined) {
        results.set(
          index,
          seen === hash
            ? { idempotencyKey: key, status: "duplicate" }
            : { idempotencyKey: key, status: "conflict", reason: "idempotency_key_reused_with_different_payload" },
        );
        return;
      }
      firstByKey.set(key, hash);
      prepared.push({ index, item: { event, hash, customerId, meterId: meter.id, dimension } });
    });

    if (prepared.length === 0) return events.map((_, i) => results.get(i) as IngestResult);

    // Sorted lock order keeps concurrent batches from deadlocking each other.
    const lockIds = [...new Set(prepared.map((p) => p.item.customerId))].sort();
    const locked = await tx`SELECT id, usage_watermark FROM customers
                            WHERE id = ANY(${tx.array(lockIds, "UUID")}) ORDER BY id FOR KEY SHARE`;
    const watermarks = new Map<string, Date | null>(
      locked.map((c: { id: string; usage_watermark: Date | null }) => [c.id, c.usage_watermark]),
    );

    const rows = prepared.map(({ item }) => {
      const watermark = watermarks.get(item.customerId) ?? null;
      const occurred = item.event.timestamp;
      const effective = watermark && watermark.getTime() > occurred.getTime() ? watermark : occurred;
      return {
        id: randomUUID(),
        key: item.event.idempotencyKey,
        hash: item.hash,
        customer_id: item.customerId,
        meter_id: item.meterId,
        quantity: item.event.quantity.toString(),
        dimension: item.dimension,
        occurred_at: occurred.toISOString(),
        effective_at: effective.toISOString(),
      };
    });
    const inserted = await tx`
      INSERT INTO events (tenant_id, id, idempotency_key, payload_hash, customer_id, meter_id, quantity,
                          dimension, occurred_at, effective_at, received_at)
      SELECT ${tenantId}::uuid, r.id, r.key, r.hash, r.customer_id, r.meter_id, r.quantity::bigint,
             r.dimension, r.occurred_at, r.effective_at, ${now}::timestamptz
      FROM jsonb_to_recordset(${asJson(rows)}::text::jsonb) AS r(
        id uuid, key text, hash text, customer_id uuid, meter_id uuid, quantity text,
        dimension text, occurred_at timestamptz, effective_at timestamptz)
      ORDER BY r.key COLLATE "C"
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING idempotency_key`;
    const insertedKeys = new Set<string>(inserted.map((r: { idempotency_key: string }) => r.idempotency_key));

    const existingKeys = prepared.map((p) => p.item.event.idempotencyKey).filter((k) => !insertedKeys.has(k));
    const storedHashes = new Map<string, string>();
    if (existingKeys.length > 0) {
      const stored = await tx`SELECT idempotency_key, payload_hash FROM events
                              WHERE tenant_id = ${tenantId} AND idempotency_key = ANY(${tx.array(existingKeys, "TEXT")})`;
      for (const row of stored as { idempotency_key: string; payload_hash: string }[]) {
        storedHashes.set(row.idempotency_key, row.payload_hash);
      }
    }

    const effectiveByKey = new Map(rows.map((r) => [r.key, r.effective_at]));
    prepared.forEach(({ index, item }) => {
      const key = item.event.idempotencyKey;
      if (insertedKeys.has(key)) {
        const effective = new Date(effectiveByKey.get(key) as string);
        results.set(index, {
          idempotencyKey: key,
          status: "accepted",
          late: effective.getTime() > item.event.timestamp.getTime(),
          effectiveAt: effective,
        });
      } else {
        results.set(
          index,
          storedHashes.get(key) === item.hash
            ? { idempotencyKey: key, status: "duplicate" }
            : { idempotencyKey: key, status: "conflict", reason: "idempotency_key_reused_with_different_payload" },
        );
      }
    });
    return events.map((_, i) => results.get(i) as IngestResult);
  });
}
