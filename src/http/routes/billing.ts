import type { Hono } from "hono";
import { finalizeInvoice, getInvoice, previewInvoice } from "../../services/invoicing.ts";
import { changePlan, createSubscription, getSubscription } from "../../services/subscriptions.ts";
import { usageReport } from "../../services/usage.ts";
import { type AppDeps, type Env, parseBody, parseWith, send, uuidParam } from "../context.ts";
import { changePlanBody, finalizeBody, subscriptionBody, usageQuery } from "../schemas.ts";
import { invoiceView, previewView, subscriptionView } from "../views.ts";

export function billingRoutes(app: Hono<Env>, { db, clock }: AppDeps): void {
  app.post("/v1/subscriptions", async (c) => {
    const body = await parseBody(c, subscriptionBody);
    const sub = await createSubscription(db, clock, c.get("tenantId"), {
      customerId: body.customer_id,
      planId: body.plan_id,
      startedAt: body.started_at,
    });
    return send(c, subscriptionView(sub), 201);
  });

  app.get("/v1/subscriptions/:id", async (c) =>
    send(c, subscriptionView(await getSubscription(db, c.get("tenantId"), uuidParam(c, "id", "subscription")))),
  );

  app.post("/v1/subscriptions/:id/change-plan", async (c) => {
    const body = await parseBody(c, changePlanBody);
    const { subscription, adjustmentMinor } = await changePlan(
      db,
      clock,
      c.get("tenantId"),
      uuidParam(c, "id", "subscription"),
      body.plan_id,
    );
    return send(c, { ...subscriptionView(subscription), proration_adjustment: adjustmentMinor });
  });

  app.get("/v1/subscriptions/:id/invoice-preview", async (c) =>
    send(c, previewView(await previewInvoice(db, c.get("tenantId"), uuidParam(c, "id", "subscription")))),
  );

  app.post("/v1/subscriptions/:id/invoices", async (c) => {
    const raw = await c.req.text();
    const body = parseWith(finalizeBody, raw.trim() === "" ? {} : safeJson(raw));
    const { invoice, created } = await finalizeInvoice(
      db,
      clock,
      c.get("tenantId"),
      uuidParam(c, "id", "subscription"),
      body.period_start,
    );
    return send(c, invoiceView(invoice), created ? 201 : 200);
  });

  app.get("/v1/invoices/:id", async (c) =>
    send(c, invoiceView(await getInvoice(db, c.get("tenantId"), uuidParam(c, "id", "invoice")))),
  );

  app.get("/v1/usage", async (c) => {
    const q = parseWith(usageQuery, c.req.query());
    const report = await usageReport(db, c.get("tenantId"), {
      customerId: q.customer_id,
      meterCode: q.meter,
      from: q.from,
      to: q.to,
      window: q.window,
    });
    return send(c, {
      meter: report.meter,
      aggregation: report.aggregation,
      from: report.from,
      to: report.to,
      total: report.total,
      buckets: report.buckets.map((b) => ({ start: b.start, quantity: b.quantity })),
    });
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return parseWith(finalizeBody, null);
  }
}
