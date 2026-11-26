import type { Hono } from "hono";
import { createMeter, createPlan, getPlan, listMeters } from "../../services/catalog.ts";
import { type AppDeps, type Env, parseBody, send, uuidParam } from "../context.ts";
import { meterBody, planBody } from "../schemas.ts";
import { meterView, planView } from "../views.ts";

export function catalogRoutes(app: Hono<Env>, { db, clock }: AppDeps): void {
  app.post("/v1/meters", async (c) => {
    const body = await parseBody(c, meterBody);
    return send(c, meterView(await createMeter(db, clock, c.get("tenantId"), body)), 201);
  });

  app.get("/v1/meters", async (c) => send(c, { data: (await listMeters(db, c.get("tenantId"))).map(meterView) }));

  app.post("/v1/plans", async (c) => {
    const body = await parseBody(c, planBody);
    const plan = await createPlan(db, clock, c.get("tenantId"), {
      code: body.code,
      currency: body.currency,
      baseFeeMinor: body.base_fee,
      items: body.items.map((i) => ({ meterCode: i.meter, pricing: i.pricing })),
    });
    return send(c, planView(plan), 201);
  });

  app.get("/v1/plans/:id", async (c) =>
    send(c, planView(await getPlan(db, c.get("tenantId"), uuidParam(c, "id", "plan")))),
  );
}
