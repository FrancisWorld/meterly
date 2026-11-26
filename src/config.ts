import { z } from "zod";

export const MIN_SECRET_LENGTH = 32;

const PLACEHOLDER =
  /changeme|change-me|replace-?me|placeholder|your[-_]?secret|example|whsec_?x*$|^(secret|dev|test|password)+$/i;

/**
 * The webhook secret is the only thing standing between the internet and "mark this invoice paid",
 * so a missing, short, low-entropy or placeholder value is a startup error, never a default.
 * Generate one with `openssl rand -hex 32`.
 */
export function secretProblem(value: string): string | null {
  if (value.length < MIN_SECRET_LENGTH)
    return `must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -hex 32)`;
  if (PLACEHOLDER.test(value)) return "looks like a placeholder; generate a real one with: openssl rand -hex 32";
  if (new Set(value).size < 8) return "has too little variety to be random; generate one with: openssl rand -hex 32";
  return null;
}

const webhookSecret = z.string({ required_error: "is required (openssl rand -hex 32)" }).superRefine((value, ctx) => {
  const problem = secretProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  STRIPE_WEBHOOK_SECRET: webhookSecret,
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
