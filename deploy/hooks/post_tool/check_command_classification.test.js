"use strict";

// ============================================================================
// check_command_classification.test.js — Line-7 A 阶段 Gate
// ============================================================================
// A 阶段唯一变量 = classifyCommand 入口识别扩展（lint/check 工具族 → kind
// "check"）。不做输出内容判断（B 阶段分家族资格化）。
//
// 冻结 Gate：
//   13/13 intended command shapes  INCLUDE（kind=check）
//   历史 test/build                100% 不退化
//   危险 shell / interactive / watch / 变异类  → 不进 check（Native 或拒绝重放）
//   unknown command                → null
//   wrong_classification           = 0（npm install/git status/ruff format/cargo fix 等）
//   carrier                        13/13 eligible（失败诊断入口成立）
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyCommand,
  classifyCheckCommand,
} = require("./terminal_state.js");
const { isAutoCarrierEligible } = require("../pre_tool/failure_carrier_auto.js");

// 审计矩阵中 13 个 GAP(entry) 任务对应的命令形态。
const CHECK_SHAPES = [
  "npx eslint src/",
  "eslint .",
  "npm run lint",
  "mypy src/",
  "pyright",
  "ruff check .",
  "flake8 src/",
  "cargo check",
  "cargo clippy",
  "go vet ./...",
  "ninja",
  "gcc -c foo.c",
  "clang++ -c foo.cpp",
  "mvn compile",
];

test("A gate: 13/13 check command shapes INCLUDE as kind=check", () => {
  for (const cmd of CHECK_SHAPES) {
    assert.equal(classifyCommand(cmd), "check", cmd);
    assert.equal(classifyCheckCommand(cmd), true, cmd);
  }
});

test("A gate: mutation flags never classify as check (carrier replays the command)", () => {
  const mutations = [
    "eslint src/ --fix",
    "npm run lint:fix",
    "ruff check . --fix",
    "ruff format .",
    "cargo clippy --fix",
    "eslint src/ --watch",
  ];
  for (const cmd of mutations) {
    assert.notEqual(classifyCommand(cmd), "check", cmd);
    assert.equal(isAutoCarrierEligible({ toolName: "Bash", command: cmd }).eligible, false, cmd);
  }
});

test("A gate: historical test/build classification 100% unchanged", () => {
  const historical = [
    ["npm test", "test"],
    ["node --test", "test"],
    ["pytest", "test"],
    ["npm run build", "build"],
    ["tsc --noEmit", "build"],
    ["cargo build", "build"],
    ["go build ./...", "build"],
    ["make", "build"],
    ["cmake --build build", "build"],
    ["dotnet build", "build"],
  ];
  for (const [cmd, kind] of historical) {
    assert.equal(classifyCommand(cmd), kind, cmd);
  }
});

test("A gate: unknown / non-goal commands stay null (wrong_classification=0)", () => {
  const nulls = [
    "ls -la",
    "echo hi",
    "npm install",
    "git status",
    "node scripts/verify.js",
    "ruff format .",
    "cargo fix",
    "",
  ];
  for (const cmd of nulls) {
    assert.equal(classifyCommand(cmd), null, JSON.stringify(cmd));
  }
});

test("A gate: carrier eligibility 13/13 (failure diagnostic entry exists) with kind=check", () => {
  for (const cmd of CHECK_SHAPES) {
    const d = isAutoCarrierEligible({ toolName: "Bash", command: cmd });
    assert.equal(d.eligible, true, cmd);
    assert.equal(d.kind, "check", cmd);
  }
});

test("A gate: carrier safety guards still fire for check commands", () => {
  const rejections = [
    ["eslint src/ | tee out.log", "unsafe_shell_shape"],
    ["eslint src/ --watch", "interactive_or_watch"],
    ["mypy src/ && echo done", "unsafe_shell_shape"],
    ["ninja; rm -rf /", "unsafe_shell_shape"],
    ["eslint --version; cat secret", "unsafe_shell_shape"],
  ];
  for (const [cmd, reason] of rejections) {
    const d = isAutoCarrierEligible({ toolName: "Bash", command: cmd });
    assert.equal(d.eligible, false, cmd);
    assert.equal(d.reason, reason, cmd);
  }
});

test("A/B gate: kind=check success detection = frozen precise family patterns (B-phase)", () => {
  const { detectTerminalState, tryCompressSuccessTerminal } = require("./terminal_state.js");
  // B 阶段落地后：check 成功识别 = 行锚定精确形态（B1-B4 家族）；静默成功
  // 仍 unknown → Native。
  assert.equal(detectTerminalState("", "check"), "unknown");
  assert.equal(detectTerminalState("Success: no issues found in 42 source files\n", "check"), "success");
  assert.equal(detectTerminalState("All checks passed!\n", "check"), "success");
  // 跨家族 FP 负例：非 cargo 形态的 "Finished" 散文 → unknown。
  assert.equal(detectTerminalState("We finished reviewing the docs.\n", "check"), "unknown");
  // 失败证据仍由通用 failure patterns 识别（诊断路锚点，不用于成功压缩）。
  assert.equal(detectTerminalState("src/a.ts(3,5): error TS2322: bad\nFound 1 error.\n", "check"), "failure");
  // check 成功压缩仅在精确形态 + 有净节省时发生；静默/散文 → null。
  assert.equal(
    tryCompressSuccessTerminal({ toolName: "run_shell_command", command: "eslint .", text: "We finished reviewing the docs.\n" }),
    null
  );
});
