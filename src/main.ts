import { systemClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { createApp } from "./http/app.ts";
import { createLogger } from "./logger.ts";
import { FakeStripe } from "./stripe/fake.ts";
import { OutboxWorker } from "./worker/outbox-worker.ts";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDb(config.DATABASE_URL, config.DB_POOL_SIZE);

await migrate(db);

// The shipped binary talks to the deterministic in-memory Stripe: no real Stripe client exists in this repo.
// A production gateway would implement the same StripeGateway interface.
const gateway = new FakeStripe();
const worker = new OutboxWorker(db, gateway, systemClock, logger, {
  batchSize: config.OUTBOX_BATCH_SIZE,
  maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
  leaseSeconds: config.OUTBOX_LEASE_SECONDS,
  pollMs: config.OUTBOX_POLL_MS,
});

const app = createApp({ db, clock: systemClock, logger, config });
const server = Bun.serve({ port: config.PORT, fetch: app.fetch });
worker.start();
logger.info("meterly listening", { port: server.port });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  const force = setTimeout(() => {
    logger.error("shutdown timed out");
    process.exit(1);
  }, 15_000);
  try {
    await server.stop(); // stop accepting, let in-flight requests finish
    await worker.stop(); // finish the batch in flight
    await db.close();
    clearTimeout(force);
    process.exit(0);
  } catch (error) {
    logger.error("shutdown failed", { error: String(error) });
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
