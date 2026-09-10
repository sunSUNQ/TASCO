"use strict";

// ============================================================================
// observability.test.js — 压缩效果可观测性(第一阶段)测试
// 运行:node --test deploy/hooks/post_tool/observability/observability.test.js
// ============================================================================
// 覆盖:
//   1. 正常压缩         2. candidate 后 fallback    3. 无压缩
//   4. delivered > before  5. Session 加权累计      6. fallback 不污染 saving
//   7. Session A/B 隔离    8. telemetry 写入失败仍交付
//   9. candidate 口径(clamp/包装前后)  10. 缺失 session_id(跳过聚合,无 default 桶)
//   11. 同一 Session 并发更新(子进程)  12. finalize 恰好一次
//   + 真实 output() 出口集成(拒绝/接受/guidance/native 的 delivered 证明)
//   + 相同 tool_call_id 重复回调不重复累计(含 A→B→A 乱序;有界 128 集合)
//   + compression_id 为 UUID / summary 原子覆写无 .tmp 残留

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

// 必须在 require 任何 deploy 模块之前设置运行时根目录(模块加载时读 env)。
const TEST_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "tasco-metrics-test-"));
process.env.CODE_GUARD_BASE_DIR = TEST_BASE;

const { createCompressionMetrics } = require("./compression_metrics");
const { createSessionMetrics } = require("./session_metrics");
const { createMetricsLogger } = require("./metrics_logger");
const {
  setActiveSessionId,
  sessionPath,
  RUNTIME_ROOT,
} = require("../../guard_core/runtime_paths");
const { createOutputTransport } = require("../output_transport");
const { createOutputArchiver } = require("../output_archive");
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
const {
  extractToolText,
  extractToolName,
  loadState,
  normalizeAfterToolState,
  saveState,
} = stateRuntime;

function makeTransport(metrics) {
  return createOutputTransport({
    fs,
    path,
    BASE_DIR: RUNTIME_ROOT,
    log: silentLog,
    createOutputArchiver: (...args) =>
      createOutputArchiver({
        getArchiveDir: () => sessionPath("tool_output_archive"),
        log: silentLog,
        maxArchiveFiles: "100",
      }),
    extractToolText: (...args) => extractToolText(...args),
    extractToolName: (...args) => extractToolName(...args),
    loadState: (...args) => loadState(...args),
    normalizeAfterToolState: (...args) => normalizeAfterToolState(...args),
    saveState: (...args) => saveState(...args),
    metrics,
  });
}

function makePayload({ session, toolCallId, tool, content }) {
  return {
    session_id: session,
    tool_use_id: toolCallId,
    tool_name: tool,
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

function countEventLines(sessionId) {
  setActiveSessionId(sessionId);
  const file = sessionPath("tasco_metrics", "tasco_compression.ndjson");
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.filter((l) => JSON.parse(l).event === "tasco_compression").length;
}

// ---------------------------------------------------------------------------
// 1. 正常压缩:before=10000, candidate=3000, delivered=3000
// ---------------------------------------------------------------------------
test("T1 normal compression: saved=7000, reduction=0.7, applied", () => {
  setActiveSessionId("s-t1");
  const logger = makeLogger();
  const payload = makePayload({
    session: "s-t1",
    toolCallId: "uid-t1",
    tool: "read_file",
    content: rawText(10000),
  });
  logger.setPayload(payload);
  logger.noteCandidate("rlm_compress", rawText(3000, "C"));
  logger.finalize({
    text: rawText(3000, "C"),
    replaceOutput: true,
    delivered: rawText(3000, "C"),
    reason: "applied",
  });

  const s = readSummary("s-t1");
  assert.equal(s.total_calls, 1);
  assert.equal(s.selected_calls, 1);
  assert.equal(s.applied_calls, 1);
  assert.equal(s.fallback_calls, 0);
  assert.equal(s.before_chars, 10000);
  assert.equal(s.delivered_chars, 3000);
  assert.equal(s.saved_chars, 7000);
  assert.ok(Math.abs(s.reduction_rate - 0.7) < 1e-9);

  // 事件本身
  setActiveSessionId("s-t1");
  const file = sessionPath("tasco_metrics", "tasco_compression.ndjson");
  const events = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.event, "tasco_compression");
  assert.equal(ev.session_id, "s-t1");
  assert.equal(ev.tool_call_id, "uid-t1");
  assert.equal(ev.tool, "read_file");
  assert.equal(ev.strategy, "rlm_compress");
  assert.equal(ev.selected, true);
  assert.equal(ev.applied, true);
  assert.equal(ev.fallback, false);
  assert.equal(ev.before_chars, 10000);
  assert.equal(ev.candidate_chars, 3000);
  assert.equal(ev.delivered_chars, 3000);
  assert.equal(ev.saved_chars, 7000);
  assert.ok(Math.abs(ev.reduction_rate - 0.7) < 1e-9);
  assert.equal(ev.token_mode, "estimated");
  // compression_id 必须是 crypto.randomUUID()(跨进程唯一)
  assert.match(
    ev.compression_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
  assert.ok(ev.timestamp);

  // 原子覆写:summary 保存后不得残留 .tmp 临时文件
  const metricsDir = path.dirname(file);
  assert.equal(
    fs.readdirSync(metricsDir).filter((f) => f.endsWith(".tmp")).length,
    0,
    "no .tmp leftover after atomic summary write"
  );
});

// ---------------------------------------------------------------------------
// 2. candidate 后 fallback:before=10000, candidate=3000, delivered=10000
// ---------------------------------------------------------------------------
test("T2 candidate then fallback: saved=0, reduction=0, fallback=true", () => {
  setActiveSessionId("s-t2");
  const logger = makeLogger();
  const raw = rawText(10000);
  const payload = makePayload({
    session: "s-t2",
    toolCallId: "uid-t2",
    tool: "read_file",
    content: raw,
  });
  logger.setPayload(payload);
  // 模拟 RLM 压缩不足被丢弃:noteCandidate 后 output() 收到空文本
  logger.noteCandidate("rlm_compress", rawText(3000, "C"));
  logger.finalize({ text: "", replaceOutput: false, delivered: raw, reason: "native" });

  const s = readSummary("s-t2");
  assert.equal(s.selected_calls, 1);
  assert.equal(s.applied_calls, 0);
  assert.equal(s.fallback_calls, 1);
  assert.equal(s.saved_chars, 0);
  assert.equal(s.reduction_rate, 0);

  setActiveSessionId("s-t2");
  const ev = JSON.parse(
    fs
      .readFileSync(sessionPath("tasco_metrics", "tasco_compression.ndjson"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)[0]
  );
  assert.equal(ev.selected, true);
  assert.equal(ev.applied, false);
  assert.equal(ev.fallback, true);
  assert.equal(ev.candidate_chars, 3000);
  assert.equal(ev.delivered_chars, 10000);
  assert.equal(ev.saved_chars, 0);
  assert.equal(ev.reduction_rate, 0);
  assert.equal(ev.reason, "candidate_discarded");
});

// ---------------------------------------------------------------------------
// 3. 无压缩:before == delivered → 收益必须为 0
// ---------------------------------------------------------------------------
test("T3 no compression: benefit must be 0", () => {
  setActiveSessionId("s-t3");
  const logger = makeLogger();
  const raw = rawText(5000);
  const payload = makePayload({
    session: "s-t3",
    toolCallId: "uid-t3",
    tool: "run_shell_command",
    content: raw,
  });
  logger.setPayload(payload);
  logger.finalize({ text: "", replaceOutput: false, delivered: raw, reason: "native" });

  const s = readSummary("s-t3");
  assert.equal(s.total_calls, 1);
  assert.equal(s.native_calls, 1);
  assert.equal(s.selected_calls, 0);
  assert.equal(s.saved_chars, 0);
  assert.equal(s.reduction_rate, 0);
});

// ---------------------------------------------------------------------------
// 4. delivered > before:不得记录正向节省
// ---------------------------------------------------------------------------
test("T4 delivered larger than before: saved=0, delta=+1000", () => {
  setActiveSessionId("s-t4");
  const logger = makeLogger();
  const raw = rawText(5000);
  const payload = makePayload({
    session: "s-t4",
    toolCallId: "uid-t4",
    tool: "run_shell_command",
    content: raw,
  });
  logger.setPayload(payload);
  logger.noteCandidate("quick_shell", rawText(4000, "C"));
  logger.finalize({
    text: rawText(4000, "C"),
    replaceOutput: true,
    delivered: rawText(6000, "D"),
    reason: "applied",
  });

  const s = readSummary("s-t4");
  assert.equal(s.selected_calls, 1);
  assert.equal(s.saved_chars, 0);
  assert.equal(s.reduction_rate, 0);

  setActiveSessionId("s-t4");
  const ev = JSON.parse(
    fs
      .readFileSync(sessionPath("tasco_metrics", "tasco_compression.ndjson"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)[0]
  );
  assert.equal(ev.saved_chars, 0);
  assert.equal(ev.reduction_rate, 0);
  assert.equal(ev.delta_chars, 1000);
});

// ---------------------------------------------------------------------------
// 5. Session 加权累计:10000→5000 + 100→10 → 10100/5010/5090 ≈ 50.4%
// ---------------------------------------------------------------------------
test("T5 session weighted accumulation (not average of rates)", () => {
  setActiveSessionId("s-t5");
  const logger = makeLogger();

  for (const [i, [before, after]] of [
    [10000, 5000],
    [100, 10],
  ].entries()) {
    const payload = makePayload({
      session: "s-t5",
      toolCallId: `uid-t5-${i}`,
      tool: "read_file",
      content: rawText(before),
    });
    logger.setPayload(payload);
    logger.noteCandidate("rlm_compress", rawText(after, "C"));
    logger.finalize({
      text: rawText(after, "C"),
      replaceOutput: true,
      delivered: rawText(after, "C"),
      reason: "applied",
    });
  }

  const s = readSummary("s-t5");
  assert.equal(s.total_calls, 2);
  assert.equal(s.selected_calls, 2);
  assert.equal(s.applied_calls, 2);
  assert.equal(s.before_chars, 10100);
  assert.equal(s.delivered_chars, 5010);
  assert.equal(s.saved_chars, 5090);
  // 5090/10100 ≈ 0.50396,绝不能是 70%
  assert.ok(Math.abs(s.reduction_rate - 5090 / 10100) < 1e-9);
  assert.ok(Math.abs(s.reduction_rate - 0.7) > 0.1);
});

// ---------------------------------------------------------------------------
// 6. fallback 不污染 Session saving
// ---------------------------------------------------------------------------
test("T6 fallback must not pollute session saving", () => {
  setActiveSessionId("s-t6");
  const logger = makeLogger();

  // applied: 10000 → 5000
  logger.setPayload(
    makePayload({ session: "s-t6", toolCallId: "uid-t6-1", tool: "read_file", content: rawText(10000) })
  );
  logger.noteCandidate("rlm_compress", rawText(5000, "C"));
  logger.finalize({
    text: rawText(5000, "C"),
    replaceOutput: true,
    delivered: rawText(5000, "C"),
    reason: "applied",
  });

  // fallback: 10000 → candidate 3000 被丢弃 → delivered 10000
  logger.setPayload(
    makePayload({ session: "s-t6", toolCallId: "uid-t6-2", tool: "read_file", content: rawText(10000) })
  );
  logger.noteCandidate("rlm_compress", rawText(3000, "C"));
  logger.finalize({ text: "", replaceOutput: false, delivered: rawText(10000), reason: "native" });

  const s = readSummary("s-t6");
  assert.equal(s.selected_calls, 2);
  assert.equal(s.applied_calls, 1);
  assert.equal(s.fallback_calls, 1);
  assert.equal(s.before_chars, 20000);
  assert.equal(s.delivered_chars, 15000);
  assert.equal(s.saved_chars, 5000); // fallback 的 saved 必须是 0
  assert.ok(Math.abs(s.reduction_rate - 0.25) < 1e-9);
});

// ---------------------------------------------------------------------------
// 7. Session A/B 隔离
// ---------------------------------------------------------------------------
test("T7 session A accumulation must not leak into session B", () => {
  setActiveSessionId("s-t7a");
  const logger = makeLogger();

  logger.setPayload(
    makePayload({ session: "s-t7a", toolCallId: "uid-t7a-1", tool: "read_file", content: rawText(10000) })
  );
  logger.noteCandidate("rlm_compress", rawText(5000, "C"));
  logger.finalize({
    text: rawText(5000, "C"),
    replaceOutput: true,
    delivered: rawText(5000, "C"),
    reason: "applied",
  });

  // Session B 尚未有任何事件
  const b0 = readSummary("s-t7b");
  assert.equal(b0.total_calls, 0);
  assert.equal(b0.before_chars, 0);
  assert.equal(b0.saved_chars, 0);

  // Session B 收到 100→10
  setActiveSessionId("s-t7b");
  logger.setPayload(
    makePayload({ session: "s-t7b", toolCallId: "uid-t7b-1", tool: "read_file", content: rawText(100) })
  );
  logger.noteCandidate("rlm_compress", rawText(10, "C"));
  logger.finalize({
    text: rawText(10, "C"),
    replaceOutput: true,
    delivered: rawText(10, "C"),
    reason: "applied",
  });

  const a = readSummary("s-t7a");
  const b = readSummary("s-t7b");
  assert.equal(a.total_calls, 1);
  assert.equal(a.before_chars, 10000);
  assert.equal(b.total_calls, 1);
  assert.equal(b.before_chars, 100);
  assert.equal(b.delivered_chars, 10);
});

// ---------------------------------------------------------------------------
// 8. telemetry 写入失败 → Tool Result 仍正常返回(fail-open)
// ---------------------------------------------------------------------------
test("T8 telemetry write failure must not block tool result", () => {
  // 用文件占位 <base>/fail-session/tasco_metrics,使 mkdirSync 失败
  setActiveSessionId("fail-session");
  const blocker = path.join(RUNTIME_ROOT, "fail-session", "tasco_metrics");
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(blocker, "block", "utf8");

  // 8a. logger 层:finalize 不抛错
  const logger = makeLogger();
  const raw = rawText(10000);
  logger.setPayload(
    makePayload({ session: "fail-session", toolCallId: "uid-fail", tool: "read_file", content: raw })
  );
  logger.noteCandidate("rlm_compress", rawText(3000, "C"));
  assert.doesNotThrow(() =>
    logger.finalize({
      text: rawText(3000, "C"),
      replaceOutput: true,
      delivered: rawText(3000, "C"),
      reason: "applied",
    })
  );

  // 8b. 真实 output() 出口:结果 JSON 仍正常打印(updatedToolOutput 交付)
  const transportLogger = makeLogger();
  const transport = makeTransport(transportLogger);
  const captured = [];
  const oldLog = console.log;
  console.log = (s) => captured.push(s);
  try {
    setActiveSessionId("fail-session");
    transport.setActivePayload(
      makePayload({ session: "fail-session", toolCallId: "uid-fail-2", tool: "read_file", content: raw })
    );
    transportLogger.setPayload(
      makePayload({ session: "fail-session", toolCallId: "uid-fail-2", tool: "read_file", content: raw })
    );
    transportLogger.noteCandidate("rlm_compress", rawText(3000, "C"));
    assert.doesNotThrow(() => transport.output(rawText(3000, "C"), true));
  } finally {
    console.log = oldLog;
  }
  assert.ok(captured.length >= 1, "output() must still print the result");
  const result = JSON.parse(captured[0]);
  assert.equal(result.hookSpecificOutput.hookEventName, "PostToolUse");
  const updated = result.hookSpecificOutput.updatedToolOutput;
  assert.ok(updated, "updatedToolOutput must be delivered despite telemetry failure");
  assert.equal(extractToolText({ tool_response: updated }).length, 3000);

  // 清理占位,避免影响后续测试
  fs.rmSync(blocker, { force: true });
});

// ---------------------------------------------------------------------------
// 9. candidate 口径:包装/裁剪前文本长度,与 delivered(交付正文)可不同
// ---------------------------------------------------------------------------
test("T9 candidate chars use pre-wrap strategy output", () => {
  setActiveSessionId("s-t9");
  const logger = makeLogger();
  const raw = rawText(20000);
  const compressedText = rawText(3000, "C"); // RLM 产出(包装前)
  const template =
    "[工具输出已压缩]\n压缩后长度: 3000 chars\n\n" + compressedText; // 实际交付正文
  logger.setPayload(
    makePayload({ session: "s-t9", toolCallId: "uid-t9", tool: "read_file", content: raw })
  );
  logger.noteCandidate("rlm_compress", compressedText);
  logger.finalize({
    text: template,
    replaceOutput: true,
    delivered: template,
    reason: "applied",
  });

  setActiveSessionId("s-t9");
  const ev = JSON.parse(
    fs
      .readFileSync(sessionPath("tasco_metrics", "tasco_compression.ndjson"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)[0]
  );
  assert.equal(ev.candidate_chars, compressedText.length);
  assert.equal(ev.delivered_chars, template.length);
  assert.notEqual(ev.candidate_chars, ev.delivered_chars);
  assert.equal(ev.saved_chars, raw.length - template.length);

  // 纯计算层口径一致性
  const c = compressionMetrics.computeEvent({
    beforeText: raw,
    candidateText: compressedText,
    deliveredText: template,
  });
  assert.equal(c.candidate_chars, compressedText.length);
  assert.equal(c.delivered_chars, template.length);
});

// ---------------------------------------------------------------------------
// 10. 缺失 session_id:事件仍完整记录(审计链保留),但绝不累计到共享
//     default 桶 —— 展示层不得把该事件计入任何真实 Session
// ---------------------------------------------------------------------------
test("T10 missing session_id: event recorded, aggregation skipped, no default bucket", () => {
  setActiveSessionId("");
  const logger = makeLogger();
  const raw = rawText(10000);
  logger.setPayload(
    makePayload({ session: "", toolCallId: "uid-noid-1", tool: "read_file", content: raw })
  );
  logger.noteCandidate("rlm_compress", rawText(5000, "C"));
  assert.doesNotThrow(() =>
    logger.finalize({
      text: rawText(5000, "C"),
      replaceOutput: true,
      delivered: rawText(5000, "C"),
      reason: "applied",
    })
  );

  // 事件仍完整记录,带 aggregation_skipped_reason 标记
  const evFile = sessionPath("tasco_metrics", "tasco_compression.ndjson");
  const ev = JSON.parse(
    fs.readFileSync(evFile, "utf8").split(/\r?\n/).filter(Boolean)[0]
  );
  assert.equal(ev.session_id, "");
  assert.equal(ev.tool_call_id, "uid-noid-1");
  assert.equal(ev.aggregation_skipped_reason, "missing_session_id");

  // 绝不累计:根目录不得出现共享 default 的 session_summary.json
  const defaultSummaryFile = path.join(RUNTIME_ROOT, "tasco_metrics", "session_summary.json");
  assert.ok(
    !fs.existsSync(defaultSummaryFile),
    "missing session_id must NOT accumulate to a shared default summary"
  );

  // 有 id 的 session 不受影响
  setActiveSessionId("s-t10x");
  const s10x = readSummary("s-t10x");
  assert.equal(s10x.total_calls, 0);
});

// ---------------------------------------------------------------------------
// 11. 同一 Session 并发更新(子进程模拟跨进程读改写,目录锁串行化)
// ---------------------------------------------------------------------------
test("T11 concurrent updates on same session are serialized by lock", () => {
  const SESSION = "concurrent-session";
  const CHILDREN = 5;
  const EVENTS_PER_CHILD = 10;
  const BEFORE = 1000;
  const AFTER = 100;

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
    tool_response: { content: "A".repeat(${BEFORE}) },
  };
  logger.setPayload(payload);
  logger.noteCandidate("rlm_compress", "C".repeat(${AFTER}));
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
  assert.equal(s.selected_calls, expected);
  assert.equal(s.applied_calls, expected);
  assert.equal(s.before_chars, expected * BEFORE);
  assert.equal(s.delivered_chars, expected * AFTER);
  assert.equal(s.saved_chars, expected * (BEFORE - AFTER));
  assert.equal(countEventLines(SESSION), expected);
});

// ---------------------------------------------------------------------------
// 12. finalize 恰好一次:同一 invocation(一次 setPayload)多次 finalize 只产一条
// ---------------------------------------------------------------------------
test("T12 at most one event per invocation", () => {
  setActiveSessionId("s-t12");
  const logger = makeLogger();
  const raw = rawText(10000);
  logger.setPayload(
    makePayload({ session: "s-t12", toolCallId: "uid-t12", tool: "read_file", content: raw })
  );
  logger.noteCandidate("rlm_compress", rawText(3000, "C"));
  logger.finalize({ text: rawText(3000, "C"), replaceOutput: true, delivered: rawText(3000, "C"), reason: "applied" });
  logger.finalize({ text: rawText(3000, "C"), replaceOutput: true, delivered: rawText(3000, "C"), reason: "applied" });
  logger.finalize({ text: rawText(3000, "C"), replaceOutput: true, delivered: rawText(3000, "C"), reason: "applied" });

  assert.equal(countEventLines("s-t12"), 1);
  const s = readSummary("s-t12");
  assert.equal(s.total_calls, 1);
  assert.equal(s.selected_calls, 1);
});

// ---------------------------------------------------------------------------
// 13. 相同 tool_call_id 重复回调:事件保留,Session 不重复累计
// ---------------------------------------------------------------------------
test("T13 duplicate tool_call_id callback must not double-accumulate", () => {
  setActiveSessionId("s-t13");
  const logger = makeLogger();
  const raw = rawText(10000);

  // 第一次回调(正常)
  logger.setPayload(
    makePayload({ session: "s-t13", toolCallId: "uid-dup", tool: "read_file", content: raw })
  );
  logger.noteCandidate("rlm_compress", rawText(3000, "C"));
  logger.finalize({ text: rawText(3000, "C"), replaceOutput: true, delivered: rawText(3000, "C"), reason: "applied" });

  // 重复回调(同 tool_call_id,新 invocation)
  logger.setPayload(
    makePayload({ session: "s-t13", toolCallId: "uid-dup", tool: "read_file", content: raw })
  );
  logger.noteCandidate("rlm_compress", rawText(3000, "C"));
  logger.finalize({ text: rawText(3000, "C"), replaceOutput: true, delivered: rawText(3000, "C"), reason: "applied" });

  // A→B→A 乱序重复:先来一个不同 id 的合法事件,再重复 uid-dup
  logger.setPayload(
    makePayload({ session: "s-t13", toolCallId: "uid-other", tool: "read_file", content: raw })
  );
  logger.noteCandidate("rlm_compress", rawText(3000, "C"));
  logger.finalize({ text: rawText(3000, "C"), replaceOutput: true, delivered: rawText(3000, "C"), reason: "applied" });

  logger.setPayload(
    makePayload({ session: "s-t13", toolCallId: "uid-dup", tool: "read_file", content: raw })
  );
  logger.noteCandidate("rlm_compress", rawText(3000, "C"));
  logger.finalize({ text: rawText(3000, "C"), replaceOutput: true, delivered: rawText(3000, "C"), reason: "applied" });

  const s = readSummary("s-t13");
  assert.equal(s.total_calls, 2, "uid-other accumulates, A→B→A repeat of uid-dup must be skipped");
  assert.equal(s.selected_calls, 2);
  assert.equal(s.applied_calls, 2);
  assert.equal(s.before_chars, 20000);

  // 事件日志:4 条 compression(uid-dup ×2, uid-other, uid-dup 重复)
  // + 2 条 duplicate 标记
  setActiveSessionId("s-t13");
  const lines = fs
    .readFileSync(sessionPath("tasco_metrics", "tasco_compression.ndjson"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const compressionEvents = lines.filter((l) => l.event === "tasco_compression");
  const markers = lines.filter((l) => l.event === "tasco_compression_duplicate_skipped");
  assert.equal(compressionEvents.length, 4);
  assert.equal(markers.length, 2, "both uid-dup repeats must produce a marker");
  assert.ok(markers.every((m) => m.tool_call_id === "uid-dup"));
});

// ---------------------------------------------------------------------------
// 14. 真实 output() 出口集成:delivered 证明
// ---------------------------------------------------------------------------
test("T14 integration: output() delivered is the real final tool result", () => {
  const captured = [];
  const oldLog = console.log;
  console.log = (s) => captured.push(s);
  try {
    // 14a. 替换接受 → delivered = replacementText
    setActiveSessionId("s-t14a");
    const loggerA = makeLogger();
    const transportA = makeTransport(loggerA);
    const rawA = rawText(10000);
    transportA.setActivePayload(
      makePayload({ session: "s-t14a", toolCallId: "uid-14a", tool: "run_shell_command", content: rawA })
    );
    loggerA.setPayload(
      makePayload({ session: "s-t14a", toolCallId: "uid-14a", tool: "run_shell_command", content: rawA })
    );
    loggerA.noteCandidate("quick_shell", rawText(3000, "C"));
    transportA.output(rawText(3000, "C"), true);
    const rA = JSON.parse(captured.pop());
    const deliveredA = extractToolText({ tool_response: rA.hookSpecificOutput.updatedToolOutput });
    assert.equal(deliveredA.length, 3000);
    const evA = JSON.parse(
      fs.readFileSync(sessionPath("tasco_metrics", "tasco_compression.ndjson"), "utf8")
        .split(/\r?\n/).filter(Boolean)[0]
    );
    assert.equal(evA.delivered_chars, 3000);
    assert.equal(evA.applied, true);
    assert.equal(evA.reason, "applied");

    // 14b. 替换被拒(节省不足)→ delivered = 原始正文,fallback
    setActiveSessionId("s-t14b");
    const loggerB = makeLogger();
    const transportB = makeTransport(loggerB);
    const rawB = rawText(10000);
    transportB.setActivePayload(
      makePayload({ session: "s-t14b", toolCallId: "uid-14b", tool: "run_shell_command", content: rawB })
    );
    loggerB.setPayload(
      makePayload({ session: "s-t14b", toolCallId: "uid-14b", tool: "run_shell_command", content: rawB })
    );
    loggerB.noteCandidate("quick_shell", rawText(9000, "C"));
    transportB.output(rawText(9000, "C"), true);
    const rB = JSON.parse(captured.pop());
    // 拒绝时不得产出 updatedToolOutput —— Claude 收到原始正文
    assert.equal(
      Object.prototype.hasOwnProperty.call(rB.hookSpecificOutput, "updatedToolOutput"),
      false,
      "rejected replacement must not be emitted"
    );
    const evB = JSON.parse(
      fs.readFileSync(sessionPath("tasco_metrics", "tasco_compression.ndjson"), "utf8")
        .split(/\r?\n/).filter(Boolean)[0]
    );
    assert.equal(evB.delivered_chars, 10000);
    assert.equal(evB.selected, true);
    assert.equal(evB.applied, false);
    assert.equal(evB.fallback, true);
    assert.equal(evB.saved_chars, 0);
    assert.equal(evB.reason, "insufficient_savings");

    // 14c. guidance → delivered = 原始正文(native)
    setActiveSessionId("s-t14c");
    const loggerC = makeLogger();
    const transportC = makeTransport(loggerC);
    const rawC = rawText(5000);
    transportC.setActivePayload(
      makePayload({ session: "s-t14c", toolCallId: "uid-14c", tool: "run_shell_command", content: rawC })
    );
    loggerC.setPayload(
      makePayload({ session: "s-t14c", toolCallId: "uid-14c", tool: "run_shell_command", content: rawC })
    );
    transportC.output("some guidance text", false);
    const rC = JSON.parse(captured.pop());
    assert.equal(rC.hookSpecificOutput.additionalContext, "some guidance text");
    const evC = JSON.parse(
      fs.readFileSync(sessionPath("tasco_metrics", "tasco_compression.ndjson"), "utf8")
        .split(/\r?\n/).filter(Boolean)[0]
    );
    assert.equal(evC.delivered_chars, 5000);
    assert.equal(evC.selected, false);
    assert.equal(evC.reason, "guidance");

    // 14d. 空文本 → delivered = 原始正文(native)
    setActiveSessionId("s-t14d");
    const loggerD = makeLogger();
    const transportD = makeTransport(loggerD);
    const rawD = rawText(8000);
    transportD.setActivePayload(
      makePayload({ session: "s-t14d", toolCallId: "uid-14d", tool: "grep_search", content: rawD })
    );
    loggerD.setPayload(
      makePayload({ session: "s-t14d", toolCallId: "uid-14d", tool: "grep_search", content: rawD })
    );
    transportD.output();
    const rD = JSON.parse(captured.pop());
    assert.equal(Object.prototype.hasOwnProperty.call(rD.hookSpecificOutput, "updatedToolOutput"), false);
    const evD = JSON.parse(
      fs.readFileSync(sessionPath("tasco_metrics", "tasco_compression.ndjson"), "utf8")
        .split(/\r?\n/).filter(Boolean)[0]
    );
    assert.equal(evD.delivered_chars, 8000);
    assert.equal(evD.selected, false);
    assert.equal(evD.reason, "native");
  } finally {
    console.log = oldLog;
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
