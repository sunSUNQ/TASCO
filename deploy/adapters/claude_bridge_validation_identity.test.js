"use strict";

// ============================================================================
// claude_bridge_validation_identity.test.js — Line-8A bridge 集成 gate
// ============================================================================
// 真实 claude_bridge.js 进程级验证（M-V3 Semantic Validation Identity）：
//   1. 命令形态漂移（plain → tee/tail 变体）经 semantic scan 找到可比基线，
//      第二轮交付 success_unchanged [VALIDATION_DELTA]。
//   2. compound 命令不得与 plain baseline 比较（fail-closed），identical rerun
//      的既有 baseline 行为保持。
// 复用 claude_bridge_validation_delta.test.js 的 spawn harness 形状。
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const BRIDGE = path.join(__dirname, "claude_bridge.js");

const TAP44 = fs.readFileSync(
  path.join(__dirname, "..", "fixtures", "f1-tap-44pass.out"),
  "utf8"
);

const CMD = "node --test --test-reporter=tap test/route.6.test.js test/route.7.test.js test/constrained-routes.test.js";
const CMD_WRAPPED = CMD + " | tee test-run.log | tail -60";
const CMD_COMPOUND = CMD + " && echo done";

function spawnBridge({ base, sessionId, stdoutText, command }) {
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
      CODE_GUARD_CLAUDE_PROMPT: "Run the validation suite and report the result.",
      CODE_GUARD_VALIDATION_DELTA: "1",
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

function arbitrationRows(base) {
  const rows = [];
  const dir = path.join(base, "context_budget");
  const f = path.join(dir, "claude_auto_canary.jsonl");
  if (!fs.existsSync(f)) return rows;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.type === "auto_arbitration_v1") rows.push(row);
  }
  return rows;
}

test("VD M-V3 bridge: plain → tee/tail 漂移变体仍命中 success_unchanged", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vd-mv3-"));
  const sid = "00000000-0000-0000-0000-00000000c801";
  const r1 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD });
  assert.equal(r1.content, null, "first run has no previous fingerprint -> native");

  const r2 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD_WRAPPED });
  assert.match(r2.content, /^\[VALIDATION_DELTA\]/, "drifted rerun must find the baseline via semantic scan");
  assert.match(r2.content, /mode=success_unchanged/);

  const arb = arbitrationRows(base);
  assert.equal(arb.length, 2);
  assert.equal(arb[1].selected_capability, "validation_delta");
  assert.equal(arb[1].applied_capability, "validation_delta");
  assert.equal(arb[1].double_apply_count, 0);
});

test("VD M-V3 bridge: compound 不得与 plain baseline 比较；identical rerun 行为保持", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vd-mv3-"));
  const sid = "00000000-0000-0000-0000-00000000c802";
  const r1 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD });
  assert.equal(r1.content, null);

  const rCompound = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD_COMPOUND });
  assert.equal(rCompound.content, null, "compound command must not merge (fail-closed)");

  const rBack = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, command: CMD });
  assert.match(rBack.content, /^\[VALIDATION_DELTA\]/, "identical rerun compares as before (legacy behavior kept)");

  const arb = arbitrationRows(base);
  assert.equal(arb.length, 3);
  assert.deepEqual(arb[1].candidate_capabilities, [], "compound run must not see the plain baseline");
  assert.deepEqual(arb[2].candidate_capabilities, ["validation_delta"]);
  assert.equal(arb[2].selected_capability, "validation_delta");
});
