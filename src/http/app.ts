import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "../errors.ts";
import { receiveWebhook } from "../services/webhooks.ts";
import { requireApiKey } from "./auth.ts";
import { type AppDeps, type Env, send } from "./context.ts";
import { billingRoutes } from "./routes/billing.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { customerRoutes } from "./routes/customers.ts";
import { eventRoutes } from "./routes/events.ts";

const tooLarge = (): never => {
  throw new AppError("payload_too_large", "request body too large");
};

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set("requestId", requestId);
    const started = performance.now();
    await next();
    c.header("x-request-id", requestId);
    deps.logger.info("request", {
      request_id: requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    try {
      await deps.db`SELECT 1`;
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });

  // Webhooks authenticate by signature over the raw body, not by API key.
  app.post("/webhooks/stripe", bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }), async (c) => {
    const raw = await c.req.text();
    const outcome = await receiveWebhook(
      deps.db,
      deps.clock,
      { secret: deps.config.STRIPE_WEBHOOK_SECRET, toleranceSeconds: deps.config.WEBHOOK_TOLERANCE_SECONDS },
      raw,
      c.req.header("stripe-signature") ?? null,
    );
    return send(c, { received: true, outcome });
  });

  app.use("/v1/*", bodyLimit({ maxSize: 4 * 1024 * 1024, onError: tooLarge }), requireApiKey(deps.db));
  catalogRoutes(app, deps);
  customerRoutes(app, deps);
  billingRoutes(app, deps);
  eventRoutes(app, deps);

  app.notFound((c) => c.json({ error: { code: "not_found", message: "route not found" } }, 404));

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } },
        error.status as 400,
      );
    }
    deps.logger.error("unhandled error", { request_id: c.get("requestId"), error: String(error) });
    return c.json({ error: { code: "internal_error", message: "internal server error" } }, 500);
  });

  return app;
}
