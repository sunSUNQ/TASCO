"use strict";

// P1-S3 Shell / Validation cross-capability conflict qualification.
// Ten cells over the real bridge chain (PreToolUse rewrite + real shim
// execution + PostToolUse arbitration where the cell needs a live command).
// Expected winners are anchored on the frozen precedence
//   failure diagnostic > stable validation delta > terminal success > native
// and on FAILURE-CARRIER-CONTRACT-V1 consumption rules. Winning must be a
// property of the evidence, never of execution order.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const BRIDGE = path.join(__dirname, "claude_bridge.js");
const HOOK_DIR = path.join(__dirname, "..", "hooks");
const PINNED = "node --test --test-reporter=tap pass.test.js";

// ---------------------------------------------------------------- fixtures
const PASS_TEST = (count, extraName) => `
const test = require("node:test");
for (let i = 0; i < ${count}; i++) {
  test("route constraint " + i + " registers the host scoped matcher", () => {
    require("node:assert/strict").ok(true);
  });
}
${extraName ? `test(${JSON.stringify(extraName)}, () => { require("node:assert/strict").ok(true); });` : ""}
`;

const FAIL_TEST = `
const test = require("node:test");
const assert = require("node:assert/strict");
for (let i = 0; i < 25; i++) {
  test("checkout case " + i + " stays under the threshold", () => { assert.ok(true); });
}
test("boundary: total 10000 cents reaches the threshold and ships free", () => {
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
    CODE_GUARD_TERMINAL_STATE: "1",
    CODE_GUARD_TERMINAL_STATE_SHADOW: "",
    CODE_GUARD_VALIDATION_DELTA: extra.vdFlag ? "1" : "",
    CODE_GUARD_FAILURE_CARRIER_AUTO: "1",
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

function executeCommand(command, cwd, sessionEnv) {
  const bash = resolveBash();
  const env = { ...process.env, ...(sessionEnv || {}) };
  const res = bash
    ? cp.spawnSync(bash, ["-c", command], { cwd, encoding: "utf8", timeout: 180000, windowsHide: true, env })
    : cp.spawnSync(process.execPath, ["-e", command], { cwd, encoding: "utf8", timeout: 180000, windowsHide: true, env });
  return { stdout: String(res.stdout || ""), stderr: String(res.stderr || ""), status: res.status };
}

// One carried execution: PreToolUse -> execute -> PostToolUse.
function carriedRun({ base, sessionId, command, prompt, fixtureDir, vdFlag = false, postCommand }) {
  const pre = spawnBridgeEvent(
    base,
    baseEnv(base, prompt, { vdFlag }),
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_name: "Bash", tool_input: { command } }
  );
  const rewritten =
    pre.hookSpecificOutput && pre.hookSpecificOutput.updatedInput
      ? pre.hookSpecificOutput.updatedInput.command
      : command;
  const exec = executeCommand(rewritten, fixtureDir, {
    CODE_GUARD_BASE_DIR: base, CODE_GUARD_HOOK_DIR: HOOK_DIR,
  });
  const post = spawnBridgeEvent(
    base,
    baseEnv(base, prompt, { vdFlag }),
    {
      hook_event_name: "PostToolUse", session_id: sessionId, cwd: fixtureDir,
      tool_name: "Bash", tool_input: { command: postCommand || rewritten },
      tool_response: { stdout: exec.stdout, stderr: exec.stderr },
    }
  );
  const delivered =
    post.hookSpecificOutput && post.hookSpecificOutput.updatedToolOutput
      ? post.hookSpecificOutput.updatedToolOutput.content ||
        post.hookSpecificOutput.updatedToolOutput.stdout
      : null;
  return { rewritten, exec, delivered };
}

// Post-only cell (synthetic tool_result text, no execution).
function postOnly({ base, sessionId, command, prompt, stdoutText, vdFlag = false }) {
  return spawnBridgeEvent(
    base,
    baseEnv(base, prompt, { vdFlag }),
    {
      hook_event_name: "PostToolUse", session_id: sessionId, cwd: process.cwd(),
      tool_name: "Bash", tool_input: { command },
      tool_response: { stdout: stdoutText, stderr: "" },
    }
  );
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
const arbRows = (base) => readRows(base, "claude_auto_canary.jsonl").filter((r) => r.type === "auto_arbitration_v1");
const skipRows = (base) => readRows(base, "claude_auto_canary.jsonl").filter((r) => r.type === "failure_carrier_auto_skip");
const lastArb = (base) => arbRows(base)[arbRows(base).length - 1];

function mkdtempFixture(name, files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `s3-${name}-`));
  const fixtureDir = path.join(base, "fixture");
  fs.mkdirSync(fixtureDir, { recursive: true });
  for (const [n, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(fixtureDir, n), body, "utf8");
  }
  return { base, fixtureDir };
}

// ---------------------------------------------------------------- cells
test("S3-C1 real failure -> Diagnostic (auto carrier)", () => {
  const { base, fixtureDir } = mkdtempFixture("c1", { "fail.test.js": FAIL_TEST });
  const cmd = "node --test --test-reporter=tap fail.test.js";
  const run = carriedRun({ base, sessionId: "s3c1", command: cmd, prompt: "Run the validation suite.", fixtureDir });
  assert.ok(run.exec.stdout.includes("original_exit_code=1"));
  assert.ok(run.delivered, "compressed diagnostic delivered");
  const arb = lastArb(base);
  assert.equal(arb.selected_capability, "diagnostic_semantic");
  assert.equal(arb.applied_capability, "diagnostic_semantic");
  assert.equal(arb.double_apply_count, 0);
});

test("S3-C2 failure + many passed lines -> Diagnostic", () => {
  const { base, fixtureDir } = mkdtempFixture("c2", {
    "fail.test.js": FAIL_TEST + `
test("report: 25 passed, success, all green", () => {
  console.log("25 passed; success summary; 0 warnings");
  assert.ok(9999 >= 10000, "expected 9999 to be at least 10000");
});`,
  });
  const run = carriedRun({ base, sessionId: "s3c2", command: "node --test --test-reporter=tap fail.test.js", prompt: "Run this and tell me what happened.", fixtureDir });
  assert.ok(run.delivered);
  const arb = lastArb(base);
  assert.equal(arb.selected_capability, "diagnostic_semantic");
  assert.equal(arb.applied_capability, "diagnostic_semantic");
});

test("S3-C3 failure carrier + terminal-like summary -> Diagnostic (no terminal preemption)", () => {
  // original_exit_code=1 with a success-shaped body: the frozen terminal
  // classifier reads the text as success, but failure evidence from the
  // carrier (original_exit_code != 0) wins by frozen precedence.
  const stdout = [
    ...Array.from({ length: 43 }, (_, i) => `ok ${i + 1} - route constraint ${i} registers the host scoped matcher`),
    "✖ checkout applies the member discount above the threshold",
    "# tests 44",
    "# pass 43",
    "# fail 0",
  ].join("\n");
  const carrier = [
    "[TASCO_FAILURE_CARRIER] carrier_version=1 transport=pre_tool_use_auto",
    "original_command=" + PINNED.replace("pass.test.js", "x.test.js"),
    "original_exit_code=1",
    "failure_kind=test_failure",
    "truncated=false",
    "[TASCO_FAILURE_CARRIER_STDOUT]",
    stdout,
    "[TASCO_FAILURE_CARRIER_STDERR]",
    "",
    "[TASCO_FAILURE_CARRIER_END]",
  ].join("\n");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "s3-c3-"));
  const out = postOnly({ base, sessionId: "s3c3", command: "node --test x.test.js", prompt: "Run this and tell me what happened.", stdoutText: carrier });
  const delivered = out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput
    ? out.hookSpecificOutput.updatedToolOutput.content || out.hookSpecificOutput.updatedToolOutput.stdout : null;
  const arb = lastArb(base);
  assert.equal(arb.selected_capability, "diagnostic_semantic", "diagnostic wins over terminal");
  assert.equal(arb.selection_reason, "failure_diagnostic_precedence");
  assert.ok(arb.candidate_capabilities.includes("terminal_state_success"), "terminal conflict candidate present");
  assert.equal(arb.double_apply_count, 0);
});

test("S3-C4 malformed carrier -> Native", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "s3-c4-"));
  postOnly({
    base, sessionId: "s3c4", command: PINNED, prompt: "",
    stdoutText: "[TASCO_FAILURE_CARRIER_BROKEN] command failed carrier_version=1\nno blocks\n",
  });
  const arb = lastArb(base);
  assert.equal(arb.selected_capability, null);
  assert.equal(arb.fallback_reason, "failure_carrier_malformed");
});

test("S3-C5 first successful validation -> Terminal", () => {
  const { base, fixtureDir } = mkdtempFixture("c5", { "pass.test.js": PASS_TEST(45) });
  const run = carriedRun({ base, sessionId: "s3c5", command: PINNED, prompt: "Run the validation suite.", fixtureDir, vdFlag: true });
  assert.ok(run.delivered && run.delivered.startsWith("[TERMINAL_STATE_SUCCESS]"), "terminal winner");
  const arb = lastArb(base);
  assert.equal(arb.selected_capability, "terminal_state_success");
  assert.equal(arb.applied_capability, "terminal_state_success");
});

test("S3-C6 repeated unchanged validation -> Validation Delta (success_unchanged)", () => {
  const { base, fixtureDir } = mkdtempFixture("c6", { "pass.test.js": PASS_TEST(45) });
  const common = { base, sessionId: "s3c6", command: PINNED, fixtureDir, vdFlag: true, prompt: "Run the validation suite." };
  carriedRun(common);
  const run2 = carriedRun(common);
  assert.ok(run2.delivered && run2.delivered.startsWith("[VALIDATION_DELTA]"));
  assert.match(run2.delivered, /mode=success_unchanged/);
  const arb = lastArb(base);
  assert.equal(arb.selected_capability, "validation_delta");
  assert.equal(arb.applied_capability, "validation_delta");
});

test("S3-C7 repeated changed-count validation -> Validation Delta (success_counts_changed)", () => {
  const { base, fixtureDir } = mkdtempFixture("c7", { "pass.test.js": PASS_TEST(45) });
  const common = { base, sessionId: "s3c7", command: PINNED, fixtureDir, vdFlag: true, prompt: "Run the validation suite." };
  carriedRun(common);
  // The code changed: five more cases now exist under the same command.
  fs.writeFileSync(path.join(fixtureDir, "pass.test.js"), PASS_TEST(50), "utf8");
  const run2 = carriedRun(common);
  assert.ok(run2.delivered && run2.delivered.startsWith("[VALIDATION_DELTA]"));
  assert.match(run2.delivered, /mode=success_counts_changed/);
  assert.match(run2.delivered, /counts_delta: pass 45->50/);
  const arb = lastArb(base);
  assert.equal(arb.selected_capability, "validation_delta");
  assert.equal(arb.applied_capability, "validation_delta");
});

test("S3-C8 success output with 'error' in test names -> Terminal (line-shape protection)", () => {
  const { base, fixtureDir } = mkdtempFixture("c8", {
    "pass.test.js": PASS_TEST(45, "handles 400 error responses correctly"),
  });
  const run = carriedRun({ base, sessionId: "s3c8", command: PINNED, prompt: "Run the validation suite.", fixtureDir, vdFlag: true });
  assert.ok(run.delivered && run.delivered.startsWith("[TERMINAL_STATE_SUCCESS]"), "terminal winner despite 'error' wording");
  assert.ok(run.delivered.includes("error responses correctly"), "named case preserved verbatim");
  const arb = lastArb(base);
  assert.equal(arb.selected_capability, "terminal_state_success");
});

test("S3-C9 fail-closed set: truncated-without-note / unsafe / unknown stay Native", () => {
  // (a) truncated=true without boundary note -> semantically incomplete -> Native.
  const baseA = fs.mkdtempSync(path.join(os.tmpdir(), "s3-c9a-"));
  const truncatedCarrier = [
    "[TASCO_FAILURE_CARRIER] command failed carrier_version=1 transport=pre_tool_use_auto",
    "original_command=node --test x.test.js",
    "original_exit_code=1",
    "failure_kind=test_failure",
    "truncated=true",
    "[TASCO_FAILURE_CARRIER_STDOUT]",
    "not ok 1 - boundary failed",
    "[TASCO_FAILURE_CARRIER_STDERR]",
    "",
    "[TASCO_FAILURE_CARRIER_END]",
  ].join("\n");
  postOnly({ base: baseA, sessionId: "s3c9a", command: "node --test x.test.js", prompt: "Diagnose the root cause.", stdoutText: truncatedCarrier });
  assert.equal(lastArb(baseA).fallback_reason, "failure_carrier_malformed");
  assert.equal(lastArb(baseA).selected_capability, null);

  // (b) unsafe / unknown commands are never rewritten (legacy execution).
  const baseB = fs.mkdtempSync(path.join(os.tmpdir(), "s3-c9b-"));
  for (const [i, cmd] of ["npm test && echo done", "echo hi", "npm test --watch"].entries()) {
    const pre = spawnBridgeEvent(
      baseB,
      baseEnv(baseB, "", {}),
      { hook_event_name: "PreToolUse", session_id: `s3c9b-${i}`, tool_name: "Bash", tool_input: { command: cmd } }
    );
    assert.equal(pre.hookSpecificOutput && pre.hookSpecificOutput.updatedInput, undefined, `no rewrite for ${cmd}`);
  }
  const skips = skipRows(baseB);
  assert.deepEqual(
    skips.map((s) => s.reason).sort(),
    ["interactive_or_watch", "not_test_or_build_form", "unsafe_shell_shape"]
  );
});

test("S3-C10 overlapping candidates resolve by frozen precedence (both directions)", () => {
  // (a) failure carrier + terminal-like body -> diagnostic wins (failure > terminal).
  const baseA = fs.mkdtempSync(path.join(os.tmpdir(), "s3-c10a-"));
  const carrierText = [
    "[TASCO_FAILURE_CARRIER] carrier_version=1 transport=pre_tool_use_auto",
    "original_command=node --test x.test.js",
    "original_exit_code=1",
    "failure_kind=test_failure",
    "truncated=false",
    "[TASCO_FAILURE_CARRIER_STDOUT]",
    ...Array.from({ length: 55 }, (_, i) => `ok ${i + 1} - route constraint ${i} registers the host scoped matcher`),
    "✖ checkout applies the member discount above the threshold",
    "# tests 56",
    "# pass 55",
    "# fail 0",
    "[TASCO_FAILURE_CARRIER_STDERR]",
    "",
    "[TASCO_FAILURE_CARRIER_END]",
  ].join("\n");
  postOnly({ base: baseA, sessionId: "s3c10a", command: "node --test x.test.js", prompt: "Run this and tell me what happened.", stdoutText: carrierText });
  assert.equal(lastArb(baseA).selected_capability, "diagnostic_semantic");

  // (b) three-way: diagnostic candidate (obs, no failure evidence) + stable VD
  // + terminal all eligible on a success text -> VD wins (stable VD > terminal;
  // diagnostic without failure evidence does not preempt).
  const baseB = fs.mkdtempSync(path.join(os.tmpdir(), "s3-c10b-"));
  const TAPBIG = [
    "TAP version 13",
    ...Array.from({ length: 100 }, (_, i) => `ok ${i + 1} - route constraint ${i} registers the host scoped matcher`),
    "1..100",
    "# tests 100",
    "# pass 100",
    "# fail 0",
  ].join("\n");
  const CMD = "node --test --test-reporter=tap test/route.test.js";
  const OBS_DIAG_PROMPT =
    "Analyze the output and identify the root cause. This is analysis only - do not modify anything.";
  postOnly({ base: baseB, sessionId: "s3c10b", command: CMD, prompt: OBS_DIAG_PROMPT, stdoutText: TAPBIG, vdFlag: true });
  postOnly({ base: baseB, sessionId: "s3c10b", command: CMD, prompt: OBS_DIAG_PROMPT, stdoutText: TAPBIG, vdFlag: true });
  const arb = lastArb(baseB);
  assert.deepEqual(arb.candidate_capabilities.sort(), ["diagnostic_semantic", "terminal_state_success", "validation_delta"]);
  assert.equal(arb.selected_capability, "validation_delta", "stable VD beats terminal; diagnostic without failure evidence does not preempt");
  assert.equal(arb.applied_capability, "validation_delta");
});
