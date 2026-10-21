"use strict";
// diagnostic_fidelity.test.js — P0 R2 regression: three-state classification,
// cross-language/path recognition, and end-to-end hook fallback.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const cp = require("child_process");
const os = require("os");

const FID = require("./diagnostic_fidelity.js");
const HOOK = path.join(__dirname, "..", "post_tool_policy_hook.js");

function repeat(block, n) {
  const a = [];
  for (let i = 0; i < n; i++) for (const l of block) a.push(l.replace(/\{i\}/g, String(i)));
  return a.join("\n");
}

// ---- fixtures ----
const emitDiag = () => repeat([
  "ERROR Error: checkout: PAYMENTS_API_URL is not set",
  "    at buildPaymentRequest (checkout.js:22:11)",
  "    at authorize (checkout.js:42:5)",
], 30) + "\nERROR checkout outage: 30/30 requests failed\nFATAL ROOT CAUSE: PAYMENTS_API_URL missing";

const tapFail = () => repeat(["not ok {i} - route", "  ---", "  error: |-", "    PAYMENTS_API_URL is not set"], 8) + "\n# fail 8\n# pass 0";

const goFail = () => repeat(["=== RUN TestCheckout{i}", "--- FAIL: TestCheckout{i} (0.00s)", "    checkout_test.go:{i}2: expected got"], 60);
const javaFail = () => repeat(["Exception in thread \"main\" java.lang.IllegalStateException: boom", "\tat com.foo.Checkout.build(Checkout.java:{i})"], 80);
const winAbs = () => repeat(["ERROR Error: boom", "    at build (D:\\repo\\src\\checkout.js:22:{i})"], 80);
const uncAbs = () => repeat(["ERROR Error: boom", "    at build (\\\\server\\share\\checkout.js:22:{i})"], 80);
const rustPanic = () => repeat(["thread 'main' panicked at src/lib.rs:12:{i}: boom", "note: run with RUST_BACKTRACE=1"], 80);
const multiRoot = () => repeat(["FATAL ROOT CAUSE {i}: PAYMENTS_API_URL missing", "ERROR check failed"], 40);
const unknownExc = () => repeat(["Unexpected failure in checkout for request {i}: please verify configuration"], 80);
const successBuild = () => repeat(["compiling storefront v1.0.0", "  Finished release [optimized] target(s) in 1.2s", "0 errors, 0 warnings"], 40);
const errorProse = () => repeat(["This module provides error handling and error code mapping for the checkout flow.", "See the error handling section of docs/API.md for error code semantics."], 40);
const zeroStats = () => repeat(["tests: 40 passed, 0 failed, 0 errors"], 40);
const plainShell = () => repeat(["-rw-r--r--  1 user staff   1234 Feb 12 10:00 app.js", "-rw-r--r--  1 user staff   5678 Feb 12 10:00 checkout.js", "tree: 42 files"], 60);

function runHook(stdout, command) {
  const base = path.join(os.tmpdir(), `tasco-r2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const env = { ...process.env, CODE_GUARD_HOOK_DIR: path.join(__dirname, ".."), CODE_GUARD_BASE_DIR: base,
    CODE_GUARD_AUTO_CANARY_V1A: "1", CODE_GUARD_TERMINAL_STATE: "1", CODE_GUARD_VALIDATION_DELTA: "1",
    CODE_GUARD_FAILURE_CARRIER_AUTO: "1", CODE_GUARD_SEARCH_GUIDANCE: "1", CODE_GUARD_SEARCH_GUIDANCE_AUTO: "1",
    CODE_GUARD_READ_COMPRESSION: "1", CODE_GUARD_RLM_ENABLED: "0",
    CODE_GUARD_CLAUDE_PROMPT: "Diagnose the root cause. Do not modify files and do not run tests." };
  const payload = JSON.stringify({ tool_name: "run_shell_command", tool_use_id: "r2", tool_input: { command }, tool_response: { stdout, stderr: "" } });
  const res = cp.spawnSync(process.execPath, [HOOK], { input: payload, env, encoding: "utf8", timeout: 60000 });
  const parsed = JSON.parse(String(res.stdout || "").trim() || "{}");
  const u = (parsed.hookSpecificOutput || {}).updatedToolOutput;
  const delivered = typeof u === "string" ? u : u && u.stdout ? u.stdout : null;
  const fidFile = path.join(base, "tasco_metrics", "diagnostic_fidelity.ndjson");
  const fid = require("fs").existsSync(fidFile) ? require("fs").readFileSync(fidFile, "utf8").trim().split("\n").pop() : null;
  return { native: delivered === null, deliveredChars: delivered ? delivered.length : 0, fid: fid ? JSON.parse(fid) : null };
}

// ---- classification unit tests ----
test("classify: emit-diagnostic -> facts_identified", () => {
  const c = FID.classifyDiagnostic(emitDiag());
  assert.strictEqual(c.state, "facts_identified");
  const types = new Set(c.facts.map((f) => f.type));
  assert.ok(types.has("root_cause") && types.has("failure_count") && types.has("location"));
});

test("classify: TAP fail -> facts_identified", () => {
  const c = FID.classifyDiagnostic(tapFail());
  assert.strictEqual(c.state, "facts_identified");
});

test("classify: go/java/rust/win/unc -> not no_risk (diagnostic recognized)", () => {
  for (const f of [goFail, javaFail, rustPanic, winAbs, uncAbs, multiRoot]) {
    const c = FID.classifyDiagnostic(f());
    assert.notStrictEqual(c.state, "no_risk", `${f.name} must be recognized as diagnostic`);
  }
});

test("classify: go/java/rust/win/unc -> facts_identified (via location/marker/count)", () => {
  for (const [name, f] of [["go", goFail], ["java", javaFail], ["rust", rustPanic], ["winAbs", winAbs], ["uncAbs", uncAbs], ["multiRoot", multiRoot]]) {
    const c = FID.classifyDiagnostic(f());
    assert.strictEqual(c.state, "facts_identified", name);
  }
});

test("classify: unknown-exception-format -> uncertain", () => {
  assert.strictEqual(FID.classifyDiagnostic(unknownExc()).state, "uncertain");
});

test("classify: success/error-prose/zero-stats/plain -> no_risk", () => {
  for (const f of [successBuild, errorProse, zeroStats, plainShell]) {
    assert.strictEqual(FID.classifyDiagnostic(f()).state, "no_risk", f.name);
  }
});

test("locations: windows drive / UNC / linux / java / go / rust recognized", () => {
  const samples = [
    "at build (D:\\repo\\src\\checkout.js:22:11)",
    "at build (\\\\server\\share\\checkout.js:22:11)",
    "at build (src/checkout.js:22:11)",
    "at com.foo.Checkout.build(Checkout.java:22)",
    "checkout_test.go:42: message",
    "panicked at src/lib.rs:12:5",
    "File \"checkout.py\", line 22, in build",
  ];
  const all = samples.join("\n");
  const locs = FID.extractLocations(all);
  const anchors = locs.map((l) => l.anchor);
  assert.ok(anchors.some((a) => /checkout\.js:22/.test(a)), "checkout.js:22");
  assert.ok(anchors.some((a) => /Checkout\.java:22/.test(a)), "Checkout.java:22");
  assert.ok(anchors.some((a) => /checkout_test\.go:42/.test(a)), "checkout_test.go:42");
  assert.ok(anchors.some((a) => /lib\.rs:12/.test(a)), "lib.rs:12");
  assert.ok(anchors.some((a) => /checkout\.py:22/.test(a)), "checkout.py:22");
});

test("verify: facts missing -> fail; preserved -> pass; no_risk -> no_risk; uncertain -> fail", () => {
  const raw = emitDiag();
  const lossy = raw.split("\n").filter((l) => !/ROOT CAUSE/.test(l) && !/30\/30/.test(l)).join("\n");
  assert.strictEqual(FID.verifyDiagnosticFidelity(raw, lossy).gate, "fail");
  assert.strictEqual(FID.verifyDiagnosticFidelity(raw, raw).gate, "pass");
  assert.strictEqual(FID.verifyDiagnosticFidelity(plainShell(), plainShell()).gate, "no_risk");
  assert.strictEqual(FID.verifyDiagnosticFidelity(unknownExc(), unknownExc().slice(0, 100)).gate, "fail");
});

// ---- hook integration (large -> quick_shell path) ----
const diagCases = [["emit", emitDiag], ["tap", tapFail], ["go", goFail], ["java", javaFail], ["winAbs", winAbs], ["uncAbs", uncAbs], ["rust", rustPanic], ["multiRoot", multiRoot], ["unknown", unknownExc]];
for (const [name, f] of diagCases) {
  test(`hook: ${name} -> native fallback (no updatedToolOutput)`, () => {
    const r = runHook(f(), "run-diag");
    assert.strictEqual(r.native, true, `${name} must fall back to native`);
    assert.strictEqual(r.deliveredChars, 0);
    if (r.fid) {
      if (r.fid.diagnostic_risk_state === "uncertain") assert.strictEqual(r.fid.actual_delivery, "native");
      else { assert.strictEqual(r.fid.actual_delivery, "native"); assert.ok(r.fid.missing_fact_count > 0); }
    }
  });
}

test("hook: large non-diagnostic (success build) still compresses (no_risk proceeds)", () => {
  const r = runHook(successBuild(), "cargo build");
  assert.strictEqual(r.native, false, "success build must NOT be forced native");
  assert.ok(r.deliveredChars > 0);
});

test("hook: large plain shell still compresses (no_risk proceeds)", () => {
  const r = runHook(plainShell(), "ls -laR");
  assert.strictEqual(r.native, false, "plain shell must NOT be forced native");
});

test("telemetry: fail row records risk_state + fidelity_verdict + actual_delivery + rescued separate", () => {
  const r = runHook(emitDiag(), "node emit.js");
  const f = r.fid;
  assert.strictEqual(f.diagnostic_risk_state, "facts_identified");
  assert.strictEqual(f.fidelity_verdict, "facts_missing");
  assert.strictEqual(f.actual_delivery, "native");
  assert.ok("rescued" in f);
  assert.ok(f.rescued === null || f.rescued === false);
});

test("telemetry: uncertain row records risk_state=uncertain, actual_delivery=native", () => {
  const r = runHook(unknownExc(), "run-service");
  const f = r.fid;
  assert.strictEqual(f.diagnostic_risk_state, "uncertain");
  assert.strictEqual(f.fidelity_verdict, "uncertain");
  assert.strictEqual(f.actual_delivery, "native");
});