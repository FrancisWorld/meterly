import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/client.ts";

export const hashApiKey = (key: string): string => createHash("sha256").update(key).digest("hex");

export interface NewTenant {
  tenantId: string;
  /** Shown exactly once; only its SHA-256 is stored. */
  apiKey: string;
}

export async function createTenant(db: Db, clock: Clock, name: string, label = "default"): Promise<NewTenant> {
  const tenantId = randomUUID();
  const apiKey = `mtk_${randomBytes(32).toString("base64url")}`;
  const now = clock.now();
  await db.begin(async (tx) => {
    await tx`INSERT INTO tenants (id, name, created_at) VALUES (${tenantId}, ${name}, ${now})`;
    await tx`INSERT INTO tenant_counters (tenant_id) VALUES (${tenantId})`;
    await tx`INSERT INTO api_keys (key_hash, tenant_id, label, created_at)
             VALUES (${hashApiKey(apiKey)}, ${tenantId}, ${label}, ${now})`;
  });
  return { tenantId, apiKey };
}

/** Resolve a bearer token to its tenant. Only the hash is ever compared or stored. */
export async function authenticate(db: Db, apiKey: string): Promise<string | null> {
  const rows = await db`SELECT tenant_id FROM api_keys WHERE key_hash = ${hashApiKey(apiKey)}`;
  return rows.length === 0 ? null : (rows[0].tenant_id as string);
}
