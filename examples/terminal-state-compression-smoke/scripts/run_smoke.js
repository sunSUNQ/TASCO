"use strict";

// ============================================================================
// run_smoke.js — Terminal-State Success Compression 确定性冒烟
// 零依赖、无模型。用真实 frozen policy hook（post_tool_policy_hook.js）验证：
//   1) 离线 boundary arm OFF: 交付原生路径（隔离硬门）
//   2) 离线 boundary arm ON : 真实 node:test 成功终态输出被提取式压缩并保留合同
// 观测产物落在 .tasco-runs/<timestamp>/ 下。
// 运行:node scripts/run_smoke.js
// ============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const EXAMPLE_ROOT = path.resolve(__dirname, "..");
const DEPLOY_ROOT = path.resolve(EXAMPLE_ROOT, "..", ".."); // deploy/
const HOOK = path.join(DEPLOY_ROOT, "hooks", "post_tool_policy_hook.js");
const TEST_CMD = "node --test --test-reporter=tap fixture_tests/sample.test.js";
const RUN_DIR = path.join(EXAMPLE_ROOT, ".tasco-runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));

// ---- 1. 运行真实测试,捕获成功终态输出（agent 视角的原始 Bash 输出）----
const runRes = cp.spawnSync(process.execPath, ["--test", "--test-reporter=tap", "fixture_tests/sample.test.js"], {
  cwd: EXAMPLE_ROOT, encoding: "utf8", timeout: 120000,
});
if (runRes.status !== 0) {
  console.error("fixture test failed to run cleanly (expected exit 0)");
  process.exit(1);
}
const raw = String(runRes.stdout);

// ---- 2. 离线 boundary smoke：分别以 arm OFF / arm ON 处理同一输出 ----
function runHook(flag) {
  const base = path.join(RUN_DIR, flag ? "terminal-arm" : "baseline-arm");
  fs.mkdirSync(base, { recursive: true });
  const payload = {
    tool_name: "run_shell_command",
    tool_use_id: `ts-smoke-${flag ? "on" : "off"}-${crypto.randomUUID().slice(0, 8)}`,
    tool_input: { command: TEST_CMD },
    tool_response: { stdout: raw, stderr: "" },
  };
  const env = {
    ...process.env,
    CODE_GUARD_BASE_DIR: base,
    CODE_GUARD_HOOK_DIR: path.join(DEPLOY_ROOT, "hooks"),
    ...(flag ? { CODE_GUARD_TERMINAL_STATE: "1" } : {}),
  };
  const res = cp.spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), env, encoding: "utf8", timeout: 60000,
  });
  const out = JSON.parse(String(res.stdout).trim() || "{}");
  const updated = out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput;
  const delivered = typeof updated === "string" ? updated : (updated && updated.stdout) || null;
  return { base, delivered };
}

const baseline = runHook(false);
const terminal = runHook(true);

// ---- 3. 断言 + 汇总（计数断言从 raw 动态解析，fixture 改动鲁棒）----
const rawPass = (raw.match(/# pass (\d+)/) || [])[1];
const rawSkip = (raw.match(/# skipped (\d+)/) || [])[1];
const rawFail = (raw.match(/# fail (\d+)/) || [])[1];
const checks = {
  // 注：直接调用 policy hook 时，flag-off 仍会走 hook 自带的 quick_shell 截断
  // （真实 Claude 链中 flag-off 根本不会把这类 shell 事件送进 hook —— 见
  // adapter dispatch 设计）。这里验证的是：quick_shell 截断与 terminal 提取式
  // 压缩可区分，且 flag-off 绝不产生 terminal envelope/记账。
  "baseline: 无 terminal envelope": baseline.delivered === null || !baseline.delivered.includes("[TERMINAL_STATE_SUCCESS]"),
  "baseline: 无 terminal 省略记账": baseline.delivered === null || !/omitted_case_lines=\d+/.test(baseline.delivered),
  "terminal: 压缩发生(envelope)": Boolean(terminal.delivered && terminal.delivered.includes("[TERMINAL_STATE_SUCCESS]")),
  "terminal: 有省略记账": Boolean(terminal.delivered && /omitted_case_lines=\d+/.test(terminal.delivered)),
  [`terminal: 成功计数保留 (# pass ${rawPass})`]: Boolean(terminal.delivered && rawPass !== undefined && terminal.delivered.includes(`# pass ${rawPass}`)),
  [`terminal: skipped 保留 (# skipped ${rawSkip})`]: Boolean(terminal.delivered && rawSkip !== undefined && terminal.delivered.includes(`# skipped ${rawSkip}`)),
  [`terminal: 失败计数保留 (# fail ${rawFail})`]: Boolean(terminal.delivered && rawFail !== undefined && terminal.delivered.includes(`# fail ${rawFail}`)),
  "terminal: 形成节省": Boolean(terminal.delivered && terminal.delivered.length < raw.length),
  "terminal: 合同组合唯一（envelope+记账+计数+skipped 同现）": Boolean(
    terminal.delivered && terminal.delivered.includes("[TERMINAL_STATE_SUCCESS]") &&
    /omitted_case_lines=\d+/.test(terminal.delivered) &&
    terminal.delivered.includes(`# pass ${rawPass}`) &&
    terminal.delivered.includes(`# skipped ${rawSkip}`) &&
    terminal.delivered.includes(`# fail ${rawFail}`)
  ),
};
const allPass = Object.values(checks).every(Boolean);

fs.writeFileSync(path.join(RUN_DIR, "raw-tool-output.txt"), raw);
if (terminal.delivered) fs.writeFileSync(path.join(RUN_DIR, "delivered-terminal.txt"), terminal.delivered);
fs.writeFileSync(path.join(RUN_DIR, "checks.json"), JSON.stringify(checks, null, 2));

console.log(`raw           ${raw.length} chars`);
console.log(`baseline arm  delivered=${baseline.delivered ? baseline.delivered.length : "(native, unchanged)"}`);
console.log(`terminal arm  delivered=${terminal.delivered ? terminal.delivered.length : "NONE"}  (${terminal.delivered ? (100 * terminal.delivered.length / raw.length).toFixed(1) : "-"}% of raw)`);
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"} - ${k}`);
console.log(allPass ? "\nSMOKE PASS — terminal-state compression fired with contract preserved" : "\nSMOKE FAIL");
console.log(`evidence -> ${RUN_DIR}`);
process.exit(allPass ? 0 : 1);
