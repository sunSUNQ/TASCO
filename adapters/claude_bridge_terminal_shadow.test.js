"use strict";

// ============================================================================
// claude_bridge_terminal_shadow.test.js — Shadow mode matrix (integration)
// 验证 6 场景 x 3 模式 + 双 flag 判非法：
//   default / shadow / auto 走同一条 dispatch->classifier->telemetry 链，
//   唯一区别在 delivery 是否替换；shadow 永不污染 actual 统计
//   (tasco_shadow.ndjson 独立桶)。
// 运行:node --test deploy/adapters/claude_bridge_terminal_shadow.test.js
// ============================================================================

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

const TAP_CMD = "node --test --test-reporter=tap test/route.6.test.js test/route.7.test.js test/constrained-routes.test.js";

function runBridge({ stdout, cmd = TAP_CMD, extraEnv = {} }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ts-shadow-"));
  const env = {
    ...process.env,
    CODE_GUARD_BASE_DIR: base,
    CODE_GUARD_HOOK_DIR: path.join(__dirname, "..", "hooks"),
    CODE_GUARD_AUTO_CANARY_V1A: "1",
    CODE_GUARD_AUTO_CANARY_APPLY_POLICY: "current",
    ...extraEnv,
  };
  const event = {
    hook_event_name: "PostToolUse",
    session_id: "00000000-0000-0000-0000-00000000abcd",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: cmd },
    tool_response: { stdout, stderr: "" },
  };
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event), env, encoding: "utf8", timeout: 120000,
  });
  return { base, res };
}

function readShadowRows(base) {
  const hits = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "tasco_shadow.ndjson") {
        for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
          if (l.trim()) { try { hits.push(JSON.parse(l)); } catch { /* skip */ } }
        }
      }
    }
  };
  walk(base);
  return hits;
}
function appliedRows(base) {
  const hits = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "tasco_compression.ndjson") {
        for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
          if (l.trim()) { try { const r = JSON.parse(l); if (r.applied === true) hits.push(r); } catch { /* skip */ } }
        }
      }
    }
  };
  walk(base);
  return hits;
}
function outOf(res) {
  try { return JSON.parse(String(res.stdout).trim() || "{}"); } catch { return {}; }
}

// padding: benign per-test lines to exceed the hook's short-output gate so the
// case actually reaches the terminal block (semantics carried by markers only)
const padOk = (n) => "ok 1 - padding line " + "x".repeat(40) + "\n".repeat(0) +
  Array.from({ length: n }, (_, i) => `# Subtest: padding ${i}\nok ${i + 1} - padding case ${i} (${i}ms)\n`).join("");

const FIXTURES = {
  success_test: { stdout: TAP44, cmd: TAP_CMD, label: "recognized successful test" },
  failed_validation: {
    stdout: padOk(120) + "\nnot ok 99 - simulated failing case\n# tests 120\n# pass 119\n# fail 1\n# skipped 0\n",
    cmd: TAP_CMD, label: "failed validation",
  },
  unknown_reporter: {
    stdout: "✔ route works (12ms)\n".repeat(400) + "\nℹ tests 400\nℹ pass 400\nℹ fail 0\n",
    cmd: TAP_CMD, label: "unknown reporter shape",
  },
  truncated: { stdout: TAP44.slice(0, 6000), cmd: TAP_CMD, label: "truncated / incomplete summary" },
  non_validation: { stdout: "> hello\n" + "ordinary output\n".repeat(300), cmd: "echo hello", label: "non-validation shell" },
};

for (const [key, fx] of Object.entries(FIXTURES)) {
  test(`shadow matrix - ${fx.label} | default = native, no shadow rows`, () => {
    const { base, res } = runBridge({ stdout: fx.stdout, cmd: fx.cmd });
    assert.equal(res.status, 0);
    assert.equal(outOf(res).hookSpecificOutput, undefined, "default never replaces output");
    assert.equal(readShadowRows(base).length, 0, "default writes no shadow rows");
  });
  test(`shadow matrix - ${fx.label} | shadow = native delivery + projection rows only`, () => {
    const { base, res } = runBridge({ stdout: fx.stdout, cmd: fx.cmd, extraEnv: { CODE_GUARD_TERMINAL_STATE_SHADOW: "1" } });
    assert.equal(res.status, 0);
    assert.equal(outOf(res).hookSpecificOutput, undefined, "shadow never replaces output");
    assert.equal(appliedRows(base).length, 0, "shadow writes no ACTUAL applied rows (bucket separation)");
    const rows = readShadowRows(base);
    if (fx.label === "recognized successful test") {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].would_apply, true);
      assert.equal(rows[0].actual_delivery, "native");
      assert.ok(rows[0].shadow_projected_saved_chars > 0);
    } else if (fx.label === "non-validation shell") {
      assert.equal(rows.length, 0, "non-opportunity shells record nothing");
    } else {
      assert.equal(rows.length, 1, "validation-shaped declines record explanation");
      assert.equal(rows[0].would_apply, false);
    }
  });
  test(`shadow matrix - ${fx.label} | auto = frozen-zone apply only`, () => {
    const { base, res } = runBridge({ stdout: fx.stdout, cmd: fx.cmd, extraEnv: { CODE_GUARD_TERMINAL_STATE: "1" } });
    assert.equal(res.status, 0);
    const applied = appliedRows(base).length;
    if (fx.label === "recognized successful test") {
      assert.equal(applied, 1, "auto applies recognized success");
      assert.ok(outOf(res).hookSpecificOutput, "agent receives candidate in auto");
    } else {
      assert.equal(applied, 0, `${fx.label} stays native in auto`);
      assert.equal(outOf(res).hookSpecificOutput, undefined);
    }
    assert.equal(readShadowRows(base).length, 0, "auto writes no shadow rows");
  });
}

test("double flag (TERMINAL_STATE=1 + SHADOW=1) = configuration invalid, terminal Native, session alive", () => {
  const { base, res } = runBridge({ stdout: TAP44, extraEnv: { CODE_GUARD_TERMINAL_STATE: "1", CODE_GUARD_TERMINAL_STATE_SHADOW: "1" } });
  assert.equal(res.status, 0);
  assert.equal(outOf(res).hookSpecificOutput, undefined, "no terminal compression under invalid config");
  assert.equal(appliedRows(base).length, 0);
  assert.equal(readShadowRows(base).length, 0);
  // diagnostic chain still active (session not killed): auto_canary event recorded
  const ac = fs.readFileSync(path.join(base, "context_budget", "claude_auto_canary.jsonl"), "utf8");
  assert.ok(ac.includes("terminal_configuration_invalid"), "invalid config recorded: " + ac.slice(-160));
});

test("shadow vs default: delivered (agent-visible) output is byte-identical", () => {
  const def = runBridge({ stdout: TAP44 });
  const shd = runBridge({ stdout: TAP44, extraEnv: { CODE_GUARD_TERMINAL_STATE_SHADOW: "1" } });
  assert.equal(String(def.res.stdout), String(shd.res.stdout), "Default and Shadow agent-visible payload identical");
});
