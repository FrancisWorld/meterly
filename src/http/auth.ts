import type { MiddlewareHandler } from "hono";
import type { Db } from "../db/client.ts";
import { AppError } from "../errors.ts";
import { authenticate } from "../services/tenants.ts";
import type { Env } from "./context.ts";

/** Bearer-token auth. The token is hashed and looked up; the tenant comes only from that lookup, never from the request. */
export function requireApiKey(db: Db): MiddlewareHandler<Env> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const tenantId = match ? await authenticate(db, match[1] as string) : null;
    if (!tenantId) throw new AppError("unauthorized", "missing or invalid API key");
    c.set("tenantId", tenantId);
    await next();
  };
}
