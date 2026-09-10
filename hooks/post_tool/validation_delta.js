// ============================================================================
// post_tool/validation_delta.js — P2 Validation Delta Compression primitive
// ============================================================================
// v0.5 M3 AUTO 接入：与 terminal_state.js 相同的纯函数风格（无 I/O）。跨调用
// 的 previous-run 状态由调用方（claude_bridge）读写并传入，本模块不做任何
// 文件访问。
//
// 正区（用户 2026-09-07 拍板 + A0 Contract §4）：kind=test 的 validation
// 输出，当前 run 必须判为明确成功（复用 terminal_state.detectTerminalState），
// 且存在同 command 可比较的上一轮 fingerprint。失败 current 不产生 VD
// （留给 P1 Failure Diagnostic）；previous 可为成功或失败。
//
// delta 是重写式报告（非 extractive）：相对上一轮的状态变化 + 当前 counts。
// 它取代整个 rerun 输出 —— 逐 case PASS 详情上一轮已存在，无需重传。
// preservation contract 见 docs/architecture/VALIDATION-DELTA-CONTRACT-V1.md：
//   - previous 缺失 / 不可比（fingerprint.ok=false）→ null，不得伪造 delta
//   - previous 失败 case 名全列或显式 "+M more"，不得静默截断
//   - 零变化确认必须可辨识（success_unchanged mode）
//   - 非 test command / 非 success current / 长度护栏不过 → null（native /
//     terminal 维持现状）
// ============================================================================

"use strict";

const { classifyCommand, detectTerminalState } = require("./terminal_state");

const MAX_FAILED_NAMES_KEPT = 500; // fingerprint 上限（防御性 cap）
const MAX_FAILED_NAMES_LISTED = 20; // delta 文本中逐名列出上限，超出显式 +M more
const MAX_NAME_LENGTH = 200; // 单 case 名截断，防畸形行膨胀 delta

function foldCommand(command) {
  return String(command || "").replace(/\s+/g, " ").trim().slice(0, 200);
}

// ---------------------------------------------------------------- case parser
// 行形状优先（与 terminal_state 同原则），v1 域 = node:test/tap、jest/vitest、
// pytest、mocha spec。Parser 不识别的行不影响 summary-counts fallback。
const TAP_LINE_RE = /^(ok|not ok)\s+\d+\s*(?:-\s*)?(.+)$/;
const JEST_LINE_RE = /^([✓✔✗✕×])\s+(.+)$/;
const PYTEST_LINE_RE = /::([\w.[\]-]+)\s+\((PASSED|FAILED|SKIPPED)\)|::([\w.[\]-]+)\s+(PASSED|FAILED)\b/;
const MOCHA_FAIL_LIST_RE = /^\d+\)\s+(.+)$/; // spec reporter 失败列表（无 ✓ 前缀）
const MOCHA_PASS_LINE_RE = /^✓\s+(.+)$/; // mocha spec passing case

function cleanName(raw) {
  return String(raw || "")
    .replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)\s*$/, "") // 去掉 (12ms)/(1.23s) 计时后缀
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

function parseCases(text) {
  const cases = []; // { name, state: "pass"|"fail" }
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    let m = TAP_LINE_RE.exec(trimmed);
    if (m) {
      // "not ok 1 -"（无名字）会回溯出 name="-" —— 该形态不算 case
      const name = cleanName(m[2]);
      if (!name || name === "-") continue;
      cases.push({ name, state: m[1] === "not ok" ? "fail" : "pass" });
      continue;
    }
    m = JEST_LINE_RE.exec(trimmed);
    if (m) {
      const fail = m[1] === "✗" || m[1] === "✕" || m[1] === "×";
      cases.push({ name: cleanName(m[2]), state: fail ? "fail" : "pass" });
      continue;
    }
    m = PYTEST_LINE_RE.exec(trimmed);
    if (m) {
      // 括号形态 group1/2；无括号形态 group3/4
      const name = m[1] || m[3];
      const status = m[2] || m[4];
      const state = status === "FAILED" ? "fail" : status === "SKIPPED" ? "skip" : "pass";
      if (state !== "skip") cases.push({ name: cleanName(name), state });
      continue;
    }
    if (/^✓/.test(trimmed)) {
      m = MOCHA_PASS_LINE_RE.exec(trimmed);
      if (m) cases.push({ name: cleanName(m[1]), state: "pass" });
      continue;
    }
    // mocha 失败列表 "1) name" —— 只在失败摘要段出现；误判风险低（形状窄）
    if (/^\d+\)\s+\S/.test(trimmed) && !/^\d+\)\s+[A-Za-z]+(?:ing|ed)/.test(trimmed)) {
      // 排除 "1 failing" 汇总行形态之外的计数组装行
      m = MOCHA_FAIL_LIST_RE.exec(trimmed);
      if (m) cases.push({ name: cleanName(m[1]), state: "fail" });
    }
  }
  return cases;
}

// ---------------------------------------------------------------- counts
// 从 summary 行提取 pass/fail/skip 计数；任一行命中即返回（tail summary 最
// 权威）。返回 null = 提取失败（run 不可比，fingerprint.ok=false）。
const COUNT_PATTERNS = [
  // node:test TAP tail
  { re: /^#\s*pass\s+(\d+)/m, key: "pass" },
  { re: /^#\s*fail\s+(\d+)/m, key: "fail" },
  { re: /^#\s*skipped\s+(\d+)/m, key: "skip" },
  { re: /^#\s*todo\s+(\d+)/m, key: "todo" },
  // jest / mocha / vitest / pytest
  { re: /\b(\d+)\s+pass(?:ed|ing)\b/i, key: "pass" },
  { re: /\b(\d+)\s+fail(?:ed|ing)\b/i, key: "fail" },
  { re: /\b(\d+)\s+skipped\b/i, key: "skip" },
  { re: /\b(\d+)\s+pending\b/i, key: "skip" },
  // Line-7 C 阶段：check 家族计数（pyright "0 errors, 0 warnings"、
  // mypy "Found 1 error" 等）；test 输出中的 errors/warnings 键不参与
  // test 的 countsLine（pass/fail/skip 主导），行为不变。
  { re: /\b(\d+)\s+errors?\b/i, key: "errors" },
  { re: /\b(\d+)\s+warnings?\b/i, key: "warnings" },
];
const COUNT_PRIORITY = ["pass", "fail", "skip", "todo"];

function extractCounts(text) {
  const counts = {};
  let found = false;
  // last-match 语义：node:test 嵌套 describe 会在块尾重复打印 "# pass N"，
  // 文末 top-level "# tests/# pass/# fail" 才是权威总数（最后出现）。
  for (const { re, key } of COUNT_PATTERNS) {
    const haystack = String(text || "");
    const g = new RegExp(re.source, `${re.flags.includes("g") ? "" : "g"}${re.flags}`);
    let last = null;
    let m = g.exec(haystack);
    while (m) {
      last = m;
      m = g.exec(haystack);
    }
    if (last) {
      found = true;
      counts[key] = Number(last[1]);
    }
  }
  for (const key of COUNT_PRIORITY) if (counts[key] === undefined) counts[key] = 0;
  return found ? counts : null;
}

// ---------------------------------------------------------------- fingerprint
function buildFingerprint({ command, text, at }) {
  // Line-7 C 阶段：fingerprint 变 kind-aware（test/build/check 三类验证命令
  // 均可比较）。test 类保持 v1 语义逐字节不变（ok 仍要求 counts 完整）；
  // build/check 类为 state-level 可比（静默/summary 成功也算可比基线）。
  const kind = classifyCommand(command) || "test";
  const state = detectTerminalState(String(text || ""), kind);
  if (state === "unknown") return null; // truncated / 无终态 → 不可比
  const counts = extractCounts(text);
  const cases = parseCases(text);
  const failedNames = cases.filter((c) => c.state === "fail").map((c) => c.name);
  const passedCount = cases.filter((c) => c.state === "pass").length;
  const countsAvailable = Boolean(counts);
  return {
    ok: countsAvailable || kind !== "test",
    countsAvailable,
    kind,
    state,
    command: foldCommand(command),
    at: String(at || new Date().toISOString()),
    counts: counts || { pass: 0, fail: 0, skip: 0, todo: 0 },
    caseCount: cases.length,
    passedCount,
    failedNames: failedNames.slice(0, MAX_FAILED_NAMES_KEPT),
  };
}

function sameCommand(previous, command) {
  return previous && previous.command === foldCommand(command);
}

// ---------------------------------------------------------------- delta
function listNames(names) {
  if (names.length === 0) return "";
  const head = names.slice(0, MAX_FAILED_NAMES_LISTED).map((n) => `- ${n}`).join("\n");
  const rest = names.length - MAX_FAILED_NAMES_LISTED;
  return rest > 0 ? `${head}\n+_and_${rest}_more` : head;
}

function countsLine(counts) {
  return `counts: pass=${counts.pass} fail=${counts.fail} skip=${counts.skip}${
    counts.todo ? ` todo=${counts.todo}` : ""
  }`;
}

/**
 * 构造 validation delta（重写式报告）。前置不满足 / 无法形成节省 → null。
 * 返回 { deltaText, mode, previous }。
 *
 * Line-7 C 阶段：正区从 test 扩展为 test + build + check。
 *   - test：v1 语义逐字节不变（counts/case 比对，三 mode 全量）；
 *   - build/check：state-level 比对（success_unchanged /
 *     failure_to_success_resolution）；counts_changed 仍为 test-only
 *     （build/check 无可靠 counts parser 前，不做计数级比较）。
 */
function tryCompressValidationDelta({ command, text, previous }) {
  const kind = classifyCommand(command);
  if (!kind) return null; // 非验证命令 → Native（v1 边界保持）
  if (detectTerminalState(String(text || ""), kind) !== "success") return null; // success-current 域
  if (!sameCommand(previous, command)) return null; // 无可比较前轮（C6 → terminal 现状）
  if (!previous || !previous.ok) return null; // 前轮不可比 → 不伪造

  const raw = String(text || "");
  const curCounts = extractCounts(raw);

  if (kind === "test") {
    if (!previous.counts) return null;
    if (!curCounts) return null;
    const curCases = parseCases(raw);

    const prevFailed = previous.failedNames || [];
    const stillFailing = curCases.filter((c) => c.state === "fail").map((c) => c.name);
    // success current ⇒ 无失败 case；防御性保留断言（若 parser 发现失败 case，
    // 说明 success 判定与 case 层矛盾 —— 保守不出 delta）
    if (stillFailing.length > 0) return null;

    let mode;
    const lines = ["[VALIDATION_DELTA]"];
    if (previous.state === "failure") {
      mode = "failure_to_success_resolution";
      lines.push("mode=failure_to_success_resolution");
      lines.push(`previous_run_state=failure`);
      const resolved = prevFailed.filter((n) => !stillFailing.includes(n));
      if (resolved.length > 0) {
        lines.push(`previously_failing_cases=${resolved.length}`);
        lines.push("now_passing_cases:");
        lines.push(listNames(resolved));
      } else {
        lines.push("previously_failing_cases=0 (failure was not case-attributable)");
      }
    } else {
      // previous.state === "success"：逐 case / counts 比对
      const prevCounts = previous.counts;
      const countChanged =
        curCounts.pass !== prevCounts.pass ||
        curCounts.fail !== prevCounts.fail ||
        curCounts.skip !== prevCounts.skip;
      if (!countChanged && curCases.length === previous.caseCount) {
        mode = "success_unchanged";
        lines.push("mode=success_unchanged");
        lines.push("case_level_changes=0");
        lines.push(`unchanged_since_previous_run: pass=${curCounts.pass}`);
      } else {
        mode = "success_counts_changed";
        lines.push("mode=success_counts_changed");
        lines.push(
          `counts_delta: pass ${prevCounts.pass}->${curCounts.pass}, ` +
            `fail ${prevCounts.fail}->${curCounts.fail}, skip ${prevCounts.skip}->${curCounts.skip}`
        );
      }
    }
    lines.push(countsLine(curCounts));

    const deltaText = lines.join("\n");
    if (deltaText.length >= raw.length * 0.8) return null; // 长度护栏
    return { deltaText, mode };
  }

  // ---- build / check（C 阶段）：state-level 比对 ----
  const lines = ["[VALIDATION_DELTA]"];
  let mode;
  if (previous.state === "failure") {
    mode = "failure_to_success_resolution";
    lines.push("mode=failure_to_success_resolution");
    lines.push("previous_run_state=failure");
    const prevFailed = previous.failedNames || [];
    lines.push(`previously_failing_cases=${prevFailed.length} (check diagnostics not case-attributable)`);
  } else {
    mode = "success_unchanged";
    lines.push("mode=success_unchanged");
    lines.push("unchanged_since_previous_run: state=success");
    const err = curCounts && curCounts.errors;
    const warn = curCounts && curCounts.warnings;
    if (err !== undefined || warn !== undefined) {
      lines.push(`counts: errors=${err || 0} warnings=${warn || 0}`);
    }
  }

  const deltaText = lines.join("\n");
  if (deltaText.length >= raw.length * 0.8) return null; // 长度护栏（小输出 → Native，正确）
  return { deltaText, mode };
}

module.exports = {
  foldCommand,
  parseCases,
  extractCounts,
  buildFingerprint,
  sameCommand,
  tryCompressValidationDelta,
  MAX_FAILED_NAMES_LISTED,
};
