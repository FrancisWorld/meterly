#!/usr/bin/env bash
# End-to-end walkthrough against a running Meterly (see README quickstart).
#   API_KEY=mtk_... STRIPE_WEBHOOK_SECRET=... scripts/demo.sh
# Needs curl, jq and bun. The Stripe side is the in-process fake, so nothing leaves your machine.
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:3000}"
: "${API_KEY:?set API_KEY (bun run tenant:create <name>)}"
: "${STRIPE_WEBHOOK_SECRET:?set STRIPE_WEBHOOK_SECRET to the value the server runs with}"
RUN="$(date +%s)"

api() { # method path [json]
  curl -sS -X "$1" "$BASE$2" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' ${3:+-d "$3"}
}
iso() { bun -e "console.log(new Date(Date.now() + ($1) * 864e5).toISOString())"; }

START="$(iso -40)"   # subscription anchored 40 days ago: its first period has already ended
USAGE_AT="$(iso -30)"

echo "# catalog"
api POST /v1/meters '{"code":"api_calls","aggregation":"sum"}' >/dev/null
api POST /v1/meters '{"code":"active_users","aggregation":"unique","property":"user"}' >/dev/null
PLAN=$(api POST /v1/plans '{
  "code":"growth-'"$RUN"'","currency":"usd","base_fee":4900,
  "items":[
    {"meter":"api_calls","pricing":{"model":"graduated","tiers":[
      {"up_to":1000,"unit_amount":"0"},{"up_to":10000,"unit_amount":"0.5"},{"up_to":null,"unit_amount":"0.2"}]}},
    {"meter":"active_users","pricing":{"model":"package","package_size":25,"package_amount":"1500"}}]}' | jq -r .id)
CUSTOMER=$(api POST /v1/customers '{"external_id":"demo-'"$RUN"'","name":"Initech","email":"ap@initech.example"}' | jq -r .id)
SUB=$(api POST /v1/subscriptions '{"customer_id":"'"$CUSTOMER"'","plan_id":"'"$PLAN"'","started_at":"'"$START"'"}' | jq -r .id)

echo "# ingest (twice: the replay must be all duplicates)"
EVENTS='{"events":[
  {"idempotency_key":"'"$RUN"'-1","customer":"demo-'"$RUN"'","meter":"api_calls","timestamp":"'"$USAGE_AT"'","quantity":5000},
  {"idempotency_key":"'"$RUN"'-2","customer":"demo-'"$RUN"'","meter":"api_calls","timestamp":"'"$USAGE_AT"'","quantity":7000},
  {"idempotency_key":"'"$RUN"'-3","customer":"demo-'"$RUN"'","meter":"active_users","timestamp":"'"$USAGE_AT"'","properties":{"user":"ann"}},
  {"idempotency_key":"'"$RUN"'-4","customer":"demo-'"$RUN"'","meter":"active_users","timestamp":"'"$USAGE_AT"'","properties":{"user":"bob"}},
  {"idempotency_key":"'"$RUN"'-5","customer":"demo-'"$RUN"'","meter":"active_users","timestamp":"'"$USAGE_AT"'","properties":{"user":"ann"}}]}'
api POST /v1/events "$EVENTS" | jq -c .summary
api POST /v1/events "$EVENTS" | jq -c .summary

echo "# invoice preview"
api GET "/v1/subscriptions/$SUB/invoice-preview" | jq '{period_start, period_end, lines: [.lines[] | {description, quantity, amount}], subtotal, amount_due}'

echo "# finalize"
INVOICE=$(api POST "/v1/subscriptions/$SUB/invoices" '{}' | jq -r .id)
api GET "/v1/invoices/$INVOICE" | jq '{number, status, amount_due, stripe_invoice_id}'

echo "# wait for the outbox worker to push it to Stripe (fake)"
for _ in $(seq 1 20); do
  STRIPE_INVOICE=$(api GET "/v1/invoices/$INVOICE" | jq -r '.stripe_invoice_id // empty')
  [ -n "$STRIPE_INVOICE" ] && break
  sleep 1
done
echo "stripe invoice: $STRIPE_INVOICE"

echo "# signed webhook: invoice.paid"
EVENT='{"id":"evt_demo_'"$RUN"'","type":"invoice.paid","created":'"$(date +%s)"',"data":{"object":{"id":"'"$STRIPE_INVOICE"'"}}}'
SIG="$(bun "$(dirname "$0")/sign-webhook.ts" "$EVENT")"
curl -sS -X POST "$BASE/webhooks/stripe" -H "stripe-signature: $SIG" -d "$EVENT"; echo
echo "# same event again (dedupe), then a forged one"
curl -sS -X POST "$BASE/webhooks/stripe" -H "stripe-signature: $SIG" -d "$EVENT"; echo
curl -sS -X POST "$BASE/webhooks/stripe" -H "stripe-signature: t=1,v1=00" -d "$EVENT"; echo
api GET "/v1/invoices/$INVOICE" | jq '{number, status, amount_due, stripe_invoice_id}'
