"use strict";

// A deterministic large *single-source* diagnostic. It deliberately keeps the
// root cause and remediation near the beginning and end, while the middle
// resembles the repetitive retry/stack noise of a real service incident.
// No files, network, clock, or dependencies are used.

const lines = [
  "2026-09-02T00:00:00.000Z checkout-api ERROR checkout request failed after retry budget exhausted",
  "ROOT_CAUSE code=CONFIG_MISSING component=payments-client key=PAYMENTS_API_URL",
  "DETAIL payments-client was constructed before PAYMENTS_API_URL was configured; all downstream ECONNREFUSED errors are symptoms.",
  "REMEDIATION set PAYMENTS_API_URL in the checkout-api runtime environment, then restart the service.",
  "",
];

for (let attempt = 1; attempt <= 72; attempt += 1) {
  lines.push(`2026-09-02T00:00:${String(attempt).padStart(2, "0")}.000Z checkout-api WARN retry=${attempt}/72 operation=authorize-payment upstream=payments-client error=ECONNREFUSED`);
  lines.push("    at requestAuthorization (src/payments-client.js:84:17)");
  lines.push("    at createCheckout (src/checkout-service.js:191:29)");
  lines.push("    at handleCheckout (src/http-handler.js:57:11)");
  lines.push("    caused by Error: connect ECONNREFUSED 127.0.0.1:443");
  lines.push("    diagnostic-context request_id=smoke-checkout customer=redacted payment_method=redacted");
}

lines.push("");
lines.push("INCIDENT_SUMMARY repeated connection errors are secondary; investigate CONFIG_MISSING before networking.");
lines.push("ROOT_CAUSE_CONFIRMED component=payments-client missing_key=PAYMENTS_API_URL");
lines.push("SAFE_NEXT_STEP configure PAYMENTS_API_URL and restart checkout-api; do not change application code for this incident.");

process.stdout.write(`${lines.join("\n")}\n`);
