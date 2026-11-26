import type { Context } from "hono";
import type { z } from "zod";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { AppError, invalid, notFound } from "../errors.ts";
import type { Logger } from "../logger.ts";

export interface AppDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  config: Pick<
    Config,
    "STRIPE_WEBHOOK_SECRET" | "WEBHOOK_TOLERANCE_SECONDS" | "MAX_EVENT_AGE_DAYS" | "MAX_CLOCK_SKEW_SECONDS"
  >;
}

export type Env = { Variables: { tenantId: string; requestId: string } };
export type Ctx = Context<Env>;

const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/** JSON response. bigint values are written as decimal strings so no client ever loses precision. */
export function send(c: Ctx, body: unknown, status: 200 | 201 = 200): Response {
  return c.newResponse(JSON.stringify(body, bigintReplacer), status, { "content-type": "application/json" });
}

export async function parseBody<T extends z.ZodTypeAny>(c: Ctx, schema: T): Promise<z.output<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw invalid("request body must be valid JSON");
  }
  return parseWith(schema, json);
}

export function parseWith<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "validation_error",
      "request validation failed",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id can never match a row, so it is a 404 rather than a database error. */
export function uuidParam(c: Ctx, name: string, what: string): string {
  const value = c.req.param(name);
  if (!value || !UUID.test(value)) throw notFound(what);
  return value;
}
