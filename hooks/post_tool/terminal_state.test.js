"use strict";

// ============================================================================
// terminal_state.test.js — P0 Terminal-State Success Compression 单元测试
// 运行:node --test deploy/hooks/post_tool/terminal_state.test.js
// ============================================================================
// 覆盖:
//   1. 命令分类(test/build/非目标)
//   2. 终态判定(success / failure / unknown;零计数不算失败;warning 不算失败)
//   3. 压缩保留(verbatim summary / warning / skipped / artifact;逐 case 省略)
//   4. 不介入(failure 文本、未知终态、非目标命令、无节省)
//   5. warning 上限溢出(显式标记,不静默删除)

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyCommand,
  detectTerminalState,
  compressSuccessOutput,
  tryCompressSuccessTerminal,
} = require("./terminal_state");

// ---------------------------------------------------------------- 命令分类
test("classifyCommand: test runner 命令 → test", () => {
  assert.equal(classifyCommand("npm test"), "test");
  assert.equal(classifyCommand("npx pytest -v"), "test");
  assert.equal(classifyCommand("node --test"), "test");
  assert.equal(classifyCommand("npx jest --runInBand"), "test");
});

test("classifyCommand: build 命令 → build", () => {
  assert.equal(classifyCommand("npm run build"), "build");
  assert.equal(classifyCommand("npx tsc --noEmit"), "build");
  assert.equal(classifyCommand("webpack --config webpack.prod.js"), "build");
  assert.equal(classifyCommand("vite build"), "build");
});

test("classifyCommand: 非目标命令 → null", () => {
  assert.equal(classifyCommand("ls -la"), null);
  assert.equal(classifyCommand("npm install"), null);
  assert.equal(classifyCommand("git status"), null);
  assert.equal(classifyCommand(""), null);
});

// ---------------------------------------------------------------- 终态判定
const PYTEST_SUCCESS = `tests/test_auth.py::test_login_success PASSED [  1%]
tests/test_order.py::test_create_happy_path PASSED [ 50%]
============================== 130 passed in 7.84s ==============================
`;

const PYTEST_FAILURE = `tests/test_order.py::test_refund_negative FAILED
============================== 1 failed, 127 passed in 7.84s ==============================
`;

test("detectTerminalState: pytest 全成功 → success", () => {
  assert.equal(detectTerminalState(PYTEST_SUCCESS, "test"), "success");
});

test("detectTerminalState: pytest 有失败 → failure（优先级高于成功证据）", () => {
  assert.equal(detectTerminalState(PYTEST_FAILURE, "test"), "failure");
});

test("detectTerminalState: 成功输出含 '0 failed' 不算失败", () => {
  const text = `Tests: 128 passed, 0 failed, 2 skipped, 130 total
Time: 12.3s`;
  assert.equal(detectTerminalState(text, "test"), "success");
});

test("detectTerminalState: 成功输出含 0 errors 不算失败", () => {
  const text = `Module resolution complete: 42 modules, 0 errors
✓ built in 12.84s`;
  assert.equal(detectTerminalState(text, "build"), "success");
});

test("detectTerminalState: deprecation warning 不算失败", () => {
  const text = `(node:12345) DeprecationWarning: legacy API deprecated
110 passing (9s)
2 pending`;
  assert.equal(detectTerminalState(text, "test"), "success");
});

test("detectTerminalState: tsc 错误 → failure", () => {
  const text = `src/handlers/order.js:12:5 - error TS2304: Cannot find name 'foo'.`;
  assert.equal(detectTerminalState(text, "build"), "failure");
});

test("detectTerminalState: 非零退出码 → failure", () => {
  assert.equal(
    detectTerminalState("Process exited with code 3\nTests: 1 failed", "test"),
    "failure"
  );
  assert.equal(detectTerminalState("exit status 1", "test"), "failure");
});

test("detectTerminalState: 无明确证据 → unknown", () => {
  assert.equal(detectTerminalState("some random output", "test"), "unknown");
  assert.equal(detectTerminalState("", "test"), "unknown");
});

test("detectTerminalState: 仅有 '0 errors' 无成功证据 → unknown（保守不介入）", () => {
  assert.equal(
    detectTerminalState("Compiled 42 modules, 0 errors", "build"),
    "unknown"
  );
});

// ---------------------------------------------------------------- 失败计数 line-shape 证据
// P0 A/B exposure probe 暴露:裸 "N error(s)" 双 token 被真实测试用例名
// (HTTP 状态码 + error,如 "(415 error)")误命中 → 成功终态大面积判 failure、
// 永不压缩(availability FP;fail-safe 方向)。失败计数必须带 summary /
// error-report 上下文,与 Lab R1 §3 的 warning/skipped 行形状原则一致。

test("detectTerminalState: 用例名含 '(415 error)' 不算失败(真实 node:test 行)", () => {
  const text = `# Subtest: request with body and no content type (415 error) - lock
ok 2 - request with body and no content type (415 error) - lock
# tests 6
# pass 6
# fail 0`;
  assert.equal(detectTerminalState(text, "test"), "success");
});

test("detectTerminalState: 用例名含 'returns 400 error' / 'handles 2 errors correctly' 不算失败", () => {
  const text = `ok 1 - request returns 400 error when invalid
ok 2 - handles 2 errors correctly in a batch
1..2
# tests 2
# pass 2
# fail 0`;
  assert.equal(detectTerminalState(text, "test"), "success");
});

test("detectTerminalState: 'Found 2 errors' → failure(真实错误报告形态)", () => {
  const text = `src/handlers/order.js(12,5): error TS2304: Cannot find name 'foo'.
Found 2 errors.`;
  assert.equal(detectTerminalState(text, "build"), "failure");
});

test("detectTerminalState: '2 errors found' → failure", () => {
  assert.equal(
    detectTerminalState("Validation failed: 2 errors found", "build"),
    "failure"
  );
});

test("detectTerminalState: 'Errors: 2' / 'error count: 2' → failure", () => {
  assert.equal(detectTerminalState("Errors: 2", "test"), "failure");
  assert.equal(detectTerminalState("error count: 2", "test"), "failure");
});

test("detectTerminalState: clang '1 error generated' → failure", () => {
  assert.equal(
    detectTerminalState("main.c:3:9: error: undeclared\n1 error generated.", "build"),
    "failure"
  );
});

test("detectTerminalState: pytest errors-only 汇总 '2 errors in 1.23s' → failure", () => {
  assert.equal(
    detectTerminalState("======== 2 errors in 1.23s ========", "test"),
    "failure"
  );
});

test("detectTerminalState: eslint '2 errors, 1 warning' → failure", () => {
  assert.equal(
    detectTerminalState("✖ 2 problems (2 errors, 1 warning)", "test"),
    "failure"
  );
});

// ---------------------------------------------------------------- 压缩保留
const T1_TEXT = `============================= test session starts ==============================
platform win32 -- Python 3.12.4, pytest-8.2.2, pluggy-1.5.0
rootdir: D:\\ecor_pilot_repos\\mini-svc
collected 210 items

tests/test_auth.py::test_login_success PASSED [  0%]
tests/test_auth.py::test_login_wrong_password PASSED [  1%]
tests/test_auth.py::test_token_refresh_success PASSED [  2%]
tests/test_order.py::test_create_happy_path PASSED [ 98%]
tests/test_order.py::test_cancel_conflict PASSED [ 99%]
tests/test_order.py::test_refund_happy_path PASSED [100%]

============================== 210 passed in 7.84s ==============================
`;

test("compressSuccessOutput: summary verbatim 保留,逐 case 省略,标记存在", () => {
  const out = compressSuccessOutput(T1_TEXT, "test", "npx pytest -v");
  assert.ok(out, "应产生压缩结果");
  assert.ok(
    out.includes("============================== 210 passed in 7.84s =============================="),
    "summary 行 verbatim 保留"
  );
  assert.ok(out.includes("[TERMINAL_STATE_SUCCESS]"), "分类标记存在");
  assert.ok(out.includes("state=success"), "成功状态显式声明");
  assert.ok(out.includes("omitted_case_lines=6"), "省略元数据显式计数");
  assert.ok(!out.includes("test_login_success PASSED"), "逐 case 行被省略");
  assert.ok(out.includes("collected 210 items"), "未分类信息行保守保留");
  assert.ok(out.length < T1_TEXT.length, "压缩后更短");
});

const T2_TEXT = `PASS src/__tests__/order.test.js (9.1 s)
${Array.from(
  { length: 60 },
  (_, i) => `  ✓ order case ${i} (${(i * 7) % 40 + 3} ms)`
).join("\n")}
  ○ skipped legacy export format (deprecated, enabled via flag)

Test Suites: 3 passed, 3 total
Tests:       126 passed, 2 skipped, 128 total
Time:        14.2 s
Ran all test suites.
`;

test("compressSuccessOutput: skipped case 与 warning 语义保留", () => {
  const out = compressSuccessOutput(T2_TEXT, "test", "npm test");
  assert.ok(out, "应产生压缩结果");
  assert.ok(out.includes("Tests:       126 passed, 2 skipped, 128 total"));
  assert.ok(out.includes("○ skipped legacy export format"));
  assert.ok(out.includes("Ran all test suites."));
  assert.ok(!out.includes("✓ creates order"), "通过 case 行被省略");
});

const B1_TEXT = `> mini-svc@1.0.0 build
> tsc && node scripts/bundle.js

Compiling TypeScript sources...
Module resolution complete: 42 modules, 0 errors
${Array.from(
  { length: 45 },
  (_, i) => `building module ${i + 1}/45: src/modules/module_${String(i).padStart(2, "0")}.js`
).join("\n")}
✓ built in 12.84s
dist/app.js      1.24 MB │ gzip: 342.11 kB
dist/app.css     86.4 kB │ gzip: 21.9 kB
`;

test("compressSuccessOutput: build 过程行省略,artifact 保留", () => {
  const out = compressSuccessOutput(B1_TEXT, "build", "npm run build");
  assert.ok(out, "应产生压缩结果");
  assert.ok(out.includes("✓ built in 12.84s"), "构建成功行保留");
  assert.ok(out.includes("dist/app.js"), "artifact 行保留");
  assert.ok(out.includes("0 errors"), "零错误行保留");
  assert.ok(!out.includes("building module 1/45"), "构建过程行省略");
  assert.ok(out.includes("omitted_process_lines=45"));
});

const B2_TEXT = `WARNING in ./src/legacy/mod.js 12:3
Critical dependency: the request of a dependency is an expression

WARNING in entrypoint size limit: The following entrypoint(s) combined asset volume exceeds the recommended limit.

${Array.from(
  { length: 40 },
  (_, i) => ` [built] ./src/modules/module_${String(i).padStart(2, "0")}.js 1.24 KiB {3} [built]`
).join("\n")}
webpack 5.88.2 compiled successfully in 3.41s

dist/main.js    342 kB │ gzip: 98.3 kB
dist/vendor.js  1.1 MB │ gzip: 300.4 kB
`;

test("compressSuccessOutput: warning verbatim 保留(含 [built] 过程行省略)", () => {
  const out = compressSuccessOutput(B2_TEXT, "build", "npx webpack");
  assert.ok(out, "应产生压缩结果");
  assert.ok(out.includes("WARNING in ./src/legacy/mod.js 12:3"));
  assert.ok(out.includes("WARNING in entrypoint size limit"));
  assert.ok(out.includes("webpack 5.88.2 compiled successfully in 3.41s"));
  assert.ok(out.includes("dist/main.js"));
  assert.ok(!out.includes("[built]"), "[built] 模块行省略");
  assert.ok(out.includes("omitted_process_lines=40"), "过程行省略计数");
});

test("compressSuccessOutput: warning 超上限 → 显式标记,不静默删除", () => {
  const warnings = Array.from(
    { length: 70 },
    (_, i) => `(node:1) DeprecationWarning: api ${i} is deprecated`
  );
  const text = [...warnings, "110 passing (9s)"].join("\n");
  const out = compressSuccessOutput(text, "test", "npx mocha");
  assert.ok(out, "应产生压缩结果");
  assert.ok(out.includes("warning_overflow=10"), "溢出显式标记");
  assert.ok(out.includes("api 0 is deprecated"), "首条 warning 保留");
  assert.ok(out.includes("110 passing (9s)"), "summary 保留");
});

test("compressSuccessOutput: 用例名含 pending/skipped/warning 词汇不被误保留", () => {
  const text = [
    "  OrderService",
    "    ✓ creates order with pending payment (2ms)",
    "    ✓ handles skipped item gracefully (3ms)",
    "    ✓ shows warning banner (4ms)",
    "    - legacy export format",
    "  3 passing (5s)",
    "  1 pending",
  ].join("\n");
  const out = compressSuccessOutput(text, "test", "npx mocha");
  assert.ok(out, "应产生压缩结果");
  assert.ok(!out.includes("with pending payment"), "业务词汇不被误判为 pending 标记");
  assert.ok(!out.includes("handles skipped item"), "业务词汇不被误判为 skipped 标记");
  assert.ok(!out.includes("shows warning banner"), "用例名不被误判为 warning 行");
  assert.ok(out.includes("- legacy export format"), "mocha pending 项目符号行保留");
  assert.ok(out.includes("1 pending"), "pending 计数 summary 保留");
  assert.ok(out.includes("3 passing (5s)"), "summary 保留");
});

test("compressSuccessOutput: 无节省(纯空白/纯噪声)→ null", () => {
  assert.equal(compressSuccessOutput("   \n\n", "test", "npm test"), null);
});

// ---------------------------------------------------------------- 不介入
test("tryCompressSuccessTerminal: 非 shell 工具 → null", () => {
  assert.equal(
    tryCompressSuccessTerminal({
      toolName: "read_file",
      command: "",
      text: PYTEST_SUCCESS,
    }),
    null
  );
});

test("tryCompressSuccessTerminal: 非 test/build 命令 → null", () => {
  assert.equal(
    tryCompressSuccessTerminal({
      toolName: "run_shell_command",
      command: "ls -la",
      text: PYTEST_SUCCESS,
    }),
    null
  );
});

test("tryCompressSuccessTerminal: 失败终态 → null（P0 不混失败）", () => {
  assert.equal(
    tryCompressSuccessTerminal({
      toolName: "run_shell_command",
      command: "npx pytest -v",
      text: PYTEST_FAILURE,
    }),
    null
  );
});

test("tryCompressSuccessTerminal: 未知终态 → null", () => {
  assert.equal(
    tryCompressSuccessTerminal({
      toolName: "run_shell_command",
      command: "npm test",
      text: "no recognizable summary here",
    }),
    null
  );
});

test("tryCompressSuccessTerminal: 成功终态 → 压缩文本", () => {
  const out = tryCompressSuccessTerminal({
    toolName: "run_shell_command",
    command: "npx pytest -v",
    text: T1_TEXT,
  });
  assert.ok(out && out.includes("[TERMINAL_STATE_SUCCESS]"));
});
