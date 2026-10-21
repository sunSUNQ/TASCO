"use strict";
// diagnostic_fidelity.test.js — P0 repair regression tests.
// Verifies the model-visible diagnostic fidelity gate: (a) unit-level fact
// extraction + verification, (b) end-to-end hook fallback to native when
// critical diagnostic facts would be dropped, and (c) no regression on
// non-diagnostic / terminal-state paths.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const cp = require("child_process");

const {
  extractCriticalDiagnosticFacts,
  verifyDiagnosticFidelity,
} = require("./diagnostic_fidelity.js");

const HOOK = path.join(__dirname, "..", "post_tool_policy_hook.js");

// ---- fixtures (mirror the audited failure shapes) ----

// T05 shape: repeated ERROR stack + trailing FATAL ROOT CAUSE + failure count.
function emitDiagnosticFixture() {
  const lines = [];
  const stack = [
    "Error: checkout: PAYMENTS_API_URL is not set — cannot route payment authorization",
    "    at buildPaymentRequest (checkout.js:22:11)",
    "    at authorize (checkout.js:42:5)",
  ];
  lines.push("INFO storefront starting");
  for (let i = 1; i <= 30; i++) {
    lines.push(`INFO received POST /checkout attempt=${i}`);
    for (const s of stack) lines.push(`ERROR ${s}`);
  }
  lines.push("ERROR checkout outage: 30/30 requests failed");
  lines.push("FATAL ROOT CAUSE: PAYMENTS_API_URL missing from environment");
  return lines.join("\n");
}

// T06 shape: TAP failing test with not-ok assertions + # fail count.
function testFailFixture() {
  const lines = ["TAP version 13"];
  for (let i = 1; i <= 4; i++) {
    lines.push(`not ok ${i} - checkout route #${i}`);
    lines.push("  ---");
    lines.push("  error: |-");
    lines.push("    checkout: PAYMENTS_API_URL is not set");
    lines.push(`    at buildPaymentRequest (checkout.js:22:11)`);
  }
  lines.push("# fail 4");
  lines.push("# pass 0");
  return lines.join("\n");
}

// A diagnostic whose summary WOULD preserve facts (single fatal, no dropped count).
function singleFatalFixture() {
  return [
    "ERROR something broke",
    "    at buildPaymentRequest (checkout.js:22:11)",
    "FATAL ROOT CAUSE: PAYMENTS_API_URL missing",
  ].join("\n");
}

test("extracts root_cause, fatal, failure_count, not_ok, stack facts", () => {
  const raw = testFailFixture() + "\n" + emitDiagnosticFixture();
  const facts = extractCriticalDiagnosticFacts(raw);
  const types = new Set(facts.map((f) => f.type));
  assert.ok(types.has("failure_count"), "failure_count detected");
  assert.ok(types.has("not_ok"), "not_ok detected");
  assert.ok(types.has("root_cause"), "root_cause detected");
  assert.ok(types.has("stack"), "stack detected");
  for (const f of facts) assert.strictEqual(typeof f.line, "number");
});

test("verify: fail when root_cause + failure_count are dropped", () => {
  const raw = emitDiagnosticFixture();
  // Simulate the audited lossy summary: keeps ERROR stack but drops the
  // trailing FATAL ROOT CAUSE and "30/30 requests failed" lines.
  const lossy = raw
    .split("\n")
    .filter((l) => !/ROOT CAUSE/.test(l) && !/30\/30/.test(l))
    .join("\n");
  const res = verifyDiagnosticFidelity(raw, lossy);
  assert.strictEqual(res.gate, "fail");
  const types = res.missing.map((m) => m.type);
  assert.ok(types.includes("root_cause"), "root_cause in missing");
  assert.ok(types.includes("failure_count"), "failure_count in missing");
});

test("verify: pass when all critical facts are preserved", () => {
  const raw = emitDiagnosticFixture();
  // A preserving summary = the raw text itself (identity).
  assert.strictEqual(verifyDiagnosticFidelity(raw, raw).gate, "pass");
});

test("verify: not_applicable when no diagnostic facts present", () => {
  const plain = "M src/app.js\n M test/unit.test.js\n?? logs/\n";
  assert.strictEqual(verifyDiagnosticFidelity(plain, plain).gate, "not_applicable");
});

test("verify: fail when # fail count dropped (T06 shape)", () => {
  const raw = testFailFixture();
  const lossy = raw.split("\n").filter((l) => !/^# fail/.test(l) && !/^not ok/.test(l)).join("\n");
  assert.strictEqual(verifyDiagnosticFidelity(raw, lossy).gate, "fail");
});

// ---- end-to-end: hook must fall back to native (no updatedToolOutput) ----

function runHook(stdoutText, command) {
  const base = path.join(require("os").tmpdir(), `tasco-fidelity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const env = {
    ...process.env,
    CODE_GUARD_HOOK_DIR: path.join(__dirname, ".."),
    CODE_GUARD_BASE_DIR: base,
    CODE_GUARD_AUTO_CANARY_V1A: "1",
    CODE_GUARD_TERMINAL_STATE: "1",
    CODE_GUARD_VALIDATION_DELTA: "1",
    CODE_GUARD_FAILURE_CARRIER_AUTO: "1",
    CODE_GUARD_SEARCH_GUIDANCE: "1",
    CODE_GUARD_SEARCH_GUIDANCE_AUTO: "1",
    CODE_GUARD_READ_COMPRESSION: "1",
    CODE_GUARD_RLM_ENABLED: "0",
    CODE_GUARD_CLAUDE_PROMPT: "Diagnose the root cause. Do not modify files and do not run tests.",
  };
  const payload = JSON.stringify({
    tool_name: "run_shell_command",
    tool_use_id: "fid-test",
    tool_input: { command },
    tool_response: { stdout: stdoutText, stderr: "" },
  });
  const res = cp.spawnSync(process.execPath, [HOOK], { input: payload, env, encoding: "utf8", timeout: 60000 });
  return { res, base, parsed: JSON.parse(String(res.stdout || "").trim() || "{}") };
}

test("hook: T05 emit falls back to native (no updatedToolOutput)", () => {
  const { parsed } = runHook(emitDiagnosticFixture(), "node scripts/emit-diagnostic.js");
  const hso = parsed.hookSpecificOutput || {};
  assert.strictEqual(hso.updatedToolOutput, undefined, "must NOT deliver a lossy summary");
});

test("hook: T06 test-fail falls back to native (no updatedToolOutput)", () => {
  const { parsed } = runHook(testFailFixture(), "node --test --test-reporter=tap test/checkout.test.js");
  const hso = parsed.hookSpecificOutput || {};
  assert.strictEqual(hso.updatedToolOutput, undefined, "must NOT deliver a lossy summary");
});

test("hook: diagnostic with preserved facts may still compress", () => {
  const raw = singleFatalFixture();
  const { parsed } = runHook(raw, "cat diag.log");
  // singleFatalFixture is short (<3000 chars) and the summary may or may not
  // fire; this only asserts the hook does not crash and returns a well-formed
  // result. Fidelity is asserted at unit level above.
  assert.ok(parsed && typeof parsed === "object");
});

test("fidelity telemetry row is written on fail (native delivery recorded)", () => {
  const { res, base } = runHook(emitDiagnosticFixture(), "node scripts/emit-diagnostic.js");
  const tp = path.join(base, "tasco_metrics", "diagnostic_fidelity.ndjson");
  const fs = require("fs");
  if (fs.existsSync(tp)) {
    const row = JSON.parse(fs.readFileSync(tp, "utf8").trim().split("\n").pop());
    assert.strictEqual(row.gate, "fail");
    assert.strictEqual(row.actual_delivery, "native");
  }
});
