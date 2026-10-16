#!/usr/bin/env bash
# Smoke test of a running stack (docker compose, or a deployed environment with BASE_URL and ADMIN_TOKEN):
# readiness, onboarding a test-mode merchant, an authenticated call, an AutoPay debit, the ops metrics.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_TOKEN="${ADMIN_TOKEN:-local-admin-token-change-me}"

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));if(v===undefined){console.error("missing "+process.argv[1]+" in "+s);process.exit(1)}console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
call() { # method path token [body] -> prints body, fails on non-2xx
  local method=$1 path=$2 token=$3 body=${4:-}
  local args=(-sS -X "$method" -H "authorization: Bearer $token" -w '\n%{http_code}')
  [[ -n "$body" ]] && args+=(-H 'content-type: application/json' --data "$body")
  local out code
  out=$(curl "${args[@]}" "$BASE_URL$path")
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  if [[ "$code" != 2* ]]; then echo "FAIL $method $path → $code $out" >&2; exit 1; fi
  printf '%s' "$out"
}

echo "waiting for $BASE_URL/readyz"
for i in $(seq 1 60); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/readyz")" == 200 ]] && break
  [[ $i == 60 ]] && { echo "FAIL not ready after 60 s" >&2; exit 1; }
  sleep 1
done
echo "ok   ready"

run=$(date +%s)
merchant=$(call POST /v1/merchants "$ADMIN_TOKEN" "{\"name\":\"Smoke $run\",\"webhookUrl\":\"https://example.com/hooks\"}")
key=$(json apiKey <<<"$merchant")
[[ "$key" == sk_test_* ]] || { echo "FAIL expected a test-mode key, got $key" >&2; exit 1; }
echo "ok   onboarded a test-mode merchant"

call GET /v1/rules "$key" | json id >/dev/null
echo "ok   authenticated call"

mandate=$(call POST /v1/mandates "$key" "{\"mandateRef\":\"SMOKE-$run\",\"customerVpa\":\"smoke@okaxis\",\"maxAmountPaise\":50000}")
debit=$(call POST "/v1/mandates/$(json id <<<"$mandate")/debits" "$key" "{\"amountPaise\":19900,\"idempotencyKey\":\"smoke-$run\"}")
echo "ok   AutoPay debit $(json id <<<"$debit") is $(json state <<<"$debit")"

metrics=$(call GET /v1/admin/ops/metrics "$ADMIN_TOKEN")
[[ "$(json restrictedWindowExecutions <<<"$metrics")" == 0 ]] || { echo "FAIL restricted-window executions: $metrics" >&2; exit 1; }
echo "ok   ops metrics $metrics"
echo "smoke test passed"
