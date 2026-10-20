"use strict";

// Validation Delta bridge integration tests (v0.5 M3 Lab batch).
// Spawns claude_bridge.js as a fresh process per hook invocation, exactly like
// a real PostToolUse; the cross-invocation fingerprint state is persisted in
// CODE_GUARD_BASE_DIR/context_budget/claude_validation_<session>.json.
//
// Scenarios under test:
//   1. success -> success (identical rerun): second run delivers a
//      success_unchanged [VALIDATION_DELTA]; first run stays native.
//   2. failure -> success (fix rerun): second run delivers a
//      failure_to_success_resolution delta listing the previously failing case.
//   3. flag off: two runs stay byte-identical native, no VD candidate, no
//      state file written.
//   4. different command under the same session never compares (fingerprint
//      keyed by the folded command).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const BRIDGE = path.join(__dirname, "claude_bridge.js");
const TAP44 = fs.readFileSync(
  path.join(__dirname, "..", "..", "docs", "experiments", "workflow-compression", "p0-agent-ab", "qualification", "fixtures", "f1-tap-44pass.out"),
  "utf8"
);
const CMD =
  "node --test --test-reporter=tap test/route.6.test.js test/route.7.test.js test/constrained-routes.test.js";
const CMD_OTHER = "node --test --test-reporter=tap test/route.9.test.js";

// 与 validation_delta.test.js 同形状：真实 node:test 失败 TAP 输出（合成）。
const FAIL_TAP = [
  "TAP version 13",
  "# Subtest: Should register a host constrained route",
  "not ok 1 - Should register a host constrained route",
  "  ---",
  "  duration_ms: 60.0009",
  "  type: 'test'",
  "  ...",
  "1..1",
  "# tests 1",
  "# suites 1",
  "# pass 0",
  "# fail 1",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
].join("\n");

function spawnBridge({ base, sessionId, stdoutText, command, vdFlag, prompt }) {
  const event = {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout: stdoutText, stderr: "" },
  };
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env: {
      ...process.env,
      CODE_GUARD_BASE_DIR: base,
      CODE_GUARD_HOOK_DIR: path.join(__dirname, "..", "hooks"),
      CODE_GUARD_AUTO_CANARY_V1A: "1",
      CODE_GUARD_CLAUDE_PROMPT: prompt || "Run the validation suite and report the result.",
      CODE_GUARD_VALIDATION_DELTA: vdFlag ? "1" : "",
      CODE_GUARD_TERMINAL_STATE: "",
      CODE_GUARD_TERMINAL_STATE_SHADOW: "",
    },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(res.status, 0, String(res.stderr));
  const output = JSON.parse(String(res.stdout).trim() || "{}");
  const delivered = output.hookSpecificOutput && output.hookSpecificOutput.updatedToolOutput;
  const content = delivered && (delivered.content || delivered.stdout || "");
  return { content: content || null };
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

function arbitrationRows(base) {
  return readRows(base, "claude_auto_canary.jsonl").filter((row) => row.type === "auto_arbitration_v1");
}

function compressionRows(base) {
  return readRows(base, "claude_auto_canary.jsonl").filter((row) => row.type === "compression");
}

function validationStateFiles(base) {
  const dir = path.join(base, "context_budget");
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => n.startsWith("claude_validation_"))
    : [];
}

test("VD Lab: identical success rerun delivers success_unchanged delta on the second run only", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vd-bridge-"));
  const sid = "00000000-0000-0000-0000-00000000b101";
  const r1 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD, vdFlag: true });
  assert.equal(r1.content, null, "first run has no previous fingerprint -> native");

  const r2 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD, vdFlag: true });
  assert.match(r2.content, /^\[VALIDATION_DELTA\]/);
  assert.match(r2.content, /mode=success_unchanged/);
  assert.match(r2.content, /unchanged_since_previous_run: pass=44/);

  const arb = arbitrationRows(base);
  assert.equal(arb.length, 2);
  assert.deepEqual(arb[0].candidate_capabilities, []);
  assert.equal(arb[0].selected_capability, null);
  assert.deepEqual(arb[1].candidate_capabilities, ["validation_delta"]);
  assert.deepEqual(arb[1].eligible_capabilities, ["validation_delta"]);
  assert.equal(arb[1].selected_capability, "validation_delta");
  assert.equal(arb[1].applied_capability, "validation_delta");
  assert.equal(arb[1].double_apply_count, 0);
  assert.equal(arb[1].arbitration_version, "AUTO-ARBITRATION-V1");

  const comp = compressionRows(base);
  assert.equal(comp.length, 1);
  assert.equal(comp[0].capability, "validation_delta");
  assert.equal(comp[0].vd_mode, "success_unchanged");
  assert.equal(comp[0].transport_replacement_emitted, true);
  assert.equal(comp[0].coverage, null, "rewrite-report: coverage gate not applicable");

  assert.equal(validationStateFiles(base).length, 1, "one fingerprint state per session");
});

test("VD Lab: failure rerun to success delivers resolution delta naming the fixed cases", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vd-bridge-"));
  const sid = "00000000-0000-0000-0000-00000000b102";
  const r1 = spawnBridge({ base, sessionId: sid, stdoutText: FAIL_TAP, command: CMD, vdFlag: true });
  assert.equal(r1.content, null, "failure current is outside the v1 positive zone -> native");

  const r2 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD, vdFlag: true });
  assert.match(r2.content, /^\[VALIDATION_DELTA\]/);
  assert.match(r2.content, /mode=failure_to_success_resolution/);
  assert.match(r2.content, /previous_run_state=failure/);
  assert.match(r2.content, /previously_failing_cases=1/);
  assert.match(r2.content, /- Should register a host constrained route/);
  assert.match(r2.content, /counts: pass=44 fail=0 skip=0/);

  const comp = compressionRows(base);
  assert.equal(comp.length, 1);
  assert.equal(comp[0].capability, "validation_delta");
  assert.equal(comp[0].vd_mode, "failure_to_success_resolution");
});

test("VD Lab: flag off stays byte-identical across two runs (no VD traces, no state file)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vd-bridge-"));
  const sid = "00000000-0000-0000-0000-00000000b103";
  const r1 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD, vdFlag: false });
  assert.equal(r1.content, null);
  const r2 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD, vdFlag: false });
  assert.equal(r2.content, null);

  const arb = arbitrationRows(base);
  assert.equal(arb.length, 2);
  for (const row of arb) {
    assert.ok(!row.candidate_capabilities.includes("validation_delta"), "no VD candidate when flag off");
  }
  assert.equal(compressionRows(base).length, 0);
  assert.equal(validationStateFiles(base).length, 0, "no fingerprint state read/write when flag off");
});

test("VD Lab: a different command under the same session never compares against it", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vd-bridge-"));
  const sid = "00000000-0000-0000-0000-00000000b104";
  const r1 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD, vdFlag: true });
  assert.equal(r1.content, null);

  const rOther = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD_OTHER, vdFlag: true });
  assert.equal(rOther.content, null, "different folded command -> no comparable previous");

  const rBack = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD, vdFlag: true });
  assert.match(rBack.content, /^\[VALIDATION_DELTA\]/, "returning to the original command compares again");

  const arb = arbitrationRows(base);
  assert.equal(arb.length, 3);
  assert.deepEqual(arb[1].candidate_capabilities, [], "CMD_OTHER run must not see the CMD fingerprint");
  assert.deepEqual(arb[2].candidate_capabilities, ["validation_delta"]);
  assert.equal(arb[2].selected_capability, "validation_delta");
});
