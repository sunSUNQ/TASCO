"use strict";

// P1-S2b Auto Failure Carrier — bridge integration tests (F1-F8).
// Full chain per cell, exactly like a real session:
//   1. bridge PreToolUse (flag on) -> rewritten carrier command
//   2. the rewritten command is REALLY executed once (bash -c, as Git Bash
//      does) -> stdout/stderr/exit captured
//   3. bridge PostToolUse with the real execution result
// Gates: failure -> Diagnostic; first success -> Terminal; repeated success
// -> Validation Delta (identity = agent-semantic original command); unsafe/
// unknown commands stay legacy; single execution; prompt independence.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const BRIDGE = path.join(__dirname, "claude_bridge.js");
const HOOK_DIR = path.join(__dirname, "..", "hooks");

// ---------------------------------------------------------------- fixtures
function writeFixture(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, "utf8");
  return file;
}

// A failing node:test suite with enough passing-case volume that the carrier
// report exceeds the frozen quick-shell threshold (~3000 chars).
const FAIL_TEST = `
const test = require("node:test");
const assert = require("node:assert/strict");
for (let i = 0; i < 40; i++) {
  test("checkout case " + i + " stays under the free-shipping threshold", () => {
    assert.ok(true);
  });
}
test("shipping charges the flat fee below the threshold", () => {
  assert.ok(9999 >= 10000, "expected 9999 to be at least 10000 (boundary bug)");
});
`;

// A passing node:test suite with ~45 cases (large enough for terminal
// delivery: > 3000 chars of real success output).
const PASS_TEST = `
const test = require("node:test");
for (let i = 0; i < 45; i++) {
  test("route constraint " + i + " registers the host scoped matcher", () => {
    require("node:assert/strict").ok(true);
  });
}
`;

// Failing suite that leaves a unique marker line per module load: one
// execution of `node --test` => exactly one marker line (single-execution
// evidence, no hidden rerun).
const MARKER_FAIL_TEST = `
const fs = require("fs");
const path = require("path");
fs.appendFileSync(path.join(__dirname, "markers.log"), "run:" + Date.now() + ":" + process.pid + "\\n");
const test = require("node:test");
const assert = require("node:assert/strict");
for (let i = 0; i < 40; i++) {
  test("marker case " + i + " passes", () => { assert.ok(true); });
}
test("boundary check fails", () => {
  assert.ok(9999 >= 10000, "expected 9999 to be at least 10000 (boundary bug)");
});
`;

// ---------------------------------------------------------------- harness
function baseEnv(base, prompt, extra = {}) {
  return {
    ...process.env,
    CODE_GUARD_BASE_DIR: base,
    CODE_GUARD_HOOK_DIR: HOOK_DIR,
    CODE_GUARD_AUTO_CANARY_V1A: "1",
    CODE_GUARD_CLAUDE_PROMPT: prompt || "",
    CODE_GUARD_TERMINAL_STATE: extra.terminalState === undefined ? "1" : extra.terminalState,
    CODE_GUARD_TERMINAL_STATE_SHADOW: "",
    CODE_GUARD_VALIDATION_DELTA: extra.vdFlag ? "1" : "",
    CODE_GUARD_FAILURE_CARRIER_AUTO: extra.carrierAuto === undefined ? "1" : extra.carrierAuto,
  };
}

function spawnBridgeEvent(base, env, event) {
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env,
    encoding: "utf8",
    timeout: 180000,
  });
  assert.equal(res.status, 0, String(res.stderr));
  return JSON.parse(String(res.stdout).trim() || "{}");
}

function resolveBash() {
  for (const c of ["bash.exe", "C:/Program Files/Git/bin/bash.exe"]) {
    try {
      const p = cp.spawnSync(c, ["-c", "exit 0"], { timeout: 15000, windowsHide: true });
      if (!p.error && p.status === 0) return c;
    } catch (_e) { /* next */ }
  }
  return null;
}

// Executes a (possibly rewritten) command once, exactly like Claude Code does
// via Git Bash. The session env (CODE_GUARD_BASE_DIR etc.) is inherited, like
// the real runner does for hook children. Returns { stdout, stderr, status }.
function executeCommand(command, cwd, sessionEnv) {
  const bash = resolveBash();
  const env = { ...process.env, ...(sessionEnv || {}) };
  const res = bash
    ? cp.spawnSync(bash, ["-c", command], { cwd, encoding: "utf8", timeout: 180000, windowsHide: true, env })
    : cp.spawnSync(process.execPath, ["-e", command], { cwd, encoding: "utf8", timeout: 180000, windowsHide: true, env });
  return { stdout: String(res.stdout || ""), stderr: String(res.stderr || ""), status: res.status };
}

// Full S2b chain. Returns { rewritten, applied, exec, post } where `applied`
// is the capability actually applied for the PostToolUse leg (or null).
function runThroughCarrier({ base, sessionId, command, prompt, fixtureDir, vdFlag = false, postCommand }) {
  const pre = spawnBridgeEvent(
    base,
    baseEnv(base, prompt, { vdFlag }),
    {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command },
    }
  );
  const rewritten =
    pre.hookSpecificOutput && pre.hookSpecificOutput.updatedInput
      ? pre.hookSpecificOutput.updatedInput.command
      : command;
  const exec = executeCommand(rewritten, fixtureDir, {
    CODE_GUARD_BASE_DIR: base,
    CODE_GUARD_HOOK_DIR: HOOK_DIR,
    CODE_GUARD_CLAUDE_PROMPT: prompt || "",
    CODE_GUARD_TERMINAL_STATE: "1",
    CODE_GUARD_VALIDATION_DELTA: vdFlag ? "1" : "",
    CODE_GUARD_FAILURE_CARRIER_AUTO: "1",
  });
  const post = spawnBridgeEvent(
    base,
    baseEnv(base, prompt, { vdFlag }),
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      cwd: fixtureDir,
      tool_name: "Bash",
      tool_input: { command: postCommand || rewritten },
      tool_response: { stdout: exec.stdout, stderr: exec.stderr },
    }
  );
  const delivered =
    post.hookSpecificOutput && post.hookSpecificOutput.updatedToolOutput
      ? post.hookSpecificOutput.updatedToolOutput.content ||
        post.hookSpecificOutput.updatedToolOutput.stdout
      : null;
  return { rewritten, exec, delivered, pre, post };
}

function readRows(base, name) {
  const rows = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === name) {
        for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
          if (line.trim()) rows.push(JSON.parse(line));
        }
      }
    }
  };
  walk(base);
  return rows;
}

const arbitrationRows = (base) =>
  readRows(base, "claude_auto_canary.jsonl").filter((r) => r.type === "auto_arbitration_v1");
const rewriteRows = (base) =>
  readRows(base, "claude_auto_canary.jsonl").filter((r) => r.type === "failure_carrier_auto_rewrite");
const skipRows = (base) =>
  readRows(base, "claude_auto_canary.jsonl").filter((r) => r.type === "failure_carrier_auto_skip");
const shimRows = (base) => readRows(base, "carrier_shim.jsonl");

// ---------------------------------------------------------------- gates
test("F1 real failure through auto carrier -> valid carrier -> Diagnostic applied", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-s2b-f1-"));
  const fixtureDir = path.join(base, "fixture");
  writeFixture(fixtureDir, "fail.test.js", FAIL_TEST);
  const run = runThroughCarrier({
    base,
    sessionId: "s2b-f1",
    command: "node --test fail.test.js",
    prompt: "Run the validation suite.",
    fixtureDir,
  });
  assert.notEqual(run.rewritten, "node --test fail.test.js", "rewrite applied");
  assert.match(run.rewritten, /failure_carrier_shim\.js/);
  assert.equal(run.exec.status, 0, "wrapper exit=0 (transport success)");
  assert.ok(run.exec.stdout.includes("[TASCO_FAILURE_CARRIER]"), "carrier report emitted");
  assert.ok(run.exec.stdout.includes("original_exit_code=1"), "real exit code preserved in-band");
  assert.ok(run.exec.stdout.includes("original_command=node --test fail.test.js"), "original command preserved");
  assert.ok(run.delivered, "model-visible delivery present");
  assert.ok(run.delivered.includes("ERR_ASSERTION") || run.delivered.includes("expected 9999"), "root cause preserved");
  assert.ok(!run.delivered.includes("[TASCO_FAILURE_CARRIER_STDOUT]"), "raw carrier block not delivered verbatim");
  const arb = arbitrationRows(base).pop();
  assert.equal(arb.selected_capability, "diagnostic_semantic");
  assert.equal(arb.applied_capability, "diagnostic_semantic");
  assert.equal(arb.double_apply_count, 0);
  assert.equal(shimRows(base).length, 1, "exactly one shim execution row");
});

test("F2 failure with success-like noise -> Diagnostic, terminal/VD never win", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-s2b-f2-"));
  const fixtureDir = path.join(base, "fixture");
  writeFixture(
    fixtureDir,
    "fail.test.js",
    FAIL_TEST + `
test("reporting: 40 passed and success summary", () => {
  console.log("40 passed, success, all green");
  assert.ok(9999 >= 10000, "expected 9999 to be at least 10000");
});`
  );
  const run = runThroughCarrier({
    base,
    sessionId: "s2b-f2",
    command: "node --test fail.test.js",
    prompt: "Run this and tell me what happened.",
    fixtureDir,
  });
  assert.ok(run.exec.stdout.includes("[TASCO_FAILURE_CARRIER]"));
  const arb = arbitrationRows(base).pop();
  assert.equal(arb.selected_capability, "diagnostic_semantic");
  assert.equal(arb.applied_capability, "diagnostic_semantic");
  const comps = readRows(base, "claude_auto_canary.jsonl").filter((r) => r.type === "compression");
  assert.equal(comps.filter((c) => c.capability === "terminal_state_success").length, 0);
  assert.equal(comps.filter((c) => c.capability === "validation_delta").length, 0);
});

test("F3 first success through auto carrier -> success passthrough -> Terminal applied", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-s2b-f3-"));
  const fixtureDir = path.join(base, "fixture");
  writeFixture(fixtureDir, "pass.test.js", PASS_TEST);
  const cmd = "node --test --test-reporter=tap pass.test.js";
  const run = runThroughCarrier({
    base,
    sessionId: "s2b-f3",
    command: cmd,
    prompt: "Run the validation suite.",
    fixtureDir,
  });
  assert.notEqual(run.rewritten, cmd, "rewrite applied");
  assert.equal(run.exec.status, 0);
  assert.ok(!run.exec.stdout.includes("[TASCO_FAILURE_CARRIER]"), "no carrier on success");
  assert.ok(run.delivered, "terminal delivery present");
  assert.ok(run.delivered.startsWith("[TERMINAL_STATE_SUCCESS]"), "terminal winner");
  assert.ok(run.delivered.includes(`command=${cmd}`), "summary carries the agent-semantic original command");
  const arb = arbitrationRows(base).pop();
  assert.equal(arb.selected_capability, "terminal_state_success");
  assert.equal(arb.applied_capability, "terminal_state_success");
});

test("F4 repeated same-command success -> Validation Delta wins (semantic identity)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-s2b-f4-"));
  const fixtureDir = path.join(base, "fixture");
  writeFixture(fixtureDir, "pass.test.js", PASS_TEST);
  const cmd = "node --test --test-reporter=tap pass.test.js";
  const common = { base, sessionId: "s2b-f4", command: cmd, fixtureDir, vdFlag: true };
  const run1 = runThroughCarrier({ ...common, prompt: "Run the validation suite." });
  assert.ok(run1.delivered && run1.delivered.startsWith("[TERMINAL_STATE_SUCCESS]"), "first success -> terminal");
  const run2 = runThroughCarrier({ ...common, prompt: "Run the validation suite again." });
  assert.ok(run2.delivered, "second run delivery present");
  assert.match(run2.delivered, /^\[VALIDATION_DELTA\]/, "same semantic command -> comparable previous -> VD");
  assert.match(run2.delivered, /mode=success_unchanged/);
  const arb2 = arbitrationRows(base).pop();
  assert.equal(arb2.selected_capability, "validation_delta");
  assert.equal(arb2.applied_capability, "validation_delta");
  assert.equal(arb2.double_apply_count, 0);
  // The fingerprint key must be the agent-semantic original command, not the
  // wrapper text.
  const vdStateFiles = (function walkState(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walkState(f));
      else if (entry.name.startsWith("claude_validation_")) {
        const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
        found.push(Object.keys(parsed.runs || {}));
      }
    }
    return found;
  })(base);
  assert.ok(
    vdStateFiles.some((keys) => keys.includes(cmd)),
    "VD fingerprint keyed by the original command: " + JSON.stringify(vdStateFiles)
  );
});

test("F5 malformed carrier at PostToolUse -> Native (no capability fires)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-s2b-f5-"));
  spawnBridgeEvent(
    base,
    baseEnv(base, "Run the validation suite."),
    {
      hook_event_name: "PostToolUse",
      session_id: "s2b-f5",
      cwd: process.cwd(),
      tool_name: "Bash",
      tool_input: { command: "node --test x.test.js" },
      tool_response: { stdout: "[TASCO_FAILURE_CARRIER_V9] broken carrier_version=1\nno blocks here\n", stderr: "" },
    }
  );
  const arb = arbitrationRows(base).pop();
  assert.equal(arb.selected_capability, null);
  assert.equal(arb.fallback_reason, "failure_carrier_malformed");
});

test("F6 unsafe / unknown / watch commands are never rewritten (legacy execution)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-s2b-f6-"));
  for (const [i, cmd] of [
    "npm test && echo done",
    "echo hi",
    "node scripts/verify.js",
    "npm test --watch",
    "npm test | tee out.log",
    "rm -rf build",
  ].entries()) {
    const pre = spawnBridgeEvent(
      base,
      baseEnv(base, "", {}),
      {
        hook_event_name: "PreToolUse",
        session_id: `s2b-f6-${i}`,
        tool_name: "Bash",
        tool_input: { command: cmd },
      }
    );
    assert.equal(
      pre.hookSpecificOutput && pre.hookSpecificOutput.updatedInput,
      undefined,
      `no rewrite for ${cmd}`
    );
  }
  const skips = skipRows(base);
  assert.equal(skips.length, 6);
  assert.ok(skips.every((s) => s.reason !== "already_carrier_wrapped"));
});

test("F7 single execution: one tool request -> exactly one real command execution", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-s2b-f7-"));
  const fixtureDir = path.join(base, "fixture");
  writeFixture(fixtureDir, "marker-fail.test.js", MARKER_FAIL_TEST);
  const run = runThroughCarrier({
    base,
    sessionId: "s2b-f7",
    command: "node --test marker-fail.test.js",
    prompt: "Run the validation suite.",
    fixtureDir,
  });
  assert.equal(run.exec.status, 0);
  assert.ok(run.exec.stdout.includes("original_exit_code=1"));
  const markers = fs
    .readFileSync(path.join(fixtureDir, "markers.log"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(markers.length, 1, `exactly one side-effect marker, got ${markers.length}`);
  const rows = shimRows(base);
  assert.equal(rows.length, 1, "exactly one shim telemetry row");
  assert.equal(rows[0].original_exit_code, 1);
  assert.equal(rows[0].original_command, "node --test marker-fail.test.js");
});

test("F8 prompt independence: same failure -> same rewrite and same eligibility", () => {
  const prompts = [
    "Diagnose the root cause of this failing checkout suite.",
    "Run this and tell me what happened.",
    "Please inspect the result.",
  ];
  const bases = [];
  const rewrites = [];
  const applied = [];
  prompts.forEach((prompt, i) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `fc-s2b-f8-${i}-`));
    const fixtureDir = path.join(base, "fixture");
    writeFixture(fixtureDir, "fail.test.js", FAIL_TEST);
    const run = runThroughCarrier({ base, sessionId: `s2b-f8-${i}`, command: "node --test fail.test.js", prompt, fixtureDir });
    bases.push(base);
    rewrites.push(run.rewritten);
    const arb = arbitrationRows(base).pop();
    applied.push(arb && arb.applied_capability);
  });
  assert.ok(rewrites.every((r) => r === rewrites[0]), "rewrite identical across prompts");
  assert.ok(applied.every((a) => a === "diagnostic_semantic"), "Diagnostic applied for every prompt");
  for (const base of bases) assert.equal(rewriteRows(base).length, 1);
});
