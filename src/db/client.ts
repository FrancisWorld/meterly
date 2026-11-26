import { SQL } from "bun";

export type Db = SQL;
/** Either the pool or a transaction handle: services accept both. */
export type Queryable = SQL;

export function createDb(url: string, poolSize: number): Db {
  return new SQL({ url, max: poolSize, idleTimeout: 30, connectionTimeout: 10 });
}

export const num = (value: unknown): bigint => BigInt(value as string | number | bigint);
export const iso = (value: Date): string => value.toISOString();
export const asJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** True for a PostgreSQL unique_violation (SQLSTATE 23505). */
export const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { errno?: string }).errno === "23505";
