#!/usr/bin/env node
"use strict";

// ============================================================================
// validation_coverage_audit.js — 开发验证任务覆盖矩阵探针（只读，零改动）
// ============================================================================
// 回答一个问题：v0.6 的 Shell 域三能力（Failure Diagnostic / Terminal-State /
// Validation Delta）对常见"开发验证任务"到底覆盖到哪？
//
// 探针维度（全部调用冻结 runtime 函数，确定性）：
//   1. classifyCommand(cmd)      → test | build | null（三能力共享的入口门）
//   2. tryCompressSuccessTerminal(成功输出) → Terminal-State 是否介入
//   3. detectTerminalState(失败输出) → 失败语义是否可识别（Failure Diagnostic
//      经 carrier 的资格锚点）
//   4. isAutoCarrierEligible     → 失败命令是否会被自动包装进诊断链
//   5. VD                        → classifyCommand === "test" 才有 delta 资格
// 判语：FULL COVERED / PARTIAL / ENTRY-ONLY（入口进但输出识别盲）/ GAP（入口外）
// ============================================================================

const { classifyCommand, createTerminalStateCompressor } = require("../hooks/post_tool/terminal_state.js");
const { isAutoCarrierEligible } = require("../hooks/pre_tool/failure_carrier_auto.js");

const terminal = createTerminalStateCompressor({});

// 成功样本按真实尺寸构造（测试 runner/详细构建是大输出；tsc/eslint/go 成功时
// 静默——静默即无可压缩，Terminal 不介入是正确行为，标注 quiet）。
function tapLines(n) {
  return ["TAP version 13", ...Array.from({ length: n }, (_, i) => `ok ${i + 1} - route constraint ${i} registers the host scoped matcher`), `1..${n}`, `# tests ${n}`, `# pass ${n}`, "# fail 0"].join("\n");
}
const BUILD_LOG = ["> webpack 5.89.0", ...Array.from({ length: 60 }, (_, i) => `asset chunk.${i}.js 12.4 KiB [emitted] [minimized]`), "✓ built in 21.34s"].join("\n");
const CMAKE_LOG = Array.from({ length: 40 }, (_, i) => `[${i + 1}/40] Building CXX object src/module_${i}.cpp.o`).concat(["[40/40] Linking CXX executable app", "Build finished"]).join("\n");
const MVN_LOG = Array.from({ length: 30 }, (_, i) => `[INFO] Building module-${i} 1.0.0 [${i + 1}/30]`).concat(["[INFO] BUILD SUCCESS", "[INFO] Total time: 41.2 s"]).join("\n");

const MATRIX = [
  { task: "单元测试 (pytest/node test)", cmd: "npm test", success: tapLines(46), failure: "TAP version 13\nnot ok 1 - case A\n# fail 3\n" },
  { task: "构建 (npm build)", cmd: "npm run build", success: BUILD_LOG, failure: "ERROR in src/a.ts:3:5\nTS2322: Type 'number' is not assignable to type 'string'.\n" },
  { task: "类型检查 (tsc)", cmd: "tsc --noEmit", success: "(quiet)", failure: "src/a.ts(3,5): error TS2322: Type 'number' is not assignable to type 'string'.\nFound 1 error.\n" },
  { task: "类型检查 (tsc -p)", cmd: "tsc -p tsconfig.json", success: "(quiet)", failure: "src/a.ts(3,5): error TS2322: Type 'number' is not assignable.\nFound 2 errors.\n" },
  { task: "Lint (eslint)", cmd: "npx eslint src/", success: "(quiet)", failure: "/repo/src/a.js\n  3:5  error  'x' is defined but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)\n" },
  { task: "Lint (npm run lint)", cmd: "npm run lint", success: "(quiet)", failure: "src/a.js\n  3:5  error  'x' is defined but never used  no-unused-vars\n✖ 1 problem (1 error, 0 warnings)\n" },
  { task: "Python 类型 (mypy)", cmd: "mypy src/", success: "Success: no issues found in 42 source files\n", failure: "src/a.py:3: error: Incompatible types in assignment (expression has type \"int\", variable has type \"str\")  [assignment]\nFound 1 error in 1 file (checked 42 source files)\n" },
  { task: "Python 类型 (pyright)", cmd: "pyright", success: "0 errors, 0 warnings, 0 informations\n", failure: "src/a.py:3:5 - error: Type \"int\" is not assignable to \"str\"\n1 error, 0 warnings, 0 informations\n" },
  { task: "Rust 检查 (cargo check)", cmd: "cargo check", success: "    Checking repo v0.1.0\n    Finished dev [unoptimized + debuginfo] target(s) in 1.23s\n", failure: "error[E0308]: mismatched types\n --> src/main.rs:3:5\n  = note: expected `i32`, found `String`\nerror: could not compile `repo` due to 1 previous error\n" },
  { task: "Rust Lint (clippy)", cmd: "cargo clippy", success: "    Finished dev [unoptimized + debuginfo] target(s) in 2.10s\n", failure: "warning: unused variable: `x`\n --> src/main.rs:3:9\nerror: could not compile `repo` due to 1 previous error\n" },
  { task: "Rust 构建 (cargo build)", cmd: "cargo build", success: "    Finished dev [unoptimized + debuginfo] target(s) in 4.51s\n", failure: "error: could not compile `repo` due to 2 previous errors\n" },
  { task: "Go 构建", cmd: "go build ./...", success: "(quiet)", failure: "# repo/pkg\n./a.go:3:5: cannot use x (type int) as type string\n" },
  { task: "Go vet", cmd: "go vet ./...", success: "(quiet)", failure: "# repo/pkg\n./a.go:3:5: Printf format %s has arg x of wrong type\n" },
  { task: "make", cmd: "make", success: "make: Nothing to be done for 'all'.\n", failure: "cc -c foo.c\nfoo.c:3:5: error: expected ';' before '}' token\nmake: *** [Makefile:12: all] Error 1\n" },
  { task: "cmake 构建", cmd: "cmake --build build", success: CMAKE_LOG, failure: "FAILED: foo.cpp.o \nfoo.cpp:3:5: error: expected ';' before '}' token\nninja: build stopped: subcommand failed.\n" },
  { task: "ninja", cmd: "ninja", success: CMAKE_LOG, failure: "FAILED: foo.cpp.o\nninja: build stopped: subcommand failed.\n" },
  { task: "C 编译 (gcc)", cmd: "gcc -c foo.c", success: "(quiet)", failure: "foo.c:3:5: error: expected ';' before '}' token\n1 error generated.\n" },
  { task: "C++ 编译 (clang)", cmd: "clang++ -c foo.cpp", success: "(quiet)", failure: "foo.cpp:3:5: error: expected ';' before '}' token\n1 error generated.\n" },
  { task: "Java 构建 (mvn)", cmd: "mvn compile", success: MVN_LOG, failure: "[ERROR] COMPILATION ERROR :\n[INFO] 1 error\n[INFO] BUILD FAILURE\n" },
  { task: ".NET 构建", cmd: "dotnet build", success: "Build succeeded.\n    0 Warning(s)\n    0 Error(s)\n", failure: "Build FAILED.\n\na.cs(3,5): error CS0029: Cannot implicitly convert type 'int' to 'string'\n    1 Error(s)\n" },
  { task: "Python Lint (ruff)", cmd: "ruff check .", success: "All checks passed!\n", failure: "a.py:3:5: F401 [*] `os` imported but unused\nFound 2 errors.\n" },
  { task: "Python Lint (flake8)", cmd: "flake8 src/", success: "(quiet)", failure: "src/a.py:3:1: F401 'os' imported but unused\n" },
];

function verdict(entry, successCompressed, failureDetected, carrier, quiet, successText) {
  if (entry === null) return "GAP(entry)";
  // 失败诊断路 = carrier 资格（carrier contract 以 original_exit_code 为锚，
  // 不依赖 terminal 输出识别器）。
  const failureOk = carrier === true;
  // 成功压缩只需在有体量的输出上成立；静默/极小输出（<=200c）Native 即正确。
  const successOk =
    quiet || Boolean(successCompressed) || String(successText || "").length <= 200;
  if (failureOk && successOk) return "FULL COVERED";
  if (failureOk) return "PARTIAL(failure-only)";
  if (successOk) return "PARTIAL(success-only)";
  return "ENTRY-ONLY(输出识别盲)";
}

const rows = [];
for (const m of MATRIX) {
  const entry = classifyCommand(m.cmd);
  const quiet = m.success === "(quiet)";
  const successRes = entry && !quiet ? terminal.tryCompressSuccessTerminal({ toolName: "run_shell_command", command: m.cmd, text: m.success }) : null;
  const failureDetected = entry ? terminal.detectTerminalState(m.failure, entry) === "failure" : false;
  let carrier = false;
  try { carrier = isAutoCarrierEligible({ toolName: "Bash", command: m.cmd }).eligible; } catch (_e) {}
  const vd = entry === "test";
  rows.push({
    task: m.task,
    cmd: m.cmd,
    entry: entry || "null",
    terminal_success: quiet ? "quiet(N/A)" : successRes ? `YES(${successRes.length}c)` : "no",
    failure_detected: failureDetected ? "YES" : "no",
    carrier: carrier ? "YES" : "no",
    vd: vd ? "YES" : "no",
    verdict: verdict(entry, successRes, failureDetected, carrier, quiet, m.success),
  });
}

const byVerdict = {};
for (const r of rows) (byVerdict[r.verdict] = byVerdict[r.verdict] || []).push(r.task);

console.log("task".padEnd(26), "cmd".padEnd(20), "entry".padEnd(6), "term?", "fail?", "carr?", "vd?", "verdict");
console.log("-".repeat(120));
for (const r of rows) {
  console.log(r.task.padEnd(26), r.cmd.padEnd(20), String(r.entry).padEnd(6), String(r.terminal_success).padEnd(11), r.failure_detected.padEnd(5), r.carrier.padEnd(5), r.vd.padEnd(4), r.verdict);
}
console.log("\n=== 汇总 ===");
for (const [v, tasks] of Object.entries(byVerdict)) console.log(`${v}: ${tasks.length} -> ${tasks.join(", ")}`);
const covered = rows.filter((r) => r.verdict === "FULL COVERED").length;
console.log(`\n覆盖率: ${covered}/${rows.length} FULL COVERED（入口+失败诊断+成功压缩三路全通；quiet 成功 = 无可压缩，Native 正确）`);
console.log("VD 现状: 仅 test-kind 有 delta 资格——所有 build/check 类重复验证（save→tsc 循环等高频场景）无 delta。");
