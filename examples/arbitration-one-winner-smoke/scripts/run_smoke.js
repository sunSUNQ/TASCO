"use strict";

// ============================================================================
// run_smoke.js — A0/A1 多能力自动选择（冻结仲裁）确定性冒烟（主线②）
// 零依赖、无模型。用真实 frozen bridge + arbitration runtime 验证：
//   1) 三向冲突（诊断候选 + 稳定 VD + 成功终态同时 eligible）→ VD 唯一胜出
//   2) 失败 carrier + 成功形态正文 → 失败诊断按冻结 precedence 压过 Terminal
//   3) malformed carrier → Native（无 winner、无交付、无记账）
//   每个格子：one output → one winner；double_apply_count 恒为 0。
// 运行:node scripts/run_smoke.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const EXAMPLE_ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(EXAMPLE_ROOT, "..", "..", "adapters", "claude_bridge.js");
const RUN_DIR = path.join(EXAMPLE_ROOT, ".tasco-runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const OBS_DIAG_PROMPT =
  "Analyze the output and identify the root cause. This is analysis only - do not modify anything.";

function tapText(passCount) {
  return [
    "TAP version 13",
    ...Array.from({ length: passCount }, (_, i) => `ok ${i + 1} - route constraint ${i} registers the host scoped matcher`),
    `1..${passCount}`,
    `# tests ${passCount}`,
    `# pass ${passCount}`,
    "# fail 0",
  ].join("\n");
}

const TAP100 = tapText(100);
const CMD = "node --test --test-reporter=tap test/route.test.js";

function spawnBridge({ base, sessionId, command, stdoutText, vdFlag }) {
  const event = {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    cwd: EXAMPLE_ROOT,
    tool_name: "Bash",
    tool_input: { command: command || CMD },
    tool_response: { stdout: stdoutText, stderr: "" },
  };
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env: {
      ...process.env,
      CODE_GUARD_BASE_DIR: base,
      CODE_GUARD_HOOK_DIR: path.join(EXAMPLE_ROOT, "..", "..", "hooks"),
      CODE_GUARD_AUTO_CANARY_V1A: "1",
      CODE_GUARD_CLAUDE_PROMPT: OBS_DIAG_PROMPT,
      CODE_GUARD_VALIDATION_DELTA: vdFlag ? "1" : "",
      CODE_GUARD_TERMINAL_STATE: "1",
      CODE_GUARD_TERMINAL_STATE_SHADOW: "",
      CODE_GUARD_FAILURE_CARRIER_AUTO: "",
    },
    encoding: "utf8",
    timeout: 120000,
  });
  if (res.status !== 0) throw new Error(String(res.stderr));
  const output = JSON.parse(String(res.stdout).trim() || "{}");
  const delivered = output.hookSpecificOutput && output.hookSpecificOutput.updatedToolOutput;
  const content = delivered && (delivered.content || delivered.stdout || "");
  return { content: content || null };
}

function readArb(base) {
  const rows = [];
  const ctx = path.join(base, "context_budget", "claude_auto_canary.jsonl");
  if (!fs.existsSync(ctx)) return rows;
  for (const line of fs.readFileSync(ctx, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.type === "auto_arbitration_v1") rows.push(row);
  }
  return rows;
}

// ---- Cell 1: 三向冲突 → 稳定 VD 唯一胜出 ----
const c1Base = path.join(RUN_DIR, "cell1-three-way");
fs.mkdirSync(c1Base, { recursive: true });
const c1r1 = spawnBridge({ base: c1Base, sessionId: "arb-c1", stdoutText: TAP100, vdFlag: true });
const c1r2 = spawnBridge({ base: c1Base, sessionId: "arb-c1", stdoutText: TAP100, vdFlag: true });
const c1arb1 = readArb(c1Base)[0];
const c1arb2 = readArb(c1Base)[1];

// ---- Cell 2: 失败 carrier + 成功形态正文 → Diagnostic 压过 Terminal ----
const c2Base = path.join(RUN_DIR, "cell2-failure-beats-terminal");
fs.mkdirSync(c2Base, { recursive: true });
const failureCarrier = [
  "[TASCO_FAILURE_CARRIER] carrier_version=1 transport=pre_tool_use_auto",
  "original_command=" + CMD,
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
const c2 = spawnBridge({ base: c2Base, sessionId: "arb-c2", command: "node --test x.test.js", stdoutText: failureCarrier, vdFlag: false });
const c2arb = readArb(c2Base)[0];

// ---- Cell 3: malformed carrier → Native ----
const c3Base = path.join(RUN_DIR, "cell3-native-fallback");
fs.mkdirSync(c3Base, { recursive: true });
const c3 = spawnBridge({
  base: c3Base, sessionId: "arb-c3", command: "node --test x.test.js", vdFlag: false,
  stdoutText: "[TASCO_FAILURE_CARRIER_BROKEN] command failed carrier_version=1\nno blocks here\n",
});
const c3arb = readArb(c3Base)[0];

const compressionRows = (base) => {
  const ctx = path.join(base, "context_budget", "claude_auto_canary.jsonl");
  if (!fs.existsSync(ctx)) return [];
  return fs.readFileSync(ctx, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l)).filter((r) => r.type === "compression");
};

const checks = {
  "Cell1 run1: 首次成功 → Terminal 唯一 winner": c1arb1 && c1arb1.selected_capability === "terminal_state_success" && c1arb1.applied_capability === "terminal_state_success",
  "Cell1 run2: 三向候选同时在场": Boolean(
    c1arb2 &&
    c1arb2.candidate_capabilities.includes("diagnostic_semantic") &&
    c1arb2.candidate_capabilities.includes("validation_delta") &&
    c1arb2.candidate_capabilities.includes("terminal_state_success")
  ),
  "Cell1 run2: 稳定 VD 唯一胜出（不落 terminal、不落 native）": Boolean(
    c1arb2 && c1arb2.selected_capability === "validation_delta" && c1arb2.applied_capability === "validation_delta"
  ),
  "Cell1: 每次输出只交付一次（double_apply=0）": Boolean(
    c1arb1 && c1arb2 && c1arb1.double_apply_count === 0 && c1arb2.double_apply_count === 0
  ),
  "Cell1 run2: 交付 [VALIDATION_DELTA]": Boolean(c1r2.content && c1r2.content.startsWith("[VALIDATION_DELTA]")),
  "Cell2: 失败诊断按冻结 precedence 胜出": Boolean(
    c2arb && c2arb.selected_capability === "diagnostic_semantic" && c2arb.selection_reason === "failure_diagnostic_precedence"
  ),
  "Cell2: terminal 候选在场但未胜出": Boolean(
    c2arb && c2arb.candidate_capabilities.includes("terminal_state_success") && c2arb.applied_capability === "diagnostic_semantic"
  ),
  "Cell2: 单次交付（double_apply=0）": Boolean(c2arb && c2arb.double_apply_count === 0),
  "Cell3: malformed → 无 winner（Native fallback）": Boolean(c3arb && c3arb.selected_capability === null && c3arb.fallback_reason === "failure_carrier_malformed"),
  "Cell3: 无交付、无记账": c3.content === null && compressionRows(c3Base).length === 0,
};

fs.writeFileSync(path.join(RUN_DIR, "checks.json"), JSON.stringify(checks, null, 2));
fs.writeFileSync(path.join(RUN_DIR, "arbitration-rows.json"), JSON.stringify({
  cell1_run1: c1arb1, cell1_run2: c1arb2, cell2: c2arb, cell3: c3arb,
}, null, 2));

const delivery = (c) => (c && c.content ? `${c.content.length} chars` : "(native)");
console.log(`cell1 run1 delivery: ${delivery(c1r1)}  winner=terminal`);
console.log(`cell1 run2 delivery: ${delivery(c1r2)}  winner=validation_delta (3-way)`);
console.log(`cell2 delivery: ${delivery(c2)}  winner=diagnostic (failure precedence)`);
console.log(`cell3 delivery: ${delivery(c3)}  winner=none (native)`);
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"} - ${k}`);
console.log(allPass() ? "\nSMOKE PASS — one output, one winner, zero double apply" : "\nSMOKE FAIL");
console.log(`evidence -> ${RUN_DIR}`);
process.exit(allPass() ? 0 : 1);

function allPass() {
  return Object.values(checks).every(Boolean);
}
