// ============================================================================
// telemetry_extended.test.js — 第二阶段增量扩展(产品效果观测)测试
// 运行:node --test deploy/hooks/post_tool/observability/telemetry_extended.test.js
// ============================================================================
// 覆盖 6 个确定性 canary cases(Native / Applied+NoRecovery / Applied+Recovery /
// Fallback / Token unavailable / Task test)+ 不变量与兼容性:
//   Case1  Native + 机会缺口(eligible=true selected=false 的 big read)
//   Case2  Applied + 无恢复:net == gross,no_recovery_rate=1
//   Case3  Applied + 恢复(same_file / same_query / same_command,窗口内)
//   Case4  Fallback(candidate 被丢弃)不污染 saving,机会面照常记录
//   Case5  Token unavailable:真实 usage 字段 null,绝不拿 chars 冒充 token
//   Case6  Task/Test 规则观测:test_executed 可确定,test_passed 不猜
//   + 漏斗不变量 applied≤selected≤eligible≤total / selected⇒eligible
//   + 延迟字段 ≥0 且 compression ≤ hook_total
//   + 全行/summary 无 NaN/Infinity
//   + 旧行(无扩展字段)replay 容错;旧 flat summary 与新 groups 共存
//   + 跨进程累计后 extended groups 与 flat 口径一致
//
// 所有 flows 驱动真实 metrics 代码路径(metrics_logger + session_metrics),
// 与 observability.test.js 同一 harness 风格。

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

// 必须在 require 任何 deploy 模块之前设置环境(模块加载/捕获时读取)。
const TEST_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "tasco-ext-test-"));
process.env.CODE_GUARD_BASE_DIR = TEST_BASE;
// 环境标识观测:验证 env → 事件字段传递。
process.env.CODE_GUARD_AGENT_RUNTIME = "test-agent";
process.env.CODE_GUARD_ARM = "ext-arm-a";
process.env.CODE_GUARD_EXPERIMENT_ID = "ext-exp-1";

const { createCompressionMetrics } = require("./compression_metrics");
const { createSessionMetrics } = require("./session_metrics");
const { createMetricsLogger } = require("./metrics_logger");
const {
  setActiveSessionId,
  sessionPath,
  RUNTIME_ROOT,
} = require("../../guard_core/runtime_paths");
const { createStateRuntime } = require("../state_runtime");

const silentLog = () => {};

const compressionMetrics = createCompressionMetrics({});
const sessionMetrics = createSessionMetrics({
  fs,
  path,
  sessionPath: (...args) => sessionPath(...args),
  log: silentLog,
});

function makeLogger() {
  return createMetricsLogger({
    fs,
    path,
    sessionPath: (...args) => sessionPath(...args),
    log: silentLog,
    extractToolText: (...args) => extractToolText(...args),
    extractToolName: (...args) => extractToolName(...args),
    compressionMetrics,
    sessionMetrics,
  });
}

const stateRuntime = createStateRuntime({
  fs,
  getStateFilePath: () => sessionPath("context_budget_state.json"),
  log: silentLog,
  safeJsonStringify: (obj) => {
    try {
      return JSON.stringify(obj, null, 2);
    } catch (_e) {
      return String(obj);
    }
  },
  mapCodeAgentToolName: (n) => n,
});
const { extractToolText, extractToolName } = stateRuntime;

// ---- helpers ---------------------------------------------------------------

function makePayload({ session, toolCallId, tool, content, input }) {
  return {
    session_id: session,
    tool_use_id: toolCallId,
    tool_name: tool,
    tool_input: input,
    tool_response: { content },
  };
}

function rawText(n, char = "A") {
  return char.repeat(n);
}

function readSummary(sessionId) {
  setActiveSessionId(sessionId);
  return sessionMetrics.loadSession(sessionId);
}

function readEventLines(sessionId) {
  setActiveSessionId(sessionId);
  const file = sessionPath("tasco_metrics", "tasco_compression.ndjson");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** 驱动一次真实 logger flow:payload → (可选 candidate) → finalize。 */
function fire(logger, { session, toolCallId, tool, content, input, candidate, finalize }) {
  // 每次调用显式激活目标 session(日志路径按 active session 路由)。
  setActiveSessionId(session);
  const payload = makePayload({ session, toolCallId, tool, content, input });
  logger.setPayload(payload);
  if (candidate) logger.noteCandidate(candidate.strategy, candidate.text);
  logger.finalize(finalize);
}

/** 递归检查对象里所有 number 均为有限值(无 NaN/Infinity)。 */
function assertNoNaN(obj, where) {
  if (obj == null) return;
  if (typeof obj === "number") {
    assert.ok(Number.isFinite(obj), `${where} 不是有限数: ${obj}`);
    return;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) assertNoNaN(v, `${where}.${k}`);
  }
}

// ============================================================================
// Case1 Native + 机会缺口:大 read 未压缩时 eligible=true selected=false,
// funnel 如实暴露缺口;小输出带 below_min 原因。
// ============================================================================
test("Case1 native: eligible gap row + below_min reason", () => {
  const S = "ext-c1";
  const logger = makeLogger();

  // ev1:shell 300 chars → 低于最小门槛
  fire(logger, {
    session: S,
    toolCallId: "c1-1",
    tool: "run_shell_command",
    content: rawText(300),
    input: { command: "git status" },
    finalize: { text: "", replaceOutput: false, delivered: rawText(300), reason: "native" },
  });
  // ev2:read 5000 chars → 类型+体量都够但引擎未介入(机会缺口)
  fire(logger, {
    session: S,
    toolCallId: "c1-2",
    tool: "read_file",
    content: rawText(5000),
    input: { file_path: "src/big.js" },
    finalize: { text: "", replaceOutput: false, delivered: rawText(5000), reason: "native" },
  });

  const rows = readEventLines(S);
  assert.equal(rows.length, 2);

  const r1 = rows[0];
  assert.equal(r1.selected, false);
  assert.equal(r1.eligible, false);
  assert.equal(r1.eligibility_reason, "below_min_compress_chars");
  assert.equal(r1.scenario, "shell");
  assert.equal(r1.access.type, "command");
  assert.equal(r1.recovery_detected, false);
  assert.equal(r1.compression_latency_ms, null);
  assert.ok(r1.hook_total_latency_ms >= 0);
  assert.equal(r1.test_executed, false);
  assert.equal(r1.token_source, "tokenizer_estimate");
  assert.equal(r1.agent, "test-agent");
  assert.equal(r1.arm, "ext-arm-a");
  assert.equal(r1.experiment_id, "ext-exp-1");
  assert.equal(r1.model, null);
  assert.equal(r1.strategy_version, "v1");
  assert.equal(r1.repo_name, path.basename(process.cwd()));
  assert.ok(r1.repo_hash === null || /^[0-9a-f]+$/i.test(r1.repo_hash));

  const r2 = rows[1];
  assert.equal(r2.selected, false);
  assert.equal(r2.eligible, true, "big read native = opportunity gap, eligible must be true");
  assert.equal(r2.eligibility_reason, null);
  assert.equal(r2.scenario, "read");
  assert.deepEqual(r2.access, { type: "file", key: "src/big.js" });

  const s = readSummary(S);
  assert.equal(s.total_calls, 2);
  assert.equal(s.native_calls, 2);
  assert.equal(s.selected_calls, 0);
  assert.equal(s.before_chars, 0, "native 不进入字符累计(legacy 语义不变)");
  // extended groups
  assert.equal(s.opportunity.eligible_calls, 1);
  assert.equal(s.opportunity.eligible_rate, 0.5);
  assert.equal(s.opportunity.selection_rate, 0);
  assert.equal(s.opportunity.apply_rate, null, "无 selected → 除数为 0 → null");
  assert.equal(s.opportunity.positive_yield, null);
  assert.equal(s.opportunity.no_recovery_rate, null);
  assert.deepEqual(s.tokens, {
    token_source: "tokenizer_estimate",
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    total_tokens: null,
  });
  assert.equal(s.latency.events, 2);
  assert.ok(Number.isInteger(s.latency.hook_total_latency_ms));
});

// ============================================================================
// Case2 Applied + NoRecovery:窗口内无重访 → net == gross,no_recovery_rate=1
// ============================================================================
test("Case2 applied with no recovery: net == gross, no_recovery_rate=1", () => {
  const S = "ext-c2";
  const logger = makeLogger();

  // applied:read 30000 → 6000
  fire(logger, {
    session: S,
    toolCallId: "c2-1",
    tool: "read_file",
    content: rawText(30000),
    input: { file_path: "src/a.js" },
    candidate: { strategy: "fast_truncate", text: rawText(6000, "C") },
    finalize: { text: rawText(6000, "C"), replaceOutput: true, delivered: rawText(6000, "C"), reason: "applied" },
  });
  // 之后 6 个不相关小 shell(窗口 N=5 内无同资源重访)
  const cmds = ["git status", "ls -la", "echo hi", "git log -1", "pwd", "whoami"];
  cmds.forEach((cmd, i) => {
    fire(logger, {
      session: S,
      toolCallId: `c2-${2 + i}`,
      tool: "run_shell_command",
      content: rawText(100),
      input: { command: cmd },
      finalize: { text: "", replaceOutput: false, delivered: rawText(100), reason: "native" },
    });
  });

  const rows = readEventLines(S);
  assert.equal(rows.length, 7);
  const applied = rows[0];
  assert.equal(applied.applied, true);
  assert.equal(applied.recovery_detected, false);

  const s = readSummary(S);
  assert.equal(s.total_calls, 7);
  assert.equal(s.applied_calls, 1);
  assert.equal(s.saved_chars, 24000);
  // recovery groups
  assert.equal(s.recovery.detected_events, 0);
  assert.equal(s.recovery.recovery_cost_chars, 0);
  assert.equal(s.recovery.gross_saved_chars, 24000);
  assert.equal(s.recovery.net_saved_chars, 24000, "无恢复 → net == gross");
  assert.equal(s.recovery.read_count, 0);
  assert.equal(s.recovery.applied_evaluated, 1, "后面 6 行 ≥ 窗口 5 → 全窗口已观测");
  assert.equal(s.recovery.applied_no_recovery, 1);
  assert.equal(s.recovery.applied_pending, 0);
  // opportunity funnel
  assert.equal(s.opportunity.eligible_calls, 1, "只有 applied 本身;6 个小 shell 低于门槛");
  assert.equal(s.opportunity.eligible_rate, 1 / 7);
  assert.equal(s.opportunity.selection_rate, 1);
  assert.equal(s.opportunity.apply_rate, 1);
  assert.equal(s.opportunity.positive_yield, 1);
  assert.equal(s.opportunity.no_recovery_rate, 1);
});

// ============================================================================
// Case3 Applied + Recovery:同文件 / 同 query / 同命令三种恢复,成本与净节省
// ============================================================================
test("Case3 applied then recovery: same_file/same_query/same_command links + net saving", () => {
  const S = "ext-c3";
  const logger = makeLogger();

  const fireApplied = (session, toolCallId, tool, content, input, strategy, deliveredChar) => {
    // content 是字符串;体量按字符串长度计算(字符串 × 0.2 会得 NaN)。
    const delivered = rawText(content.length < 1000 ? 200 : Math.floor(content.length * 0.2), deliveredChar);
    fire(logger, {
      session,
      toolCallId,
      tool,
      content,
      input,
      candidate: { strategy, text: delivered },
      finalize: { text: delivered, replaceOutput: true, delivered, reason: "applied" },
    });
    return delivered.length;
  };

  // r1 applied:read lib/core.js 30000 → 6000 (saved 24000)
  fireApplied(S, "c3-1", "read_file", rawText(30000), { file_path: "lib/core.js" }, "fast_truncate", "C");
  // r2 native 重读同文件 4000 → recovery of r1 (same_file, gap 1, cost 4000)
  fire(logger, {
    session: S,
    toolCallId: "c3-2",
    tool: "read_file",
    content: rawText(4000),
    input: { file_path: "lib/core.js" },
    finalize: { text: "", replaceOutput: false, delivered: rawText(4000), reason: "native" },
  });
  // r3 applied:grep "TODO:fix" 5000 → 1000 (saved 4000)
  fireApplied(S, "c3-3", "grep_search", rawText(5000), { pattern: "TODO:fix" }, "quick_grep", "D");
  // r4 native 重查同 query 120 → recovery of r3 (same_query, gap 1, cost 120)
  fire(logger, {
    session: S,
    toolCallId: "c3-4",
    tool: "grep_search",
    content: rawText(120),
    input: { pattern: "TODO:fix" },
    finalize: { text: "", replaceOutput: false, delivered: rawText(120), reason: "native" },
  });
  // r5 applied:shell "npm run build" 8000 → 1600 (saved 6400)
  fireApplied(S, "c3-5", "run_shell_command", rawText(8000), { command: "npm run build" }, "quick_shell", "E");
  // r6 native 重跑同命令 50 → recovery of r5 (same_command, gap 1, cost 50)
  fire(logger, {
    session: S,
    toolCallId: "c3-6",
    tool: "run_shell_command",
    content: rawText(50),
    input: { command: "npm run build" },
    finalize: { text: "", replaceOutput: false, delivered: rawText(50), reason: "native" },
  });

  const rows = readEventLines(S);
  assert.equal(rows.length, 6);
  const r1 = rows[0];
  const r3 = rows[2];
  const r5 = rows[4];
  const ids = { r1: r1.compression_id, r3: r3.compression_id, r5: r5.compression_id };

  // 行级 link:r2→r1 same_file;r4→r3 same_query;r6→r5 same_command
  const r2 = rows[1];
  assert.equal(r2.recovery_detected, true);
  assert.equal(r2.recovery_of, ids.r1);
  assert.equal(r2.recovery_kind, "same_file");
  assert.equal(r2.recovery_gap_calls, 1);
  assert.equal(r2.recovery_cost_chars, 4000, "恢复行成本 = 本行 delivered");
  assert.equal(r2.access.type, "file");

  const r4 = rows[3];
  assert.equal(r4.recovery_detected, true);
  assert.equal(r4.recovery_of, ids.r3);
  assert.equal(r4.recovery_kind, "same_query");
  assert.equal(r4.recovery_gap_calls, 1);
  assert.equal(r4.recovery_cost_chars, 120);

  const r6 = rows[5];
  assert.equal(r6.recovery_detected, true);
  assert.equal(r6.recovery_of, ids.r5);
  assert.equal(r6.recovery_kind, "same_command");
  assert.equal(r6.recovery_gap_calls, 1);
  assert.equal(r6.recovery_cost_chars, 50);

  // 无恢复窗口内其它行不误标
  assert.equal(rows.filter((r) => r.recovery_detected).length, 3);

  const s = readSummary(S);
  // legacy flat 与扩展 gross 一致
  assert.equal(s.applied_calls, 3);
  const gross = 24000 + 4000 + 6400;
  const cost = 4000 + 120 + 50;
  assert.equal(s.saved_chars, gross);
  assert.equal(s.recovery.gross_saved_chars, gross, "gross == legacy saved");
  assert.equal(s.recovery.recovery_cost_chars, cost);
  assert.equal(s.recovery.net_saved_chars, gross - cost);
  assert.equal(s.recovery.detected_events, 3);
  assert.equal(s.recovery.read_count, 1);
  assert.equal(s.recovery.search_count, 1);
  assert.equal(s.recovery.command_count, 1);
  // 窗口状态:r1(idx0)后 5 行 → evaluated;r3(idx2)后 3 行 < 5 但已恢复;
  // r5(idx4)后 1 行 < 5 但已恢复 → pending 0
  assert.equal(s.recovery.applied_evaluated, 1);
  assert.equal(s.recovery.applied_no_recovery, 0);
  assert.equal(s.recovery.applied_pending, 0);
  // opportunity
  assert.equal(s.opportunity.eligible_calls, 4, "3 applied + r2 机会缺口(4000 ≥ 2000)");
  assert.equal(s.opportunity.selection_rate, 3 / 4);
  assert.equal(s.opportunity.apply_rate, 1);
  assert.equal(s.opportunity.positive_yield, 1);
  assert.equal(s.opportunity.no_recovery_rate, 0);
});

// ============================================================================
// Case3b adapter-boundary contract(回归):真实 Claude Code payload 的工具名
// 是显示名 Read/Grep/Bash/Glob,不是已归一化的 read_file/grep_search/…。
// 本用例以真实原始名为输入,完整走
//   raw payload → mapCodeAgentToolName + normalizeToolName(统一归一化入口)
//              → telemetry event → extractAccess → recovery linking,
// 防止"测试把生产缺失的归一化步骤偷偷补齐"(mock 恒等映射 + 归一化 fixture)
// 而让 extractAccess 的生产盲区漏检 —— 见 v1 部署缺陷:access 恒 null,
// recovery 结构性失效。
// ============================================================================
test("Case3b real display-name payloads (Read/Grep/Bash/Glob) reach access + recovery", () => {
  const S = "ext-c3b";
  // 与生产一致:createStateRuntime 注入真实的 mapCodeAgentToolName
  // (guard_core/codeagent_compat: Read→read_file / Glob→glob_search …)。
  const { mapCodeAgentToolName } = require("../../guard_core/codeagent_compat");
  const prodRuntime = createStateRuntime({
    fs,
    getStateFilePath: () => sessionPath("context_budget_state.json"),
    log: silentLog,
    safeJsonStringify: (obj) => {
      try {
        return JSON.stringify(obj, null, 2);
      } catch (_e) {
        return String(obj);
      }
    },
    mapCodeAgentToolName,
  });
  const logger = createMetricsLogger({
    fs,
    path,
    sessionPath: (...args) => sessionPath(...args),
    log: silentLog,
    extractToolText: (...args) => prodRuntime.extractToolText(...args),
    extractToolName: (...args) => prodRuntime.extractToolName(...args),
    compressionMetrics,
    sessionMetrics,
  });

  // r1 applied:Read lib/reply.js 30000 → fast_truncate 6000(工具名 "Read")
  fire(logger, {
    session: S,
    toolCallId: "c3b-1",
    tool: "Read",
    content: rawText(30000),
    input: { file_path: "lib/reply.js" },
    candidate: { strategy: "fast_truncate", text: rawText(6000, "C") },
    finalize: { text: rawText(6000, "C"), replaceOutput: true, delivered: rawText(6000, "C"), reason: "applied" },
  });
  // r2 native 重读同文件 4000(窗口内)→ same_file recovery of r1
  fire(logger, {
    session: S,
    toolCallId: "c3b-2",
    tool: "Read",
    content: rawText(4000),
    input: { file_path: "lib/reply.js" },
    finalize: { text: "", replaceOutput: false, delivered: rawText(4000), reason: "native" },
  });
  // r3 applied:Bash 8000 → quick_shell 1600(工具名 "Bash")
  fire(logger, {
    session: S,
    toolCallId: "c3b-3",
    tool: "Bash",
    content: rawText(8000),
    input: { command: "node -e run" },
    candidate: { strategy: "quick_shell", text: rawText(1600, "E") },
    finalize: { text: rawText(1600, "E"), replaceOutput: true, delivered: rawText(1600, "E"), reason: "applied" },
  });
  // r4 native 重跑同命令(窗口内)→ same_command recovery of r3
  fire(logger, {
    session: S,
    toolCallId: "c3b-4",
    tool: "Bash",
    content: rawText(8000),
    input: { command: "node -e run" },
    finalize: { text: "", replaceOutput: false, delivered: rawText(8000), reason: "native" },
  });
  // r5 Glob → canonical glob_search(→grep_search)→ query access
  fire(logger, {
    session: S,
    toolCallId: "c3b-5",
    tool: "Glob",
    content: rawText(300),
    input: { pattern: "lib/*.js" },
    finalize: { text: "", replaceOutput: false, delivered: rawText(300), reason: "native" },
  });
  // r6 Grep → query access
  fire(logger, {
    session: S,
    toolCallId: "c3b-6",
    tool: "Grep",
    content: rawText(2500),
    input: { pattern: "function compute" },
    finalize: { text: "", replaceOutput: false, delivered: rawText(2500), reason: "native" },
  });

  const rows = readEventLines(S);
  assert.equal(rows.length, 6);

  // telemetry 主路径归一化不变
  assert.equal(rows[0].tool, "read_file");
  assert.equal(rows[2].tool, "run_shell_command");

  // access 从真实原始名路径产生(修复前恒 null)
  assert.deepEqual(rows[0].access, { type: "file", key: "lib/reply.js" }, "Read → file access");
  assert.equal(rows[1].recovery_detected, true, "重复 Read 必须命中 same_file");
  assert.equal(rows[1].recovery_kind, "same_file");
  assert.equal(rows[1].recovery_cost_chars, 4000);
  assert.equal(rows[2].access.type, "command", "Bash → command access");
  assert.ok(/^[0-9a-f]{16}$/.test(rows[2].access.key), "command key = 16hex sha");
  assert.equal(rows[3].recovery_detected, true, "重复 Bash 必须命中 same_command");
  assert.equal(rows[3].recovery_kind, "same_command");
  assert.equal(rows[3].recovery_cost_chars, 8000);
  assert.equal(rows[4].tool, "grep_search", "Glob → canonical grep_search(统一入口)");
  assert.equal(rows[4].access.type, "query", "Glob → query access");
  assert.deepEqual(rows[5].access, { type: "query", key: "function compute" }, "Grep → query access");

  // summary:net = gross − recovery_cost(旧字段 saved 语义不变)
  const s = readSummary(S);
  const gross = 24000 + 6400;
  const cost = 4000 + 8000;
  assert.equal(s.saved_chars, gross, "legacy saved 不变(不回头篡改历史 saved)");
  assert.equal(s.recovery.gross_saved_chars, gross);
  assert.equal(s.recovery.recovery_cost_chars, cost);
  assert.equal(s.recovery.net_saved_chars, gross - cost);
  assert.equal(s.recovery.detected_events, 2);
  assert.equal(s.recovery.read_count, 1);
  assert.equal(s.recovery.command_count, 1);
  assert.equal(s.recovery.search_count, 0);
});

// ============================================================================
// Case4 Fallback:candidate 被丢弃 → selected+fallback,不污染 saving;
// eligible 照常 = true(引擎确实介入)。
// ============================================================================
test("Case4 fallback (candidate discarded): no saving pollution, eligible recorded", () => {
  const S = "ext-c4";
  const logger = makeLogger();

  // rlm 压缩不足被丢弃:noteCandidate 后 output() 空文本 → candidate_discarded
  const raw = rawText(10000);
  fire(logger, {
    session: S,
    toolCallId: "c4-1",
    tool: "read_file",
    content: raw,
    input: { file_path: "docs/big.md" },
    candidate: { strategy: "rlm_compress", text: rawText(9000, "C") },
    finalize: { text: "", replaceOutput: false, delivered: raw, reason: "native" },
  });

  const rows = readEventLines(S);
  const r = rows[0];
  assert.equal(r.selected, true);
  assert.equal(r.applied, false);
  assert.equal(r.fallback, true);
  assert.equal(r.reason, "candidate_discarded");
  assert.equal(r.eligible, true, "selected ⇒ eligible");
  assert.equal(r.eligibility_reason, null);
  assert.equal(r.saved_chars, 0);
  assert.ok(r.compression_latency_ms >= 0, "fallback 也有压缩耗时观测");

  const s = readSummary(S);
  assert.equal(s.total_calls, 1);
  assert.equal(s.selected_calls, 1);
  assert.equal(s.fallback_calls, 1);
  assert.equal(s.saved_chars, 0, "fallback 不污染 saving");
  assert.equal(s.recovery.gross_saved_chars, 0);
  assert.equal(s.recovery.net_saved_chars, 0);
  assert.equal(s.opportunity.eligible_calls, 1);
  assert.equal(s.opportunity.selection_rate, 1);
  assert.equal(s.opportunity.apply_rate, 0);
  assert.equal(s.opportunity.positive_yield, null, "无 applied → null");
});

// ============================================================================
// Case5 Token unavailable:真实 usage 字段 null + token_source 声明;
// token 估算存在但不冒充真实 usage,更不拿 chars 顶替。
// ============================================================================
test("Case5 token usage unavailable: real fields null, estimates labeled", () => {
  const S = "ext-c5";
  const logger = makeLogger();

  fire(logger, {
    session: S,
    toolCallId: "c5-1",
    tool: "read_file",
    content: rawText(5000),
    input: { file_path: "src/tok.js" },
    candidate: { strategy: "fast_truncate", text: rawText(2000, "C") },
    finalize: { text: rawText(2000, "C"), replaceOutput: true, delivered: rawText(2000, "C"), reason: "applied" },
  });

  const rows = readEventLines(S);
  const r = rows[0];
  for (const f of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens"]) {
    assert.equal(r[f], null, `${f} 必须为 null(真实 usage 不可得)`);
  }
  assert.equal(r.token_source, "tokenizer_estimate");
  assert.equal(r.token_mode, "estimated");
  // 估算存在:ASCII 5000 → ceil(5000/4)=1250;delivered 2000 → 500
  assert.equal(r.before_tokens_est, 1250);
  assert.equal(r.delivered_tokens_est, 500);
  assert.equal(r.saved_tokens_est, 750);
  // 绝不拿字符数冒充 token
  assert.notEqual(r.before_tokens_est, r.before_chars);
  assert.notEqual(r.delivered_tokens_est, r.delivered_chars);
  assert.notEqual(r.saved_tokens_est, r.saved_chars);

  const s = readSummary(S);
  assert.equal(s.tokens.token_source, "tokenizer_estimate");
  assert.equal(s.tokens.total_tokens, null);
  // legacy est 累计不变
  assert.equal(s.before_tokens_est, 1250);
  assert.equal(s.delivered_tokens_est, 500);
});

// ============================================================================
// Case6 Task/Test 规则观测:test_executed 可确定;test_passed 不可得 → null,
// 绝不猜测成功。
// ============================================================================
test("Case6 task/test rule observation: executed known, passed NOT guessed", () => {
  const S = "ext-c6";
  const logger = makeLogger();

  fire(logger, {
    session: S,
    toolCallId: "c6-1",
    tool: "run_shell_command",
    content: rawText(9000),
    input: { command: "npm test -- --runInBand" },
    candidate: { strategy: "quick_shell", text: rawText(2000, "C") },
    finalize: { text: rawText(2000, "C"), replaceOutput: true, delivered: rawText(2000, "C"), reason: "applied" },
  });
  fire(logger, {
    session: S,
    toolCallId: "c6-2",
    tool: "run_shell_command",
    content: rawText(100),
    input: { command: "git status" },
    finalize: { text: "", replaceOutput: false, delivered: rawText(100), reason: "native" },
  });

  const rows = readEventLines(S);
  assert.equal(rows[0].test_executed, true, "npm test 调用可规则确定");
  assert.ok(rows[0].test_command.includes("npm test"));
  assert.equal(rows[0].test_passed, null, "hook payload 无退出码 → 不猜通过");
  assert.equal(rows[0].test_exit_code, null);
  assert.equal(rows[1].test_executed, false);

  const s = readSummary(S);
  assert.equal(s.quality.test_executed, true);
  assert.equal(s.quality.test_events, 1);
  assert.equal(s.quality.test_passed, null);
  assert.equal(s.quality.test_exit_code, null);
  assert.equal(s.quality.task_status, null);
  assert.equal(s.quality.task_success, null);
  assert.equal(s.quality.agent_abort, null);
  assert.equal(s.quality.user_retry, null);
});

// ============================================================================
// 不变量:selected⇒eligible;applied≤selected≤eligible≤total;延迟 ≥0;
// 全对象无 NaN/Infinity。
// ============================================================================
test("invariants: funnel ordering, latency >= 0, no NaN anywhere", () => {
  const S = "ext-inv";
  const logger = makeLogger();
  const seq = [
    ["inv-1", "read_file", rawText(30000), { file_path: "inv/x.js" }, true, 6000, "applied"],
    ["inv-2", "run_shell_command", rawText(100), { command: "echo n" }, false, 0, "native"],
    ["inv-3", "read_file", rawText(2500), { file_path: "inv/x.js" }, false, 0, "native"],
    ["inv-4", "grep_search", rawText(7000), { pattern: "alpha" }, true, 1200, "applied"],
    ["inv-5", "read_file", rawText(900), { file_path: "inv/y.js" }, false, 0, "native"],
  ];
  for (const [id, tool, content, input, selected, deliveredLen, reason] of seq) {
    fire(logger, {
      session: S,
      toolCallId: id,
      tool,
      content,
      input,
      candidate: selected ? { strategy: "test_strategy", text: rawText(deliveredLen, "C") } : null,
      finalize: {
        text: selected ? rawText(deliveredLen, "C") : "",
        replaceOutput: selected,
        delivered: selected ? rawText(deliveredLen, "C") : content,
        reason,
      },
    });
  }

  const rows = readEventLines(S);
  for (const r of rows) {
    if (r.selected) assert.equal(r.eligible, true, "selected ⇒ eligible");
    if (r.applied) assert.equal(r.selected, true, "applied ⇒ selected");
    assert.ok(r.hook_total_latency_ms >= 0, "hook_total >= 0");
    if (r.compression_latency_ms != null) {
      assert.ok(r.compression_latency_ms >= 0);
      assert.ok(r.compression_latency_ms <= r.hook_total_latency_ms, "compression <= hook_total");
    } else {
      assert.equal(r.selected, false, "native 无压缩耗时");
    }
    if (r.eligible === false) {
      assert.ok(r.eligibility_reason, "非 eligible 必有原因");
    }
    assertNoNaN(r, "row");
  }
  // 漏斗顺序(applied ≤ selected ≤ eligible ≤ total)
  const counts = {
    total: rows.length,
    eligible: rows.filter((r) => r.eligible).length,
    selected: rows.filter((r) => r.selected).length,
    applied: rows.filter((r) => r.applied).length,
  };
  assert.ok(counts.applied <= counts.selected && counts.selected <= counts.eligible && counts.eligible <= counts.total);
  const s = readSummary(S);
  assertNoNaN(s, "summary");
  // summary 内的 rate 与行数重算一致
  assert.equal(s.opportunity.eligible_calls, counts.eligible);
  assert.equal(s.total_calls, counts.total);
  assert.equal(s.latency.events, counts.total);
});

// ============================================================================
// 兼容性:旧行(无扩展字段)+ 旧 flat summary 与新代码共存,replay 容错。
// ============================================================================
test("legacy compatibility: old rows/summary without extension fields coexist", () => {
  const S = "ext-legacy";
  setActiveSessionId(S);
  const dir = path.dirname(sessionPath("tasco_metrics", "session_summary.json"));
  fs.mkdirSync(dir, { recursive: true });
  // 旧 flat summary(仅既有字段)
  fs.writeFileSync(
    path.join(dir, "session_summary.json"),
    JSON.stringify({
      session_id: S,
      total_calls: 2,
      native_calls: 1,
      selected_calls: 1,
      applied_calls: 1,
      fallback_calls: 0,
      before_chars: 20000,
      delivered_chars: 5000,
      saved_chars: 15000,
      before_tokens_est: 5000,
      delivered_tokens_est: 1250,
      saved_tokens_est: 3750,
      reduction_rate: 0.75,
      recent_tool_call_ids: ["leg-1", "leg-2"],
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
    "utf8"
  );
  // 旧行(无 eligible/access/latency 等新字段)
  const legacyRow = (id, tool, before, delivered, applied) => ({
    event: "tasco_compression",
    timestamp: "2026-01-01T00:00:00.000Z",
    session_id: S,
    tool_call_id: id,
    compression_id: "11111111-1111-4111-8111-111111111111",
    tool,
    strategy: applied ? "fast_truncate" : "none",
    selected: applied,
    applied,
    fallback: false,
    before_chars: before,
    candidate_chars: applied ? 2500 : null,
    delivered_chars: delivered,
    saved_chars: Math.max(0, before - delivered),
    reduction_rate: before > 0 ? Math.max(0, before - delivered) / before : 0,
    delta_chars: delivered - before,
    before_tokens_est: 5000,
    candidate_tokens_est: null,
    delivered_tokens_est: 1250,
    saved_tokens_est: 3750,
    token_mode: "estimated",
    reason: applied ? "applied" : "native",
  });
  fs.appendFileSync(
    path.join(dir, "tasco_compression.ndjson"),
    [legacyRow("leg-1", "read_file", 20000, 5000, true), legacyRow("leg-2", "run_shell_command", 100, 100, false)]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
    "utf8"
  );

  // 新事件追加(同 session):replay 必须对旧行容错
  const logger = makeLogger();
  fire(logger, {
    session: S,
    toolCallId: "leg-3",
    tool: "read_file",
    content: rawText(10000),
    input: { file_path: "legacy/f.js" },
    candidate: { strategy: "fast_truncate", text: rawText(2500, "C") },
    finalize: { text: rawText(2500, "C"), replaceOutput: true, delivered: rawText(2500, "C"), reason: "applied" },
  });

  const s = readSummary(S);
  // legacy flat:从升级点起累计新事件(2 旧 + 1 新 = 3)
  assert.equal(s.total_calls, 3);
  assert.equal(s.applied_calls, 2);
  assert.equal(s.saved_chars, 15000 + 7500);
  // extended groups:对全量行(含旧行)确定性 replay —— 旧行缺字段按 0/null 处理;
  // leg-1 applied(selected)与 leg-3 applied 计入 eligible;leg-2 小 shell 低于门槛。
  assert.equal(s.opportunity.eligible_calls, 2, "旧 applied 行(selected)可归类 eligible;小 native 不计");
  assert.equal(s.recovery.gross_saved_chars, 22500);
  assert.equal(s.recovery.net_saved_chars, 22500);
  assert.equal(s.recovery.detected_events, 0, "旧行无 access → 不参与恢复匹配");
  assert.equal(s.latency.events, 1, "旧行无延迟字段 → 不混入 0ms");
  assert.ok(s.environment.repo_name);
  assert.ok(s.opportunity && s.recovery && s.tokens && s.quality && s.latency && s.environment);
  // 旧字段字节级保持存在
  assert.equal(typeof s.reduction_rate, "number");
  assert.equal(s.session_id, S);
});

// ============================================================================
// 跨进程:多进程累计后 extended groups 与 flat 口径一致(同 T11 harness)。
// ============================================================================
test("cross-process: extended groups consistent after concurrent accumulation", () => {
  const SESSION = "ext-conc";
  const CHILDREN = 3;
  const EVENTS_PER_CHILD = 4;
  const BEFORE = 4000;
  const AFTER = 800;

  const metricsPath = path.join(__dirname, "metrics_logger.js");
  const sessionPathMod = path.join(__dirname, "session_metrics.js");
  const compressionPath = path.join(__dirname, "compression_metrics.js");
  const runtimePathsMod = path.join(__dirname, "..", "..", "guard_core", "runtime_paths.js");

  const childScript = `
const fs = require("fs");
const path = require("path");
const { createCompressionMetrics } = require(${JSON.stringify(compressionPath)});
const { createSessionMetrics } = require(${JSON.stringify(sessionPathMod)});
const { createMetricsLogger } = require(${JSON.stringify(metricsPath)});
const { setActiveSessionId, sessionPath } = require(${JSON.stringify(runtimePathsMod)});
const silentLog = () => {};
setActiveSessionId(${JSON.stringify(SESSION)});
const cm = createCompressionMetrics({});
const sm = createSessionMetrics({ fs, path, sessionPath: (...a) => sessionPath(...a), log: silentLog });
const logger = createMetricsLogger({
  fs, path,
  sessionPath: (...a) => sessionPath(...a),
  log: silentLog,
  extractToolText: (p) => (p && p.tool_response && p.tool_response.content) || "",
  extractToolName: (p) => (p && p.tool_name) || "unknown_tool",
  compressionMetrics: cm,
  sessionMetrics: sm,
});
const childIdx = Number(process.env.TASCO_CHILD_IDX);
for (let i = 0; i < ${EVENTS_PER_CHILD}; i++) {
  const payload = {
    session_id: ${JSON.stringify(SESSION)},
    tool_use_id: "conc-" + childIdx + "-" + i,
    tool_name: "read_file",
    tool_input: { file_path: "shared/file-" + childIdx + "-" + i + ".js" },
    tool_response: { content: "A".repeat(${BEFORE}) },
  };
  logger.setPayload(payload);
  logger.noteCandidate("fast_truncate", "C".repeat(${AFTER}));
  logger.finalize({ text: "C".repeat(${AFTER}), replaceOutput: true, delivered: "C".repeat(${AFTER}), reason: "applied" });
}
`;

  for (let c = 0; c < CHILDREN; c++) {
    const r = cp.spawnSync(process.execPath, ["-e", childScript], {
      env: { ...process.env, TASCO_CHILD_IDX: String(c) },
      timeout: 60000,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `child ${c} failed: ${r.stderr}`);
  }

  const s = readSummary(SESSION);
  const expected = CHILDREN * EVENTS_PER_CHILD;
  assert.equal(s.total_calls, expected);
  assert.equal(s.applied_calls, expected);
  // 每 child 用各自文件 → 无恢复
  assert.equal(s.recovery.detected_events, 0);
  assert.equal(s.recovery.gross_saved_chars, s.saved_chars);
  assert.equal(s.recovery.net_saved_chars, s.saved_chars);
  assert.equal(s.opportunity.eligible_calls, expected);
  assert.equal(s.opportunity.apply_rate, 1);
  assert.equal(s.latency.events, expected, "全部新行都带延迟字段");
  assert.equal(s.quality.test_executed, false);
});

// ============================================================================
// 窗口覆盖:CODE_GUARD_RECOVERY_WINDOW 生效(窗口=1 时 gap=2 不判恢复)。
// ============================================================================
test("recovery window override: window=1 excludes gap-2 recheck", () => {
  const S = "ext-win";
  const oldWindow = process.env.CODE_GUARD_RECOVERY_WINDOW;
  process.env.CODE_GUARD_RECOVERY_WINDOW = "1";
  try {
    const logger = makeLogger();
    fire(logger, {
      session: S,
      toolCallId: "w-1",
      tool: "read_file",
      content: rawText(30000),
      input: { file_path: "win/x.js" },
      candidate: { strategy: "fast_truncate", text: rawText(6000, "C") },
      finalize: { text: rawText(6000, "C"), replaceOutput: true, delivered: rawText(6000, "C"), reason: "applied" },
    });
    fire(logger, {
      session: S,
      toolCallId: "w-2",
      tool: "run_shell_command",
      content: rawText(100),
      input: { command: "echo between" },
      finalize: { text: "", replaceOutput: false, delivered: rawText(100), reason: "native" },
    });
    // gap=2 > window=1 → 不判恢复
    fire(logger, {
      session: S,
      toolCallId: "w-3",
      tool: "read_file",
      content: rawText(5000),
      input: { file_path: "win/x.js" },
      finalize: { text: "", replaceOutput: false, delivered: rawText(5000), reason: "native" },
    });
    const rows = readEventLines(S);
    assert.equal(rows[2].recovery_detected, false, "window=1 → gap=2 不算恢复");
    assert.equal(rows[2].recovery_of, null);
    const sum = readSummary(S);
    assert.equal(sum.recovery.detected_events, 0);
  } finally {
    if (oldWindow === undefined) delete process.env.CODE_GUARD_RECOVERY_WINDOW;
    else process.env.CODE_GUARD_RECOVERY_WINDOW = oldWindow;
  }
});

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------
test.after(() => {
  try {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  } catch (_e) {}
});
