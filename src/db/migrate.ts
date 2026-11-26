import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./client.ts";

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const LOCK_ID = 7_340_001;

/** Apply pending `NNN_name.sql` files in order. Safe to run from several processes at once. */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await tx`SELECT name FROM schema_migrations`).map((r: { name: string }) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(await Bun.file(join(dir, file)).text());
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      applied.push(file);
    }
  });
  return applied;
}
