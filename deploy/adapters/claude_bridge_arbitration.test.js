"use strict";

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

test("A1 conflict: Diagnostic candidate + Terminal candidate has one Terminal delivery", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tasco-arbitration-"));
  const event = {
    hook_event_name: "PostToolUse",
    session_id: "00000000-0000-0000-0000-00000000a101",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: {
      command: "node --test --test-reporter=tap test/route.6.test.js test/route.7.test.js test/constrained-routes.test.js",
    },
    tool_response: { stdout: TAP44, stderr: "" },
  };
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env: {
      ...process.env,
      CODE_GUARD_BASE_DIR: base,
      CODE_GUARD_HOOK_DIR: path.join(__dirname, "..", "hooks"),
      CODE_GUARD_AUTO_CANARY_V1A: "1",
      CODE_GUARD_AUTO_CANARY_APPLY_POLICY: "current",
      CODE_GUARD_CLAUDE_PROMPT: "Run the validation and diagnose the result if it fails; do not modify files.",
      CODE_GUARD_TERMINAL_STATE: "1",
      CODE_GUARD_TERMINAL_STATE_SHADOW: "",
    },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(res.status, 0, String(res.stderr));
  const output = JSON.parse(String(res.stdout).trim() || "{}");
  const delivered = output.hookSpecificOutput && output.hookSpecificOutput.updatedToolOutput;
  const content = delivered && (delivered.content || delivered.stdout || "");
  assert.ok(content.includes("[TERMINAL_STATE_SUCCESS]"), "Terminal must win delivery");
  assert.ok(!content.includes("[Shell 工具输出快速摘要]"), "Diagnostic delivery must not also apply");

  const arbitration = readRows(base, "claude_auto_canary.jsonl").filter(
    (row) => row.type === "auto_arbitration_v1"
  );
  assert.equal(arbitration.length, 1);
  assert.deepEqual(arbitration[0].candidate_capabilities, ["diagnostic_semantic", "terminal_state_success"]);
  assert.deepEqual(arbitration[0].eligible_capabilities, ["diagnostic_semantic", "terminal_state_success"]);
  assert.equal(arbitration[0].selected_capability, "terminal_state_success");
  assert.equal(arbitration[0].applied_capability, "terminal_state_success");
  assert.equal(arbitration[0].double_apply_count, 0);
  assert.equal(arbitration[0].arbitration_version, "AUTO-ARBITRATION-V1");

  const applied = readRows(base, "tasco_compression.ndjson").filter((row) => row.applied === true);
  assert.equal(applied.length, 1, "one tool result must have one applied delivery");
  assert.equal(applied[0].strategy, "terminal_state_success");
});
