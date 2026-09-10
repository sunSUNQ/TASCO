"use strict";

// ============================================================================
// run_smoke.js — M3 Validation Delta 确定性冒烟（主线③）
// 零依赖、无模型。用真实 frozen bridge（claude_bridge.js）验证：
//   1) flag OFF  : 两次相同验证逐字节 Native，无 VD 痕迹（回滚门）
//   2) 首次成功  : 无 comparable previous → 不伪造 delta（Native）
//   3) 重复成功  : [VALIDATION_DELTA] mode=success_unchanged，只报"没变"
//   4) 计数变化  : mode=success_counts_changed，只报"变了多少"
// 观测产物落在 .tasco-runs/<timestamp>/ 下。
// 说明：本冒烟关闭 Terminal-State 以隔离 M3 primitive；真实会话中 terminal 与
// VD 的优先级由主线②的冻结仲裁决定（stable VD > terminal）。
// 运行:node scripts/run_smoke.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const EXAMPLE_ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(EXAMPLE_ROOT, "..", "..", "adapters", "claude_bridge.js");
const RUN_DIR = path.join(EXAMPLE_ROOT, ".tasco-runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const CMD = "node --test --test-reporter=tap test/route.test.js";

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

const TAP45 = tapText(45);
const TAP50 = tapText(50);

function spawnBridge({ base, sessionId, stdoutText, vdFlag }) {
  const event = {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    cwd: EXAMPLE_ROOT,
    tool_name: "Bash",
    tool_input: { command: CMD },
    tool_response: { stdout: stdoutText, stderr: "" },
  };
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env: {
      ...process.env,
      CODE_GUARD_BASE_DIR: base,
      CODE_GUARD_HOOK_DIR: path.join(EXAMPLE_ROOT, "..", "..", "hooks"),
      CODE_GUARD_AUTO_CANARY_V1A: "1",
      CODE_GUARD_CLAUDE_PROMPT: "Run the validation suite and report the result.",
      CODE_GUARD_VALIDATION_DELTA: vdFlag ? "1" : "",
      CODE_GUARD_TERMINAL_STATE: "",
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

const base = path.join(RUN_DIR, "session");
fs.mkdirSync(base, { recursive: true });
const baseOff = path.join(RUN_DIR, "flag-off");
fs.mkdirSync(baseOff, { recursive: true });

// 1) flag OFF：两次相同验证 → Native，无 VD 痕迹、无 fingerprint 状态文件
const off1 = spawnBridge({ base: baseOff, sessionId: "smoke-off", stdoutText: TAP45, vdFlag: false });
const off2 = spawnBridge({ base: baseOff, sessionId: "smoke-off", stdoutText: TAP45, vdFlag: false });

// 2)–4) flag ON：首次 → Native；重复 → unchanged；计数变化 → counts_changed
const r1 = spawnBridge({ base, sessionId: "smoke-vd", stdoutText: TAP45, vdFlag: true });
const r2 = spawnBridge({ base, sessionId: "smoke-vd", stdoutText: TAP45, vdFlag: true });
const r3 = spawnBridge({ base, sessionId: "smoke-vd", stdoutText: TAP50, vdFlag: true });

const stateFiles = fs.existsSync(path.join(baseOff, "context_budget"))
  ? fs.readdirSync(path.join(baseOff, "context_budget")).filter((n) => n.startsWith("claude_validation_"))
  : [];

const checks = {
  "flag OFF: 第一次 Native": off1.content === null,
  "flag OFF: 重复执行仍 Native（无 delta）": off2.content === null,
  "flag OFF: 无 fingerprint 状态文件（逐字节回滚）": stateFiles.length === 0,
  "首次成功: 不伪造 delta（无 comparable previous）": r1.content === null,
  "重复成功: 交付 [VALIDATION_DELTA]": Boolean(r2.content && r2.content.startsWith("[VALIDATION_DELTA]")),
  "重复成功: mode=success_unchanged": Boolean(r2.content && r2.content.includes("mode=success_unchanged")),
  "重复成功: 只报结果不重传全文（< 原文 20%）": Boolean(r2.content && r2.content.length < TAP45.length * 0.2),
  "重复成功: 保留权威计数 (counts: pass=45)": Boolean(r2.content && /pass=45/.test(r2.content)),
  "计数变化: mode=success_counts_changed": Boolean(r3.content && r3.content.includes("mode=success_counts_changed")),
  "计数变化: 报告增量 (pass 45->50)": Boolean(r3.content && r3.content.includes("pass 45->50")),
  "计数变化: 仍然只传变化（< 原文 5%）": Boolean(r3.content && r3.content.length < TAP50.length * 0.05),
};

fs.writeFileSync(path.join(RUN_DIR, "runs.json"), JSON.stringify({
  off1: off1.content, off2: off2.content, r1: r1.content, r2: r2.content, r3: r3.content,
}, null, 2));
fs.writeFileSync(path.join(RUN_DIR, "checks.json"), JSON.stringify(checks, null, 2));

console.log(`raw TAP45 ${TAP45.length} chars -> unchanged delta ${r2.content ? r2.content.length : "NONE"} chars`);
console.log(`raw TAP50 ${TAP50.length} chars -> counts_changed delta ${r3.content ? r3.content.length : "NONE"} chars`);
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"} - ${k}`);
console.log(allPass(checks) ? "\nSMOKE PASS — repeated validation reports only the change" : "\nSMOKE FAIL");
console.log(`evidence -> ${RUN_DIR}`);
process.exit(allPass(checks) ? 0 : 1);

function allPass(checks) {
  return Object.values(checks).every(Boolean);
}
