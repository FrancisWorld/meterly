import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import fc from "fast-check";
import { buildSignatureHeader, computeSignature, verifySignature } from "../../src/stripe/signature.ts";

const secret = "whsec-unit-test-secret-abcdef012345";
const now = 1_800_000_000;
const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
const verify = (header: string | null, over: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
  verifySignature({ header, rawBody: body, secret, nowMs: now * 1000, toleranceSeconds: 300, ...over });

describe("verifySignature", () => {
  test("accepts a correctly signed, fresh payload", () => {
    expect(verify(buildSignatureHeader(secret, now, body))).toEqual({ ok: true, timestamp: now });
  });

  test("matches an independently computed HMAC-SHA256 value", () => {
    // echo -n "1.x" | openssl dgst -sha256 -hmac key
    expect(computeSignature("key", 1, "x")).toBe(createHmac("sha256", "key").update("1.x").digest("hex"));
    expect(computeSignature("key", 1, "x")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects a missing or malformed header", () => {
    expect(verify(null)).toEqual({ ok: false, reason: "missing_header" });
    expect(verify("")).toEqual({ ok: false, reason: "missing_header" });
    expect(verify("garbage")).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify("t=abc,v1=00")).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify(`v1=${"0".repeat(64)}`)).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify(`t=${now}`)).toEqual({ ok: false, reason: "malformed_header" });
  });

  test("rejects a signature made with another secret", () => {
    expect(verify(buildSignatureHeader("another-secret-another-secret", now, body))).toEqual({
      ok: false,
      reason: "no_matching_signature",
    });
  });

  test("rejects a tampered body", () => {
    const header = buildSignatureHeader(secret, now, body);
    expect(verify(header, { rawBody: body.replace("paid", "void") })).toEqual({
      ok: false,
      reason: "no_matching_signature",
    });
  });

  test("rejects a timestamp that was altered after signing", () => {
    const sig = computeSignature(secret, now, body);
    expect(verify(`t=${now + 1},v1=${sig}`)).toEqual({ ok: false, reason: "no_matching_signature" });
  });

  test("rejects non-hex and wrong-length signatures without throwing", () => {
    expect(verify(`t=${now},v1=zzzz`)).toEqual({ ok: false, reason: "no_matching_signature" });
    expect(verify(`t=${now},v1=abcd`)).toEqual({ ok: false, reason: "no_matching_signature" });
  });

  test("replay window: stale and future timestamps are rejected, edges are inclusive", () => {
    const at = (ts: number) => verify(buildSignatureHeader(secret, ts, body));
    expect(at(now - 300)).toEqual({ ok: true, timestamp: now - 300 });
    expect(at(now - 301)).toEqual({ ok: false, reason: "timestamp_outside_tolerance" });
    expect(at(now + 300)).toEqual({ ok: true, timestamp: now + 300 });
    expect(at(now + 301)).toEqual({ ok: false, reason: "timestamp_outside_tolerance" });
  });

  test("any one of several v1 signatures may match (secret rotation)", () => {
    const old = computeSignature("old-secret-old-secret-old", now, body);
    const fresh = computeSignature(secret, now, body);
    expect(verify(`t=${now},v1=${old},v1=${fresh}`).ok).toBe(true);
    expect(verify(`t=${now},v1=${old},v1=${old}`).ok).toBe(false);
  });

  test("property: flipping any single character of the body invalidates the signature", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), fc.nat(), (payload, position) => {
        const header = buildSignatureHeader(secret, now, payload);
        const index = position % payload.length;
        const changed = payload.slice(0, index) + (payload[index] === "a" ? "b" : "a") + payload.slice(index + 1);
        expect(verify(header, { rawBody: payload }).ok).toBe(true);
        expect(verify(header, { rawBody: changed }).ok).toBe(false);
      }),
    );
  });
});
