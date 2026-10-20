"use strict";

// v0.9 D-1 limited-auto default wiring — flag truth table for
// CODE_GUARD_TEST_BUILD_STRUCTURED on the REAL post_tool_policy_hook chain:
//
//   1. env absent        -> ENABLED  (limited-auto product default)
//   2. env = "0"         -> DISABLED (hard kill-switch; legacy quick_shell path)
//   3. env = "1"         -> ENABLED  (byte-identical to absent)
//   4. other values      -> legacy semantics (DISABLED), contract not extended
//
// Positive fixture = frozen P1-P5 eligible shape (same construction as
// test_build_structured.test.js). Negative fixture = non test/build output;
// delivery must stay byte-identical between unset and "0" (negative zone is
// not expanded by the default flip).
//
// Run: node --test deploy/hooks/post_tool/test_build_structured_default_flag.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOOK = path.join(__dirname, "..", "post_tool_policy_hook.js");
const HOOK_DIR = path.join(__dirname, "..");

function frames(file, n, fromLine = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`    at fn${i} (${file}:${fromLine + i}:${i + 1})`);
  return out;
}

// P1-eligible test/build output (repeated same-file stack frames + not-ok
// groups) — same frozen shape the D1a unit tests assert eligible. Sized
// >= SHELL_FORCE_SUMMARY_CHARS (3000) so the real hook chain enters the
// quick_shell winner branch where the D-1 gate lives.
function positiveFixture() {
  const lines = ["npm test", "test/tap runner v1.0 with detailed per-case diagnostics enabled for this run"];
  lines.push(...frames("lib/reply.js", 40, 10));
  lines.push("not ok 1 - reply sets header for the cached response path in the streaming branch");
  lines.push("  ---");
  lines.push("    expected: 201");
  lines.push("    actual:   500");
  lines.push(...frames("test/reply.test.js", 20, 100));
  lines.push(...frames("lib/reply.js", 40, 10));
  lines.push("not ok 2 - second failure in the header serialization branch");
  lines.push("    expected: 1");
  lines.push("    actual:   0");
  lines.push("1..2");
  return lines.join("\n");
}

// Non test/build shell output: unique lines, no test/build markers, no
// P1-P5 morphology. Must stay native-quick_shell under every flag value.
function negativeFixture() {
  const lines = ["npm run collect-metrics", "aggregating runtime samples for this run"];
  for (let i = 0; i < 120; i++) {
    lines.push(`metric sample ${String(i).padStart(4, "0")} value=${(i * 1.5).toFixed(2)} series=runtime ticks=${i + 7}`);
  }
  lines.push("collection finished");
  return lines.join("\n");
}

function hookEnv(base, sessionId, flagValue) {
  const env = { ...process.env };
  delete env.CODE_GUARD_TEST_BUILD_STRUCTURED;
  env.CODE_GUARD_BASE_DIR = base;
  env.CODE_GUARD_HOOK_DIR = HOOK_DIR;
  env.CODE_GUARD_TERMINAL_STATE = "";
  env.CODE_GUARD_TERMINAL_STATE_SHADOW = "";
  env.CODE_GUARD_TERMINAL_DISPATCH = "";
  if (flagValue !== null) env.CODE_GUARD_TEST_BUILD_STRUCTURED = flagValue;
  return env;
}

function runHook({ fixture, sessionId, flagValue }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tbs-flag-"));
  const payload = {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    cwd: process.cwd(),
    tool_name: "run_shell_command",
    tool_input: { command: "npm test" },
    tool_response: { content: fixture },
  };
  const res = cp.spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env: hookEnv(base, sessionId, flagValue),
    encoding: "utf8",
    timeout: 120000,
  });
  const telemetryPath = path.join(base, sessionId, "tasco_metrics", "test_build_structured.ndjson");
  let rows = null;
  if (fs.existsSync(telemetryPath)) {
    rows = fs
      .readFileSync(telemetryPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  const out = JSON.parse(String(res.stdout).trim() || "{}");
  const updated = out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput;
  const delivered =
    typeof updated === "string" ? updated : (updated && (updated.content || updated.stdout)) || null;
  return { status: res.status, stderr: res.stderr, delivered, rows, telemetryPath };
}

function appliedRow(rows) {
  return rows && rows.find((r) => r.event === "test_build_structured" && r.wiring_path === "quick_shell");
}

test("flag truth table 1+3: env absent == env=1 -> enabled (applied telemetry + folded delivery)", () => {
  const unset = runHook({ fixture: positiveFixture(), sessionId: "tbs-unset", flagValue: null });
  const on = runHook({ fixture: positiveFixture(), sessionId: "tbs-on", flagValue: "1" });

  assert.equal(unset.status, 0, String(unset.stderr));
  assert.equal(on.status, 0, String(on.stderr));

  // byte-identical delivery for absent vs "1"
  assert.equal(unset.delivered, on.delivered, "unset delivery must be byte-identical to =1");

  // structured applied through the existing quick_shell winner branch
  const rowUnset = appliedRow(unset.rows);
  const rowOn = appliedRow(on.rows);
  assert.ok(rowUnset, "unset: structured telemetry row written");
  assert.ok(rowOn, "=1: structured telemetry row written");
  assert.equal(rowUnset.structured_applied, true);
  assert.equal(rowOn.structured_applied, true);
  assert.ok(rowUnset.saving >= 0.3, "saving >= 0.3");
  assert.equal(rowUnset.wiring_path, "quick_shell");

  // folded payload really delivered (fold marker present, delivery reduced)
  assert.ok(on.delivered.includes("[+folded") || on.delivered.includes("[+"), "fold marker present");
  assert.ok(on.delivered.length < positiveFixture().length, "delivery reduced vs raw");
});

test("flag truth table 2: env=0 -> kill-switch (no structured participation, no residual applied telemetry)", () => {
  const off = runHook({ fixture: positiveFixture(), sessionId: "tbs-off", flagValue: "0" });
  const unset = runHook({ fixture: positiveFixture(), sessionId: "tbs-unset-ref", flagValue: null });

  assert.equal(off.status, 0, String(off.stderr));
  assert.ok(off.delivered, "legacy quick_shell delivery present");

  // no structured telemetry at all (no applied, no residual row)
  assert.equal(off.rows, null, "no test_build_structured.ndjson written under kill-switch");

  // structured path did not participate: no fold marker, delivery differs
  // from the enabled delivery (which contains the folded payload)
  assert.ok(!off.delivered.includes("[+folded"), "no fold marker under kill-switch");
  assert.notEqual(off.delivered, unset.delivered, "kill-switch delivery differs from enabled delivery");
});

test("flag truth table 4: other explicit values keep legacy semantics (contract not extended)", () => {
  for (const v of ["true", "2", ""]) {
    const r = runHook({ fixture: positiveFixture(), sessionId: `tbs-legacy-${v || "empty"}`, flagValue: v });
    assert.equal(r.status, 0, String(r.stderr));
    assert.equal(r.rows, null, `value ${JSON.stringify(v)} keeps legacy disabled semantics`);
    assert.ok(!r.delivered.includes("[+folded"), `value ${JSON.stringify(v)}: no fold marker`);
  }
});

test("negative fixture: default flip does not expand the negative zone (unset delivery == kill-switch delivery)", () => {
  const negUnset = runHook({ fixture: negativeFixture(), sessionId: "tbs-neg-unset", flagValue: null });
  const negOff = runHook({ fixture: negativeFixture(), sessionId: "tbs-neg-off", flagValue: "0" });

  assert.equal(negUnset.status, 0, String(negUnset.stderr));
  assert.equal(negOff.status, 0, String(negOff.stderr));

  // delivery byte-identical between enabled and kill-switch -> the negative
  // zone native path is untouched by the default flip
  assert.equal(negUnset.delivered, negOff.delivered, "negative fixture delivery unchanged by default");

  // no structured applied anywhere; enabled mode only records the declined
  // candidate (frozen D1a observability), kill-switch records nothing
  const row = appliedRow(negUnset.rows);
  assert.ok(row, "unset: declined-candidate observability row present (frozen D1a behavior)");
  assert.equal(row.structured_applied, false, "negative fixture never applies");
  assert.equal(negOff.rows, null, "kill-switch: no telemetry row");
});
