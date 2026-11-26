import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { createDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { createLogger } from "../src/logger.ts";

describe("config", () => {
  const strong = "9f2c41d07b8e5a36c1d4f0a7e93b82c5d6a1f47e0b9c3d85a2e6f1047b9d3c8e";
  const base = { DATABASE_URL: "postgres://x", STRIPE_WEBHOOK_SECRET: strong };
  test("applies defaults", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      PORT: 3000,
      LOG_LEVEL: "info",
      WEBHOOK_TOLERANCE_SECONDS: 300,
      OUTBOX_MAX_ATTEMPTS: 8,
    });
  });
  test("coerces numbers and reports every problem", () => {
    expect(loadConfig({ ...base, PORT: "8080" }).PORT).toBe(8080);
    expect(() => loadConfig({ PORT: "99999", STRIPE_WEBHOOK_SECRET: "short" })).toThrow(
      /DATABASE_URL.*PORT.*STRIPE_WEBHOOK_SECRET/,
    );
  });
});

describe("logger", () => {
  test("writes JSON lines, serialises bigint and honours the level", () => {
    const lines: string[] = [];
    const original = [console.log, console.error];
    console.log = (l: string) => void lines.push(l);
    console.error = (l: string) => void lines.push(l);
    try {
      const log = createLogger("warn");
      log.info("hidden");
      log.debug("hidden");
      log.warn("shown", { amount: 10n });
      log.error("boom");
    } finally {
      [console.log, console.error] = original as [typeof console.log, typeof console.error];
    }
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.message)).toEqual(["shown", "boom"]);
    expect(parsed[0]).toMatchObject({ level: "warn", amount: "10" });
  });
});

describe("clock", () => {
  test("ManualClock only moves when told", () => {
    const clock = new ManualClock(new Date("2026-01-01T00:00:00Z"));
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.500Z");
    clock.set(new Date("2027-01-01T00:00:00Z"));
    expect(clock.now().getUTCFullYear()).toBe(2027);
    clock.now().setFullYear(1999); // callers cannot mutate the clock
    expect(clock.now().getUTCFullYear()).toBe(2027);
  });
});

describe("migrations", () => {
  test("re-running is a no-op, and concurrent runners apply each file once", async () => {
    const url = process.env.TEST_DATABASE_URL as string;
    const db = createDb(url, 5);
    try {
      expect(await migrate(db)).toEqual([]);

      const dir = await mkdtemp(join(tmpdir(), "meterly-mig-"));
      await writeFile(join(dir, "001_a.sql"), "CREATE TABLE IF NOT EXISTS mig_probe (n int);");
      await writeFile(join(dir, "002_b.sql"), "INSERT INTO mig_probe VALUES (1);");
      await writeFile(join(dir, "ignored.txt"), "nope");
      await db.unsafe(
        "DROP TABLE IF EXISTS mig_probe; DELETE FROM schema_migrations WHERE name IN ('001_a.sql','002_b.sql')",
      );
      const runs = await Promise.all([migrate(db, dir), migrate(db, dir), migrate(db, dir)]);
      expect(runs.flat().sort()).toEqual(["001_a.sql", "002_b.sql"]);
      expect(Number((await db`SELECT count(*)::int AS n FROM mig_probe`)[0].n)).toBe(1);
      await db.unsafe("DROP TABLE mig_probe; DELETE FROM schema_migrations WHERE name IN ('001_a.sql','002_b.sql')");
    } finally {
      await db.close();
    }
  });

  test("a failing migration rolls back completely", async () => {
    const db = createDb(process.env.TEST_DATABASE_URL as string, 2);
    try {
      const dir = await mkdtemp(join(tmpdir(), "meterly-mig-"));
      await writeFile(join(dir, "900_bad.sql"), "CREATE TABLE half_done (n int); SELECT * FROM does_not_exist;");
      await expect(migrate(db, dir)).rejects.toThrow();
      expect((await db`SELECT to_regclass('half_done') AS t`)[0].t).toBeNull();
      expect((await db`SELECT 1 FROM schema_migrations WHERE name = '900_bad.sql'`).length).toBe(0);
    } finally {
      await db.close();
    }
  });
});
