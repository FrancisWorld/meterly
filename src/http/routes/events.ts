import type { Hono } from "hono";
import { ingestEvents } from "../../services/ingestion.ts";
import { type AppDeps, type Env, parseBody, send } from "../context.ts";
import { eventsBody } from "../schemas.ts";
import { ingestView } from "../views.ts";

export function eventRoutes(app: Hono<Env>, { db, clock, config }: AppDeps): void {
  app.post("/v1/events", async (c) => {
    const body = await parseBody(c, eventsBody);
    const results = await ingestEvents(
      db,
      clock,
      c.get("tenantId"),
      body.events.map((e) => ({
        idempotencyKey: e.idempotency_key,
        customer: e.customer,
        meter: e.meter,
        timestamp: e.timestamp,
        quantity: e.quantity,
        properties: e.properties,
      })),
      {
        maxEventAgeMs: config.MAX_EVENT_AGE_DAYS * 86_400_000,
        maxClockSkewMs: config.MAX_CLOCK_SKEW_SECONDS * 1000,
      },
    );
    const summary = { accepted: 0, duplicate: 0, rejected: 0, conflict: 0 };
    for (const r of results) summary[r.status] += 1;
    return send(c, { summary, results: results.map(ingestView) });
  });
}
