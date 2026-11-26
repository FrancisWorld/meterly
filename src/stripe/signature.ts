import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe-compatible webhook signatures: header `t=<unix>,v1=<hex>[,v1=<hex>...]`
 * where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Several v1 entries are
 * accepted so a secret can be rotated without dropping events.
 */
export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function buildSignatureHeader(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}

export type SignatureFailure =
  | "missing_header"
  | "malformed_header"
  | "timestamp_outside_tolerance"
  | "no_matching_signature";

export type SignatureResult = { ok: true; timestamp: number } | { ok: false; reason: SignatureFailure };

export interface VerifyInput {
  header: string | null | undefined;
  rawBody: string;
  secret: string;
  nowMs: number;
  toleranceSeconds: number;
}

export function verifySignature(input: VerifyInput): SignatureResult {
  if (!input.header) return { ok: false, reason: "missing_header" };
  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of input.header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) return { ok: false, reason: "malformed_header" };
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      if (!/^\d{1,12}$/.test(value)) return { ok: false, reason: "malformed_header" };
      timestamp = Number(value);
    } else if (key === "v1") {
      candidates.push(value);
    }
  }
  if (timestamp === undefined || candidates.length === 0) return { ok: false, reason: "malformed_header" };

  // The signature is checked before the clock so a forged header never reveals the tolerance behaviour.
  const expected = Buffer.from(computeSignature(input.secret, timestamp, input.rawBody), "hex");
  const matched = candidates.some((candidate) => {
    const given = Buffer.from(candidate, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matched) return { ok: false, reason: "no_matching_signature" };

  if (Math.abs(input.nowMs / 1000 - timestamp) > input.toleranceSeconds) {
    return { ok: false, reason: "timestamp_outside_tolerance" };
  }
  return { ok: true, timestamp };
}
