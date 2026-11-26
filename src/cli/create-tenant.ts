import { systemClock } from "../clock.ts";
import { createDb } from "../db/client.ts";
import { createTenant } from "../services/tenants.ts";

const name = process.argv[2];
const url = process.env.DATABASE_URL;
if (!name || !url) {
  console.error("usage: DATABASE_URL=... bun run tenant:create <tenant-name>");
  process.exit(1);
}
const db = createDb(url, 2);
try {
  const { tenantId, apiKey } = await createTenant(db, systemClock, name);
  console.log(JSON.stringify({ tenant_id: tenantId, api_key: apiKey }, null, 2));
  console.error("Store the API key now: only its hash is kept.");
} finally {
  await db.close();
}
