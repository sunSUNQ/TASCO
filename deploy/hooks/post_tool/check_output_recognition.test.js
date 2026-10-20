"use strict";

// ============================================================================
// check_output_recognition.test.js — Line-7 B 阶段：输出语义识别分家族资格化
// ============================================================================
// B1 Rust/Cargo、B2 .NET、B3 Go、B4 Lint/TypeCheck。每组独立验证
// positive / negative / malformed / success / failure / 压缩形态。
// 铁律：失败输出永不压缩；静默成功 Native 正确；malformed → unknown → Native。
// 运行：node --test deploy/hooks/post_tool/check_output_recognition.test.js
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectTerminalState,
  tryCompressSuccessTerminal,
} = require("./terminal_state.js");

function compress(command, text, kind) {
  return tryCompressSuccessTerminal({
    toolName: "run_shell_command",
    command,
    text,
  });
}

// ---------------------------------------------------------------- B1 Rust / Cargo

test("B1 cargo: success recognized (Finished ... target(s) in); tiny success correctly not compressed (no saving)", () => {
  const text = [
    "    Compiling serde v1.0.0",
    "    Compiling tokio v1.0.0",
    "    Checking repo v0.1.0",
    "    Finished dev [unoptimized + debuginfo] target(s) in 1.23s",
  ].join("\n");
  assert.equal(detectTerminalState(text, "check"), "success");
  assert.equal(detectTerminalState(text, "build"), "success"); // cargo build 同形
  // 4 行小输出：压缩信封 >= 原文 → 无节省 → null（Terminal 保守不介入，
  // 与 test/build 域的 no-saving 语义一致）。
  assert.equal(compress("cargo check", text), null);
  // 大样本（真实 cargo check 体量）：process 行省略 + Finished/warnings 保留。
  const big = text + "\n" + Array.from({ length: 40 }, (_, i) => `    Checking dependency-${i} v1.0.0`).join("\n");
  const out = compress("cargo check", big);
  assert.ok(out, "large success compressed");
  assert.match(out, /kind=check/);
  assert.match(out, /Finished dev \[unoptimized \+ debuginfo\] target\(s\) in 1\.23s/);
  assert.match(out, /omitted_process_lines=\d+/);
  assert.ok(!out.includes("Compiling serde"), "process lines omitted");
});

test("B1 cargo: warnings kept verbatim in successful output", () => {
  const lines = ["    Checking repo v0.1.0"];
  for (let i = 0; i < 30; i++) lines.push(`    Checking dependency-${i} v1.0.0`);
  lines.push(
    "warning: unused variable: `x`",
    " --> src/main.rs:3:9",
    "    Finished dev [unoptimized + debuginfo] target(s) in 2.10s"
  );
  const text = lines.join("\n");
  const out = compress("cargo clippy", text);
  assert.ok(out, "compressed (sample large enough to save)");
  assert.ok(out.includes("warning: unused variable: `x`"), "warning verbatim");
  assert.ok(out.includes(" --> src/main.rs:3:9"), "warning context kept (conservative)");
  assert.ok(!out.includes("dependency-1 "), "Checking process lines omitted");
});

test("B1 cargo: failure never compressed; error[E0308] precise failure shape", () => {
  const text = [
    "error[E0308]: mismatched types",
    " --> src/main.rs:3:5",
    "error: could not compile `repo` due to 1 previous error",
  ].join("\n");
  assert.equal(detectTerminalState(text, "check"), "failure");
  assert.equal(compress("cargo check", text), null, "failure not compressed");
});

test("B1 cargo: malformed success marker (Finished without target(s) in) -> unknown", () => {
  assert.equal(detectTerminalState("Finished", "check"), "unknown");
  assert.equal(detectTerminalState("Finished something unrelated happened", "check"), "unknown");
});

// ---------------------------------------------------------------- B2 .NET

test("B2 dotnet: Build succeeded recognized; Build FAILED is precise failure", () => {
  const ok = "Build succeeded.\n    0 Warning(s)\n    0 Error(s)\n";
  assert.equal(detectTerminalState(ok, "build"), "success");
  const bad = "Build FAILED.\n\na.cs(3,5): error CS0029: Cannot implicitly convert type 'int' to 'string'\n    1 Error(s)\n";
  assert.equal(detectTerminalState(bad, "build"), "failure");
  assert.equal(compress("dotnet build", bad), null, "failure not compressed");
});

test("B2 dotnet: '0 Errors(s)' counts never count as failure (zero-count rule)", () => {
  const ok = "Build succeeded.\n    2 Warning(s)\n    0 Error(s)\n";
  assert.equal(detectTerminalState(ok, "build"), "success");
});

// ---------------------------------------------------------------- B3 Go

test("B3 go: quiet success stays unknown -> Native (correct, nothing to compress)", () => {
  assert.equal(detectTerminalState("", "build"), "unknown");
});

test("B3 go: compile diagnostic shape (file.go:line:col:) is precise failure", () => {
  const bad = "# repo/pkg\n./a.go:3:5: cannot use x (type int) as type string\n";
  assert.equal(detectTerminalState(bad, "build"), "failure");
  assert.equal(detectTerminalState(bad, "check"), "failure"); // go vet 同形
  assert.equal(compress("go build ./...", bad), null, "failure not compressed");
});

test("B3 go: malformed (# pkg header alone) -> unknown", () => {
  assert.equal(detectTerminalState("# repo/pkg\n", "build"), "unknown");
});

// ---------------------------------------------------------------- B4 Lint / TypeCheck

test("B4 mypy: success summary recognized; failure via Found N errors", () => {
  const ok = "Success: no issues found in 42 source files\n";
  assert.equal(detectTerminalState(ok, "check"), "success");
  const bad = 'src/a.py:3: error: Incompatible types [assignment]\nFound 1 error in 1 file (checked 42 source files)\n';
  assert.equal(detectTerminalState(bad, "check"), "failure");
  assert.equal(compress("mypy src/", ok), null, "tiny success: no saving -> native (correct)");
});

test("B4 ruff: All checks passed! recognized; Found N errors failure", () => {
  assert.equal(detectTerminalState("All checks passed!\n", "check"), "success");
  const bad = "a.py:3:5: F401 [*] `os` imported but unused\nFound 2 errors.\n";
  assert.equal(detectTerminalState(bad, "check"), "failure");
});

test("B4 pyright: 0 errors, 0 warnings summary recognized; singular error counts as failure", () => {
  assert.equal(detectTerminalState("0 errors, 0 warnings, 0 informations\n", "check"), "success");
  const bad = 'src/a.py:3:5 - error: Type "int" is not assignable to "str"\n1 error, 0 warnings, 0 informations\n';
  assert.equal(detectTerminalState(bad, "check"), "failure");
});

test("B4 eslint: N problems failure shape; success stays quiet-native", () => {
  const bad = "/repo/src/a.js\n  3:5  error  'x' is defined but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)\n";
  assert.equal(detectTerminalState(bad, "check"), "failure");
  assert.equal(detectTerminalState("", "check"), "unknown");
});

test("B4 tsc: error TS diagnostics failure; quiet success native", () => {
  const bad = "src/a.ts(3,5): error TS2322: Type 'number' is not assignable to type 'string'.\nFound 1 error.\n";
  assert.equal(detectTerminalState(bad, "build"), "failure");
  assert.equal(detectTerminalState("", "build"), "unknown");
});

// ---------------------------------------------------------------- 跨家族负例

test("cross-family negative: ordinary prose containing 'Finished' outside cargo shape stays unknown", () => {
  assert.equal(detectTerminalState("We finished reviewing the docs.\n", "check"), "unknown");
});

test("cross-family: failure evidence dominates even when a success marker is present", () => {
  const text = "Success: no issues found in 42 source files\nTraceback (most recent call last):\n";
  assert.equal(detectTerminalState(text, "check"), "failure");
});
