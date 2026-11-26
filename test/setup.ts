import { SQL } from "bun";
import { createDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";

/** Preload: make sure the throwaway test database exists and is migrated. Never touches any other database. */
const url = process.env.TEST_DATABASE_URL ?? "postgres://meterly:meterly@localhost:5432/meterly_test";
const target = new URL(url);
const dbName = target.pathname.slice(1);
if (!dbName.endsWith("_test")) throw new Error(`refusing to run tests against "${dbName}": name must end in _test`);

const admin = new URL(url);
admin.pathname = "/postgres";
const adminDb = new SQL({ url: admin.toString(), max: 1 });
try {
  const exists = await adminDb`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
  if (exists.length === 0) await adminDb.unsafe(`CREATE DATABASE "${dbName}"`);
} finally {
  await adminDb.close();
}

const db = createDb(url, 2);
try {
  await migrate(db);
} finally {
  await db.close();
}
process.env.TEST_DATABASE_URL = url;
