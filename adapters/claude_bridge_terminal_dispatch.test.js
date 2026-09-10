"use strict";

// ============================================================================
// claude_bridge_terminal_dispatch.test.js — P0 Terminal-State adapter dispatch
// 验证 bridge 作为 capability dispatcher 的 flag 语义（2026-09-04 integration）：
//   flag OFF: terminal 事件不得达 policy hook（零变化硬门）
//   flag ON : shell 事件达 policy hook -> terminal 判定（applied / native）
// 通过真实 spawn claude_bridge（stdin event -> stdout hook result）。
// 运行:node --test deploy/adapters/claude_bridge_terminal_dispatch.test.js
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const BRIDGE = path.join(__dirname, "claude_bridge.js");
const FIXTURE = path.join(
  __dirname,
  "..",
  "..",
  "docs",
  "experiments",
  "workflow-compression",
  "p0-agent-ab",
  "qualification",
  "fixtures",
  "f1-tap-44pass.out"
);
const tapText = fs.readFileSync(FIXTURE, "utf8");

function runBridge(event, extraEnv) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ts-dispatch-"));
  const env = {
    ...process.env,
    CODE_GUARD_BASE_DIR: base,
    CODE_GUARD_HOOK_DIR: path.join(__dirname, "..", "hooks"),
    CODE_GUARD_AUTO_CANARY_V1A: "1",
    CODE_GUARD_AUTO_CANARY_APPLY_POLICY: "current",
    ...extraEnv,
  };
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env,
    encoding: "utf8",
    timeout: 120000,
  });
  return { base, res };
}

function tapEvent(toolName) {
  return {
    hook_event_name: "PostToolUse",
    session_id: "00000000-0000-0000-0000-0000000000ab",
    cwd: process.cwd(),
    tool_name: toolName,
    tool_input: {
      command: 'node --test --test-reporter=tap test/route.6.test.js test/route.7.test.js test/constrained-routes.test.js',
    },
    tool_response: { stdout: tapText, stderr: "" },
  };
}

function rlmLogExists(base) {
  const walk = (d) => {
    if (!fs.existsSync(d)) return null;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      } else if (e.name === "rlm_after_tool_hook.log") {
        return p;
      }
    }
    return null;
  };
  return walk(path.join(base, "00000000-0000-0000-0000-0000000000ab")) || walk(base);
}

test("flag OFF: terminal-success shell event stays native - policy hook not invoked", () => {
  const { base, res } = runBridge(tapEvent("Bash"), { CODE_GUARD_TERMINAL_STATE: "0" });
  assert.equal(res.status, 0, `bridge exit: ${String(res.stderr).slice(0, 200)}`);
  const out = JSON.parse(String(res.stdout).trim() || "{}");
  assert.equal(out.hookSpecificOutput, undefined, "no updated output when flag off");
  assert.equal(rlmLogExists(base), null, "policy hook must NOT run when flag off (no rlm log)");
});

test("flag ON: terminal-success shell event reaches policy hook and applies", () => {
  const { base, res } = runBridge(tapEvent("Bash"), { CODE_GUARD_TERMINAL_STATE: "1" });
  assert.equal(res.status, 0, `bridge exit: ${String(res.stderr).slice(0, 200)}`);
  const out = JSON.parse(String(res.stdout).trim() || "{}");
  const updated = out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput;
  assert.ok(updated, "terminal output must be compressed when flag on");
  const content = updated.content || updated.stdout || "";
  assert.ok(content.includes("[TERMINAL_STATE_SUCCESS]"), "envelope present");
  assert.ok(content.length < tapText.length, "delivered shorter than raw");
  assert.ok(rlmLogExists(base), "policy hook ran (rlm log exists)");
});

test("flag ON: ordinary non-terminal shell event -> policy hook judges native (no output change)", () => {
  const ev = tapEvent("Bash");
  ev.tool_response = { stdout: "> hello\nsome ordinary output, nothing test-shaped here at all\n", stderr: "" };
  ev.tool_input.command = "echo hello";
  const { base, res } = runBridge(ev, { CODE_GUARD_TERMINAL_STATE: "1" });
  assert.equal(res.status, 0);
  const out = JSON.parse(String(res.stdout).trim() || "{}");
  assert.equal(out.hookSpecificOutput, undefined, "ordinary shell stays native");
  const log = rlmLogExists(base);
  assert.ok(log, "policy hook was consulted (rlm log exists)");
  const body = fs.readFileSync(log, "utf8");
  assert.ok(
    /terminal_dispatch native exit|skip tool=.*small_or_low_risk/.test(body),
    "policy hook judged native (dispatch exit or low-risk skip), got: " + body.slice(-200)
  );
});
