"use strict";

// ============================================================================
// run_smoke.js — P1 失败诊断自动处理（PreToolUse Auto Failure Carrier）确定性
// 冒烟（主线④）。零依赖、无模型。完整链路与真实会话同构：
//
//   1) PreToolUse（flag ON）→ 原命令被自动改写为 carrier shim 形态
//   2) 改写后的命令被真实执行恰一次（bash -c，与 Claude Code 的 Git Bash 一致）
//      → 失败：stdout 收到 FAILURE-CARRIER-CONTRACT-V1 报告，wrapper exit=0
//      → 成功：原始输出逐字节透传，无 carrier（主线①的 M3 保护）
//   3) PostToolUse → carrier 识别 → Diagnostic 唯一胜出 → 压缩交付
//   4) single execution：shim 执行行数 == rewrite 行数 == fixture 副作用标记数
//   5) fail-closed：unsafe 命令绝不改写（legacy 执行）
//
// 运行:node scripts/run_smoke.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const EXAMPLE_ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(EXAMPLE_ROOT, "..", "..", "adapters", "claude_bridge.js");
const HOOK_DIR = path.join(EXAMPLE_ROOT, "..", "..", "hooks");
const RUN_DIR = path.join(EXAMPLE_ROOT, ".tasco-runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));

const FAIL_CMD = "node --test --test-reporter=tap fixture_tests/fail.case.js";
const PASS_CMD = "node --test --test-reporter=tap fixture_tests/pass.case.js";
const UNSAFE_CMD = "npm test && echo done";

function bridgeEnv(base, prompt) {
  return {
    ...process.env,
    CODE_GUARD_BASE_DIR: base,
    CODE_GUARD_HOOK_DIR: HOOK_DIR,
    CODE_GUARD_AUTO_CANARY_V1A: "1",
    CODE_GUARD_CLAUDE_PROMPT: prompt,
    CODE_GUARD_TERMINAL_STATE: "1",
    CODE_GUARD_VALIDATION_DELTA: "",
    CODE_GUARD_FAILURE_CARRIER_AUTO: "1",
  };
}

function spawnBridge(base, prompt, event) {
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env: bridgeEnv(base, prompt),
    encoding: "utf8",
    timeout: 180000,
  });
  if (res.status !== 0) throw new Error(String(res.stderr));
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

// 真实执行一条（可能被改写的）命令——与 Claude Code 的 Git Bash 同构。
function execute(command, sessionEnv) {
  const bash = resolveBash();
  const res = bash
    ? cp.spawnSync(bash, ["-c", command], { cwd: EXAMPLE_ROOT, encoding: "utf8", timeout: 180000, windowsHide: true, env: { ...process.env, ...sessionEnv } })
    : cp.spawnSync(process.execPath, ["-e", command], { cwd: EXAMPLE_ROOT, encoding: "utf8", timeout: 180000, windowsHide: true, env: { ...process.env, ...sessionEnv } });
  return { stdout: String(res.stdout || ""), stderr: String(res.stderr || ""), status: res.status };
}

fs.mkdirSync(RUN_DIR, { recursive: true });
const base = path.join(RUN_DIR, "session");

// ---- 1. 失败链：PreToolUse 自动改写 ----
const pre = spawnBridge(base, "Run the validation suite.", {
  hook_event_name: "PreToolUse",
  session_id: "fc-smoke",
  tool_name: "Bash",
  tool_input: { command: FAIL_CMD },
});
const rewritten =
  pre.hookSpecificOutput && pre.hookSpecificOutput.updatedInput
    ? pre.hookSpecificOutput.updatedInput.command
    : FAIL_CMD;
const rewriteLanded = rewritten !== FAIL_CMD;

// ---- 2. 真实执行恰一次 ----
const exec = execute(rewritten, {
  CODE_GUARD_BASE_DIR: base,
  CODE_GUARD_HOOK_DIR: HOOK_DIR,
});

// ---- 3. PostToolUse：carrier → Diagnostic 唯一胜出 ----
const post = spawnBridge(base, "Run the validation suite.", {
  hook_event_name: "PostToolUse",
  session_id: "fc-smoke",
  cwd: EXAMPLE_ROOT,
  tool_name: "Bash",
  tool_input: { command: rewritten },
  tool_response: { stdout: exec.stdout, stderr: exec.stderr },
});
const delivered =
  post.hookSpecificOutput && post.hookSpecificOutput.updatedToolOutput
    ? post.hookSpecificOutput.updatedToolOutput.content ||
      post.hookSpecificOutput.updatedToolOutput.stdout
    : null;

// ---- telemetry（single execution / wrong capability）----
const readRows = (name) => {
  const ctx = path.join(base, "context_budget", "claude_auto_canary.jsonl");
  const shim = path.join(base, "carrier_shim.jsonl");
  const file = name === "shim" ? shim : ctx;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => (name === "shim" ? true : r.type === name));
};
const rewriteRows = readRows("failure_carrier_auto_rewrite");
const shimRows = readRows("shim");
const arbRows = readRows("auto_arbitration_v1");
const lastArb = arbRows[arbRows.length - 1] || {};
const diagApplied = arbRows.some((r) => r.applied_capability === "diagnostic_semantic");

// ---- 4. 成功透传（M3 保护）：同一机制不碰成功输出 ----
const prePass = spawnBridge(base, "Run the validation suite.", {
  hook_event_name: "PreToolUse",
  session_id: "fc-smoke-pass",
  tool_name: "Bash",
  tool_input: { command: PASS_CMD },
});
const passRewritten =
  prePass.hookSpecificOutput && prePass.hookSpecificOutput.updatedInput
    ? prePass.hookSpecificOutput.updatedInput.command
    : PASS_CMD;
const passExec = execute(passRewritten, {
  CODE_GUARD_BASE_DIR: base,
  CODE_GUARD_HOOK_DIR: HOOK_DIR,
});

// ---- 5. fail-closed：unsafe 命令绝不改写 ----
const preUnsafe = spawnBridge(base, "Run the validation suite.", {
  hook_event_name: "PreToolUse",
  session_id: "fc-smoke-unsafe",
  tool_name: "Bash",
  tool_input: { command: UNSAFE_CMD },
});
const unsafeRewritten =
  preUnsafe.hookSpecificOutput && preUnsafe.hookSpecificOutput.updatedInput
    ? preUnsafe.hookSpecificOutput.updatedInput.command
    : UNSAFE_CMD;

const checks = {
  "PreToolUse: 原命令被自动改写为 carrier 形态": rewriteLanded,
  "original_command 保留（in-band，逐字等于原命令）": Boolean(shimRows[0] && shimRows[0].original_command === FAIL_CMD),
  "original_exit_code 保留（真实非零）": Boolean(shimRows[0] && shimRows[0].original_exit_code === 1),
  "wrapper exit=0（transport 成功，is_error 不再发生）": exec.status === 0,
  "stdout 收到 Carrier V1 报告": exec.stdout.includes("[TASCO_FAILURE_CARRIER]") && exec.stdout.includes("original_exit_code=1"),
  "PostToolUse: Diagnostic 唯一胜出并交付": Boolean(diagApplied && delivered),
  "交付为压缩摘要（root cause 保留，raw 区块不在）": Boolean(
    delivered && /(assertionerror|10000|not ok)/i.test(delivered) && !delivered.includes("[TASCO_FAILURE_CARRIER_STDOUT]")
  ),
  "wrong_capability=0（无 terminal/VD 记账）": !arbRows.some((r) => r.applied_capability && r.applied_capability !== "diagnostic_semantic"),
  "double_apply=0": arbRows.length > 0 && arbRows.every((r) => r.double_apply_count === 0),
  "single execution（1 rewrite = 1 shim 执行行）": rewriteRows.length === 1 && shimRows.length === 1,
  "成功命令: 透传原始输出，绝不产生 failure carrier": Boolean(
    passExec.status === 0 && passExec.stdout.length > 0 && !passExec.stdout.includes("[TASCO_FAILURE_CARRIER]")
  ),
  "unsafe 命令: 不改写（legacy 执行）": unsafeRewritten === UNSAFE_CMD,
};

fs.writeFileSync(path.join(RUN_DIR, "carrier-report.txt"), exec.stdout);
if (delivered) fs.writeFileSync(path.join(RUN_DIR, "delivered-diagnostic.txt"), delivered);
fs.writeFileSync(path.join(RUN_DIR, "checks.json"), JSON.stringify(checks, null, 2));

console.log(`raw carrier    ${exec.stdout.length} chars (exit code in-band: 1)`);
console.log(`delivered diag ${delivered ? delivered.length : "NONE"} chars (${delivered ? (100 * delivered.length / exec.stdout.length).toFixed(1) : "-"}% of raw)`);
console.log(`success passthrough ${passExec.stdout.length} chars, carrier absent: ${!passExec.stdout.includes("[TASCO_FAILURE_CARRIER]")}`);
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"} - ${k}`);
console.log(allPass() ? "\nSMOKE PASS — real failure auto-carried into Diagnostic with single execution" : "\nSMOKE FAIL");
console.log(`evidence -> ${RUN_DIR}`);
process.exit(allPass() ? 0 : 1);

function allPass() {
  return Object.values(checks).every(Boolean);
}
