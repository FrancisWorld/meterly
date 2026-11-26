import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  STRIPE_WEBHOOK_SECRET: z.string().min(16, "use a long random secret"),
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  /** Events older than this are rejected outright instead of being billed late. */
  MAX_EVENT_AGE_DAYS: z.coerce.number().int().positive().default(35),
  /** Events dated further than this into the future are rejected (clock skew allowance). */
  MAX_CLOCK_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(300),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(25),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${problems}`);
  }
  return parsed.data;
}
