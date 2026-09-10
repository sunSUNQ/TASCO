// ============================================================================
// post_tool/terminal_state.js — P0 Terminal-State Success Compression
// ============================================================================
// 实验期 primitive（Lab 阶段）：CODE_GUARD_TERMINAL_STATE=1 时由
// post_tool_policy_hook.js 在 run_shell_command 分支启用；默认关闭
// （默认 Native 原则）。
//
// 只处理「明确成功终态」的 test/build 输出。任何失败证据或无法确定成功
// → 不介入（P0 不混失败）。压缩是纯提取式（extractive）：只做逐行分类与
// 省略，所有保留内容为原文逐行 verbatim，不重述、不改写任何语义内容 ——
// 保留合同见 METRICS-CONTRACT-V1 §7 与
// docs/experiments/workflow-compression/p0-terminal-state-lab/。
//
// 保留：success summary / counts / warning（verbatim）/ skipped·pending
//       case 行 / artifact·path 行 / 未分类行（保守默认保留）。
// 省略：逐 case PASS 行、构建过程行（[built] / building module 等）、
//       纯噪声行（分隔线 / 空白 / 进度点）。
//
// 纯函数、无 I/O：不读 payload 之外的任何状态，observability 与交付路径
// 不受影响。命令判定正则是策略层自有口径（观测层 TEST_RUNNER_RE 在
// observability/metrics_logger.js 独立维护，两者解耦）。
// ============================================================================

"use strict";

// ---------------------------------------------------------------- 命令判定
// 测试运行器命令（与观测层口径同构，但独立维护：策略 eligibility 与
// 观测口径解耦）。
const TEST_COMMAND_RE =
  /\b(npm|yarn|pnpm|bun)\s+(run\s+)?test\b|\b(npx|pnpmx)\s+[\w@./-]*(jest|vitest|mocha|ava|tap)\b|\bpytest\b|\bnode\s+--test\b|\bgo\s+test\b|\bcargo\s+test\b|\b(mvn|mvnw|gradle)\s+(test|verify|check)\b|\b(cargo|make|mix|dotnet|ruby)\s+test\b|\brspec\b|\bvitest\b|\bjest\b/i;

// 构建/类型检查命令。
const BUILD_COMMAND_RE =
  /\bnpm\s+run\s+build\b|\byarn\s+build\b|\bpnpm\s+(run\s+)?build\b|\btsc\b|\bnpx\s+tsc\b|\bwebpack\b|\bvite\s+build\b|\bcargo\s+build\b|\bgo\s+build\b|\bdotnet\s+build\b|\bcmake\s+--build\b|\bmvnw?\s+(package|install|verify)\b|\bgradlew?\s+(build|assemble)\b|\bmake\b/i;

// ---------------------------------------------------------------- 检查命令判定
// Line-7 A 阶段（2026-09-09，Validation Coverage Expansion）：lint/check 工具
// 形态 → 新 kind "check"。A 阶段只做入口识别（"这是一个验证类命令"），不做
// 输出内容判断——check 输出的 success/failure 语义识别属 B 阶段（分家族
// 资格化），因此 detectTerminalState(kind="check") 在 A 阶段不新增任何
// success pattern（成功 → unknown → Terminal 保持 Native，fail-closed）。
//
// 变异守卫：carrier 会把原命令原样重放一次——任何显式修改类 flag（--fix /
// :fix / format）都不算 check（防止重放改写用户代码）。watch 同理排除。
const CHECK_COMMAND_RE =
  /\b(?:npx\s+)?eslint\b|\bnpm\s+run\s+lint\b|\bmypy\b|\bpyright\b|\bruff\s+check\b|\bflake8\b|\bcargo\s+(?:check|clippy)\b|\bgo\s+vet\b|\bninja\b|\b(?:gcc|g\+\+|clang|clang\+\+)\b|\bmvnw?\s+compile\b/i;
const CHECK_MUTATION_RE =
  /--fix\b|:fix\b|\bruff\s+format\b|\bclippy\s+--fix\b|--watch\b|--interactive\b/i;

function classifyCheckCommand(command) {
  const c = String(command || "");
  if (!CHECK_COMMAND_RE.test(c)) return false;
  if (CHECK_MUTATION_RE.test(c)) return false;
  return true;
}

// ---------------------------------------------------------------- 终态判定
// 失败证据（任意命中 → failure，绝不压缩）。刻意结构化：非零计数、行首
// error、异常类、退出码等；"0 failed" / "0 errors" / "fail 0" 不算失败，
// warning / deprecation 行不算失败。
const FAILURE_PATTERNS = [
  /(?:^|\s)([1-9]\d*)\s+failed\b/, // "1 failed" / "12 failed, 3 passed"；排除 "0 failed"
  /\bfailed[:\s=]+\s*"?[1-9]\d*/i, // "failed: 2" / "failed=2"
  /\b([1-9]\d*)\s+failing\b/i, // mocha "2 failing"
  // 失败计数必须带 summary/error-report 上下文（line-shape evidence），不
  // 接受裸 "N error(s)" 双 token —— 用例名如 "(415 error)" / "returns 400
  // error" / "handles 2 errors correctly" 会误命中（真实生态 FP，由 P0 A/B
  // exposure probe 在 fastify/node:test 全量套件上暴露；cf. Lab R1 §3 同一
  // 原则：行形状优先于词匹配）。覆盖形态：
  //   "Found 2 errors" / "2 errors found" / "1 error generated"（clang）
  //   "Errors: 2" / "errors: 2" 由下一条 [:\s=] 规则覆盖
  //   "error count: 2"、"2 errors in 1.23s"（pytest 汇总 timing）、
  //   eslint "2 errors, 1 warning"（逗号配对）
  // 裸 "N error" 若在 P1 Failure Diagnostic 冻结 fixture 中成为真实形态，
  // 由 P1 contract 重新锁定，不在此处放宽。
  /\b(?:found|generated|reported)\s+([1-9]\d*)\s+errors?\b/i, // "Found 2 errors"
  /\b([1-9]\d*)\s+errors?\s+(?:found|generated|reported)\b/i, // "2 errors found" / "1 error generated"
  /\berror\s+count\s*[:=]?\s*"?([1-9]\d*)\b/i, // "error count: 2"
  /\b([1-9]\d*)\s+errors?\s+in\s+[\d.]+\s*s\b/i, // pytest "2 errors in 1.23s"
  /\b([1-9]\d*)\s+errors?\s*,\s*\d+\s+warnings?\b/i, // eslint "2 errors, 1 warning"
  /\berrors?[:\s=]+\s*"?[1-9]\d*/i, // "errors: 1"
  /^error(?::|\s)/mi, // 行首 error TS1234 / Error: ...
  /\berror\s+TS\d+/i, // 行中 tsc 诊断 "src/x.js:12:5 - error TS2304: ..."
  /\b(assertionerror|typeerror|valueerror|importerror|modulenotfounderror|syntaxerror|referenceerror|rangeerror|keyerror|nameerror|attributeerror)\b/i,
  /\btraceback\s*\(/i,
  /\buncaught\b/i,
  /\bfatal(?::|\s+error)/i,
  /\bnpm\s+err!/i,
  /\bFAILED\b/, // pytest case FAILED（大写，避免误伤含 "failed" 的用例名）
  /\bnot\s+ok\b/i, // tap 失败 case
  /\bfailures?=\s*"?([1-9]\d*)/i, // junit xml failures=2
  /\bexit\s+(?:status|code)\s+([1-9]\d*)/i,
  /\bexited\s+with\s+(?:code|status)\s+([1-9]\d*)/i,
  /\bcommand\s+failed\b/i,
  /\bno\s+such\s+file\s+or\s+directory\b/i,
  /\bcannot\s+find\s+module\b/i,
  /\bpermission\s+denied\b/i,
  // Line-7 B 阶段（分家族输出识别）失败形态补充——均为精确工程形态：
  /\bBuild\s+FAILED\b/i, // dotnet
  /\berror\[E\d+\]/i, // rustc "error[E0308]"
  /\bninja:\s+build\s+stopped\b/i, // ninja 失败汇总
  /\bCOMPILATION\s+ERROR\b/i, // maven
  /\bBuild\s+failed\b/i, // gradle/Dotnet 变体（区分于成功 "Build succeeded"）
  /\b\S+\.go:\d+:\d+:\s/i, // go compile/vet 诊断 "a.go:3:5: cannot use ..."
];

// 测试成功证据（kind=test）。任一命中 + 无失败证据 → success。
const TEST_SUCCESS_PATTERNS = [
  /\b\d+\s+pass(?:ed|ing)\b/, // "130 passed" pytest/jest / "110 passing" mocha
  /\ball\s+tests\s+passed\b/i,
  /\btests\s+passed\b/i,
  /\b100%\s+tests\s+passed\b/i, // ctest
  /#\s*ok\b/i, // tap
  /^OK$/mi, // python unittest
  /#\s*pass\s+\d+\b/i, // node:test "# pass 128"（行首 "# pass"，# 前不能有 \b）
];

// 构建成功证据（kind=build）。
const CARGO_FINISHED_RE =
  /^\s*Finished\b[^\n]*\btarget\(s\)\s+in\b/mi; // cargo "Finished dev ... target(s) in 1.23s"
const BUILD_SUCCESS_PATTERNS = [
  /\bcompiled\s+successfully\b/i, // webpack
  /\bsuccessfully\s+built\b/i, // npm / gcc
  /\bbuilt\s+in\s+[\d.]+\s*s\b/i, // vite "✓ built in 12.84s"
  /\bdone\s+in\s+[\d.]+\s*s\b/i, // rollup / astro
  /\bbuild\s+complete\b/i,
  /\bbuild\s+succeeded\b/i,
  // Line-7 B 阶段补充（精确工程形态）：
  /\bBUILD\s+SUCCESS\b/, // maven（全大写固定形态）
  /\bbuild\s+finished\b/i, // cmake --build 尾行
  /\bbuilt\s+target\b/i, // cmake "Built target app"
  CARGO_FINISHED_RE, // cargo build 成功与 check 同形
];

// Line-7 B 阶段：check 类工具的成功证据（kind=check，按 B1-B4 家族冻结）。
// 全部行锚定精确形态，避免跨工具 FP；静默成功（无输出）不含任何 pattern，
// detect → unknown → Native（正确：无可压缩）。
const CHECK_SUCCESS_PATTERNS = [
  CARGO_FINISHED_RE, // cargo check / clippy
  /^\s*Success:\s+no\s+issues\s+found\b/mi, // mypy
  /^All\s+checks\s+passed!/i, // ruff
  /^\d+\s+errors?,\s+\d+\s+warnings?,\s+\d+\s+informations\b/i, // pyright（0 errors, 0 warnings, 0 informations）
];

function classifyCommand(command) {
  const c = String(command || "");
  if (TEST_COMMAND_RE.test(c)) return "test";
  if (BUILD_COMMAND_RE.test(c)) return "build";
  if (classifyCheckCommand(c)) return "check";
  return null;
}

function detectTerminalState(text, kind) {
  const t = String(text || "");
  for (const re of FAILURE_PATTERNS) {
    if (re.test(t)) return "failure";
  }
  // kind="check"（Line-7 B 阶段）：CHECK_SUCCESS_PATTERNS ∪ BUILD_SUCCESS_
  // PATTERNS（check 工具族含构建型工具 ninja/mvn，构建 summary 同样适用）。
  // 全部行锚定精确形态；静默成功不含任何 pattern → unknown → Native。
  let patterns;
  if (kind === "check") {
    patterns = [...CHECK_SUCCESS_PATTERNS, ...BUILD_SUCCESS_PATTERNS];
  } else if (kind === "test") {
    patterns = TEST_SUCCESS_PATTERNS;
  } else {
    patterns = BUILD_SUCCESS_PATTERNS;
  }
  for (const re of patterns) {
    if (re.test(t)) return "success";
  }
  return "unknown";
}

// ---------------------------------------------------------------- 行分类
// 顺序即优先级：warning/summary 先于省略类判定；未命中任何省略类的行
// 一律保留（保守默认：不删比误删好）。

function isWarningLine(line) {
  return (
    /\bwarn(?:ing|ed)?s?\b/i.test(line) || /\bdeprecat(?:ed|ion)\b/i.test(line)
  );
}

function isSummaryLine(line, kind) {
  const s = String(line || "").trim();
  if (kind === "test") {
    return (
      /\b\d+\s+pass(?:ed|ing)\b/.test(s) || // 计数字段（summary）
      /\b\d+\s+(?:failed|failing)\b/.test(s) || // 失败计数（成功终态下不应出现，保守保留）
      /\b\d+\s+skipped\b/i.test(s) ||
      /\b\d+\s+pending\b/i.test(s) ||
      /^test\s+suites?:/i.test(s) ||
      /^tests?:/i.test(s) ||
      /^snapshots?:/i.test(s) ||
      /^time\s*:/i.test(s) ||
      /^ran\s+all\s+test/i.test(s) ||
      /^#\s*(?:tests|pass|fail|skip|todo)\b/i.test(s) ||
      /^ok$/i.test(s) ||
      /^\d+\s+(?:passing|pending|failing)/i.test(s) // mocha 汇总行
    );
  }
  if (kind === "check") {
    // Line-7 B 阶段：check 家族 summary 形态（与 CHECK_SUCCESS_PATTERNS
    // 对应；warning 行已在更早分支 verbatim 保留，不在此重复）。
    return (
      /^\s*Finished\b/i.test(s) || // cargo
      /^\s*Success:\s+no\s+issues\s+found\b/i.test(s) || // mypy
      /^All\s+checks\s+passed!/i.test(s) || // ruff
      /^\d+\s+errors?,\s+\d+\s+warnings?,\s+\d+\s+informations\b/i.test(s) // pyright
    );
  }
  return (
    /\bcompiled\s+successfully\b/i.test(s) ||
    /\bsuccessfully\s+built\b/i.test(s) ||
    /\bbuilt\s+in\s+[\d.]+\s*s\b/i.test(s) ||
    /\bdone\s+in\s+[\d.]+\s*s\b/i.test(s) ||
    /\bBUILD\s+SUCCESS\b/.test(s) ||
    /\bbuild\s+finished\b/i.test(s) ||
    /\bbuilt\s+target\b/i.test(s)
  );
}

function isSkippedCaseLine(line) {
  const s = String(line || "").trim();
  return (
    /^[○◌]/.test(s) || // jest skipped
    /^\s*-\s+\S/.test(s) || // mocha pending 项目符号
    /\bSKIPPED\b/.test(s) || // pytest case SKIPPED
    /^#\s*skip\b/i.test(s) // node:test / tap
  );
  // 注意:不做 \bskipped\b / \bpending\b 词匹配 —— 用例名(如 "with pending
  // payment"、"handles skipped item")会误命中,行形状才是可靠信号。
}

// 构建过程行（可省略）：webpack 模块行、模块构建进度、编译步骤行。
// 必须在 artifact 判定之前检查 —— [built] ./src/foo.js 不是最终产物。
// Line-7 B 阶段：cargo/maven 编译过程行仅对 cargo/mvn 家族命令启用
// （extendedProcess=true）——历史 test/build 压缩行为逐字节不退化。
function isBuildProcessLine(line, extendedProcess) {
  const s = String(line || "").trim();
  if (
    /\[(?:built|emitted|cached)\]/.test(s) || // webpack 每模块行
    /\bbuilding\s+module\b/i.test(s) ||
    /^\[\d+\/\d+\]/.test(s) || // 进度计数（ninja/cmake/mvn module 行）
    /^(?:gcc|clang|cc|c\+\+|g\+\+)\s+\S.*\s-(?:c|o|s)\b/.test(s) // 编译步骤
  ) {
    return true;
  }
  if (!extendedProcess) return false;
  return (
    /^\s*(?:Compiling|Checking|Downloaded|Downloading|Locking|Updating|Adding|Removing)\s+\S/i.test(s) ||
    /^\[INFO\]\s+(?:Compiling|Building)\s/i.test(s)
  );
}

function isArtifactLine(line) {
  const s = String(line || "").trim();
  return (
    /\bdist\//i.test(s) ||
    /\b(?:out|build|lib|public|assets?|target)\//i.test(s) ||
    /\bgzip\s*:/i.test(s) ||
    /\b\d+(?:\.\d+)?\s*(?:kB|KB|MB|bytes)\b/.test(s) || // 体积行
    /\.(?:js|css|mjs|cjs|map|html|zip|tgz|gz|exe|dll|so|dylib|jar|whl)\b/.test(
      s
    ) ||
    /\bbundle\b/i.test(s)
  );
}

function isPassCaseLine(line) {
  const s = String(line || "").trim();
  return (
    /^[✓✔•]/.test(s) || // jest / mocha / vitest 逐 case 行
    /^(?:ok\s+)?\d+\s*[-)]\s*\S/.test(s) || // tap / node:test "ok 1 - name"
    /::[\w.[\]-]+(?:\[[\w.]+\])?\s+(?:PASSED|OK)\b/.test(s) || // pytest 逐 case
    /\bPASSED\s*\[/.test(s) || // pytest 进度形式
    /\bpass\b\s*\([\d.]+\s*(?:ms|s)\)/i.test(s) // mocha 快速通过行
  );
}

function isNoiseLine(line) {
  const s = String(line || "").trim();
  return (
    s === "" ||
    /^={3,}/.test(s) ||
    /^-{3,}/.test(s) ||
    /^\.{3,}$/.test(s) ||
    /^(?:collecting|gathering)\s*\.{3}/i.test(s)
  );
}

function classifyLine(line, kind, extendedProcess) {
  // test 输出:逐 case 行形状优先 —— 用例名里出现 warning/pending/skipped
  // 等词不算警告/跳过证据(形状才是可靠信号)。
  if (kind === "test" && isPassCaseLine(line)) return "case";
  if (isWarningLine(line)) return "warning";
  if (isSummaryLine(line, kind)) return "summary";
  if (isSkippedCaseLine(line)) return "skipped";
  if ((kind === "build" || kind === "check") && isBuildProcessLine(line, extendedProcess)) {
    return "process";
  }
  if (kind === "build" && isArtifactLine(line)) return "artifact";
  if (isNoiseLine(line)) return "noise";
  return "other"; // 未分类 → 保守保留
}

// ---------------------------------------------------------------- 压缩
const MAX_WARNING_LINES = 60;

function foldCommand(command) {
  return String(command || "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * 提取式压缩成功终态输出。保留行 verbatim；省略行只计数并写入显式
 * omission 元数据（不静默删除）。无法形成节省（候选 >= 原文）时返回 null
 * —— 由调用方保持 native（交付层 output() 的 0.8 守卫为第二道防线）。
 */
function compressSuccessOutput(text, kind, command) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/);
  // Line-7 B 阶段：cargo/mvn 家族命令启用扩展过程行省略；其余命令
  // （含全部历史 test/build 形态）保持冻结行为逐字节不变。
  const extendedProcess = /\b(?:cargo|mvn|mvnw)\b/i.test(String(command || ""));
  const kept = [];
  let omittedCase = 0;
  let omittedCaseChars = 0;
  let omittedProcess = 0;
  let omittedProcessChars = 0;
  let omittedNoise = 0;
  let warningLines = 0;
  let warningOverflow = 0;

  for (const line of lines) {
    switch (classifyLine(line, kind, extendedProcess)) {
      case "warning":
        if (warningLines >= MAX_WARNING_LINES) {
          warningOverflow++;
          break;
        }
        warningLines++;
        kept.push(line);
        break;
      case "case":
        omittedCase++;
        omittedCaseChars += line.length + 1;
        break;
      case "process":
        omittedProcess++;
        omittedProcessChars += line.length + 1;
        break;
      case "noise":
        omittedNoise++;
        break;
      default:
        kept.push(line); // summary / skipped / artifact / other
    }
  }

  const meta = [`omitted_case_lines=${omittedCase} (${omittedCaseChars} chars)`];
  if (omittedProcess > 0) {
    meta.push(
      `omitted_process_lines=${omittedProcess} (${omittedProcessChars} chars)`
    );
  }
  if (omittedNoise > 0) {
    meta.push(`omitted_noise_lines=${omittedNoise}`);
  }
  if (warningOverflow > 0) {
    meta.push(
      `warning_overflow=${warningOverflow} additional warning lines omitted`
    );
  }

  const body = kept.join("\n").trim();
  if (!body) return null;

  const summary = [
    "[TERMINAL_STATE_SUCCESS]",
    "state=success",
    `kind=${kind}`,
    `command=${foldCommand(command)}`,
    ...meta,
  ]
    .join("\n")
    .concat("\n\n", body);

  if (summary.length >= raw.length) return null;
  return summary;
}

/**
 * hook 接线入口：仅当 tool 为 shell、命令是 test/build、终态明确成功、
 * 且候选形成节省时返回压缩文本；否则 null（不介入）。
 */
function tryCompressSuccessTerminal({ toolName, command, text }) {
  if (toolName !== "run_shell_command") return null;
  const kind = classifyCommand(command);
  if (!kind) return null;
  if (detectTerminalState(text, kind) !== "success") return null;
  return compressSuccessOutput(text, kind, command);
}

function createTerminalStateCompressor(_deps) {
  return {
    classifyCommand,
    detectTerminalState,
    compressSuccessOutput,
    tryCompressSuccessTerminal,
  };
}

module.exports = {
  createTerminalStateCompressor,
  classifyCommand,
  classifyCheckCommand,
  detectTerminalState,
  compressSuccessOutput,
  tryCompressSuccessTerminal,
};
