"use strict";

// ============================================================================
// validation_delta_coverage.test.js — Line-7 C 阶段：VD 正区扩展 Gate
// ============================================================================
// C 阶段契约修订（VD Contract V1 §1 M-V2 amendment）：正区
//   test → test + build + check
// 语义：build/check 为 state-level 比对（success_unchanged /
// failure_to_success_resolution）；counts_changed 仍为 test-only；
// failure current 仍不产生 VD（Diagnostic 域不变）；test 类行为逐字节不变。
// 运行：node --test deploy/hooks/post_tool/validation_delta_coverage.test.js
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const {
  buildFingerprint,
  tryCompressValidationDelta,
} = require("./validation_delta.js");

const CARGO_OK = [
  "    Compiling serde v1.0.0",
  "    Compiling tokio v1.0.0",
  "    Checking repo v0.1.0",
  ...Array.from({ length: 30 }, (_, i) => `    Checking dependency-${i} v1.0.0`),
  "    Finished dev [unoptimized + debuginfo] target(s) in 1.23s",
].join("\n");
const CARGO_BAD = [
  "error[E0308]: mismatched types",
  " --> src/main.rs:3:5",
  "error: could not compile `repo` due to 2 previous errors",
].join("\n");
const MYYPY_OK = "Success: no issues found in 42 source files\n";

test("C gate: cargo check unchanged x2 -> success_unchanged (state-level)", () => {
  const prev = buildFingerprint({ command: "cargo check", text: CARGO_OK });
  assert.equal(prev.state, "success");
  assert.equal(prev.ok, true, "state-level comparable");
  const d = tryCompressValidationDelta({ command: "cargo check", text: CARGO_OK, previous: prev });
  assert.ok(d, "delta produced");
  assert.equal(d.mode, "success_unchanged");
  assert.match(d.deltaText, /unchanged_since_previous_run: state=success/);
  assert.ok(d.deltaText.length < CARGO_OK.length * 0.8, "length guard passes on large check output");
});

test("C gate: cargo check failure -> success -> failure_to_success_resolution", () => {
  const prev = buildFingerprint({ command: "cargo check", text: CARGO_BAD });
  assert.equal(prev.state, "failure");
  const d = tryCompressValidationDelta({ command: "cargo check", text: CARGO_OK, previous: prev });
  assert.ok(d, "resolution delta produced");
  assert.equal(d.mode, "failure_to_success_resolution");
  assert.match(d.deltaText, /previous_run_state=failure/);
});

test("C gate: check counts extracted when present (pyright style)", () => {
  const text = "0 errors, 0 warnings, 0 informations\n";
  const prev = buildFingerprint({ command: "pyright", text });
  assert.equal(prev.state, "success");
  const d = tryCompressValidationDelta({ command: "pyright", text, previous: prev });
  assert.equal(d, null, "tiny output: delta >= raw*0.8 -> no saving (native correct)");
});

test("C gate: cargo failure current produces NO delta (failure stays Diagnostic domain)", () => {
  const prev = buildFingerprint({ command: "cargo check", text: CARGO_OK });
  assert.equal(tryCompressValidationDelta({ command: "cargo check", text: CARGO_BAD, previous: prev }), null);
});

test("C gate: test-kind semantics unchanged (regression pin)", () => {
  const tap = ["TAP version 13", ...Array.from({ length: 45 }, (_, i) => `ok ${i + 1} - case ${i}`), "1..45", "# tests 45", "# pass 45", "# fail 0"].join("\n");
  const prev = buildFingerprint({ command: "npm test", text: tap });
  assert.equal(prev.kind, "test");
  assert.equal(prev.ok, true);
  const d = tryCompressValidationDelta({ command: "npm test", text: tap, previous: prev });
  assert.ok(d);
  assert.equal(d.mode, "success_unchanged");
  assert.match(d.deltaText, /unchanged_since_previous_run: pass=45/);
});

test("C gate: no comparable previous -> null (no fabrication)", () => {
  assert.equal(tryCompressValidationDelta({ command: "cargo check", text: CARGO_OK, previous: null }), null);
  const other = buildFingerprint({ command: "cargo build", text: CARGO_OK });
  assert.equal(tryCompressValidationDelta({ command: "cargo check", text: CARGO_OK, previous: other }), null);
});

// ---- bridge 层：build 命令重复验证走 VD（fingerprint 持久化 + 仲裁）----

const BRIDGE = path.join(__dirname, "..", "..", "adapters", "claude_bridge.js");
const HOOK_DIR = path.join(__dirname, "..", "..", "hooks");
const BUILD_LOG = [
  "> webpack 5.89.0",
  ...Array.from({ length: 60 }, (_, i) => `asset chunk.${i}.js 12.4 KiB [emitted] [minimized]`),
  "✓ built in 21.34s",
].join("\n");

function spawnBridge(base, sessionId, command, text) {
  const event = {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout: text, stderr: "" },
  };
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env: {
      ...process.env,
      CODE_GUARD_BASE_DIR: base,
      CODE_GUARD_HOOK_DIR: HOOK_DIR,
      CODE_GUARD_AUTO_CANARY_V1A: "1",
      CODE_GUARD_VALIDATION_DELTA: "1",
      CODE_GUARD_TERMINAL_STATE: "",
      CODE_GUARD_FAILURE_CARRIER_AUTO: "",
      CODE_GUARD_READ_COMPRESSION: "",
      CODE_GUARD_CLAUDE_PROMPT: "Run the build and report the result.",
    },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(res.status, 0, String(res.stderr).slice(0, 300));
  const out = JSON.parse(String(res.stdout).trim() || "{}");
  const u = out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput;
  const content = typeof u === "string" ? u : (u && (u.content || u.stdout)) || null;
  const rows = fs.existsSync(path.join(base, "context_budget", "claude_auto_canary.jsonl"))
    ? fs.readFileSync(path.join(base, "context_budget", "claude_auto_canary.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { content: content || null, rows };
}

test("C gate (bridge): repeated npm run build -> Validation Delta wins (not Terminal)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vd-c-"));
  const sid = "vd-c-build";
  const r1 = spawnBridge(base, sid, "npm run build", BUILD_LOG);
  assert.equal(r1.content, null, "first success: no comparable previous -> native");
  const r2 = spawnBridge(base, sid, "npm run build", BUILD_LOG);
  assert.ok(r2.content, "second run: delta delivered");
  assert.match(r2.content, /\[VALIDATION_DELTA\]/);
  assert.match(r2.content, /mode=success_unchanged/);
  const comp = r2.rows.filter((x) => x.type === "compression" && x.capability === "validation_delta");
  assert.equal(comp.length, 1, "arbitration applied validation_delta");
  assert.equal(comp[0].transport_replacement_emitted, true);
  fs.rmSync(base, { recursive: true, force: true });
});
