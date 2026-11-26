import type { Hono } from "hono";
import { grantCredit, listCredits } from "../../services/credits.ts";
import { createCustomer, getCustomer } from "../../services/customers.ts";
import { type AppDeps, type Env, parseBody, send, uuidParam } from "../context.ts";
import { creditBody, customerBody } from "../schemas.ts";
import { creditView, customerView } from "../views.ts";

export function customerRoutes(app: Hono<Env>, { db, clock }: AppDeps): void {
  app.post("/v1/customers", async (c) => {
    const body = await parseBody(c, customerBody);
    const customer = await createCustomer(db, clock, c.get("tenantId"), {
      externalId: body.external_id,
      name: body.name,
      email: body.email,
    });
    return send(c, customerView(customer), 201);
  });

  app.get("/v1/customers/:id", async (c) =>
    send(c, customerView(await getCustomer(db, c.get("tenantId"), uuidParam(c, "id", "customer")))),
  );

  app.post("/v1/customers/:id/credits", async (c) => {
    const body = await parseBody(c, creditBody);
    const { entry, created } = await grantCredit(db, clock, c.get("tenantId"), uuidParam(c, "id", "customer"), {
      currency: body.currency,
      amountMinor: body.amount,
      reason: body.reason,
      idempotencyKey: body.idempotency_key,
    });
    return send(c, creditView(entry), created ? 201 : 200);
  });

  app.get("/v1/customers/:id/credits", async (c) => {
    const { balances, entries } = await listCredits(db, c.get("tenantId"), uuidParam(c, "id", "customer"));
    return send(c, { balances, entries: entries.map(creditView) });
  });
}
