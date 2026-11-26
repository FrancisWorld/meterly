import { buildSignatureHeader } from "../src/stripe/signature.ts";

/**
 * Prints a `Stripe-Signature` header for a webhook body, signed locally with the shared secret.
 *   STRIPE_WEBHOOK_SECRET=... bun scripts/sign-webhook.ts '{"id":"evt_1",...}'
 */
const secret = process.env.STRIPE_WEBHOOK_SECRET;
const body = process.argv[2];
if (!secret || !body) {
  console.error("usage: STRIPE_WEBHOOK_SECRET=... bun scripts/sign-webhook.ts '<raw json body>'");
  process.exit(1);
}
console.log(buildSignatureHeader(secret, Math.floor(Date.now() / 1000), body));
