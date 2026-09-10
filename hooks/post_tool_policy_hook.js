const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const { mapCodeAgentToolName } = require("./guard_core/codeagent_compat");
const { sanitizeSessionId, setActiveSessionId } = require("./guard_core/state");
const {
  RUNTIME_ROOT: BASE_DIR,
  sessionPath,
} = require("./guard_core/runtime_paths");
const { createOutputArchiver } = require("./post_tool/output_archive");
const { createOutputTransport } = require("./post_tool/output_transport");
const { createContextDump } = require("./post_tool/context_dump");
const { createEditEvidence } = require("./post_tool/edit_evidence");
const { createCompressor } = require("./post_tool/compressor");
const { createStateRuntime } = require("./post_tool/state_runtime");
const { createSummaries } = require("./post_tool/summaries");
const { createTerminalStateCompressor } = require("./post_tool/terminal_state");
const { createCompressionMetrics } = require("./post_tool/observability/compression_metrics");
const { createSessionMetrics } = require("./post_tool/observability/session_metrics");
const { createMetricsLogger } = require("./post_tool/observability/metrics_logger");
const { createSearchEvidence } = require("./post_tool/search_evidence");
const {
  detectMojibake,
  buildMojibakeDroppedOutput,
} = require("./post_tool/mojibake_detect.js");
// Line-6 任务驱动 Read（CODE_GUARD_READ_COMPRESSION=1）：冻结分类器 + 五
// primitive 的纯函数编排。未设 flag 时本模块的所有 read 行为逐字节保持 legacy。
const { decideReadDelivery } = require("./post_tool/read_runtime.js");
// Line-6 Map On-Demand（R2/R3 关系事实供给）：显式 env → cache(freshness) →
// 冻结 producer 按需生成。
const { resolveOrBuildModuleMap } = require("./structural_router/map_provider.js");
const { classifyReadTask } = require("./pre_tool/read_strategy.js");

// R1-WIRING-1 修复的任务符号来源：标准 Runner / bridge 通过 env 注入任务
// 文本（CODE_GUARD_CLAUDE_PROMPT）；真实 Claude 会话（非 runner）由 bridge
// 的 UserPromptSubmit 腿把分类结果与 prompt 持久化到会话状态文件，这里作为
// fallback 读取。两者都缺失 → 空任务文本（R0 → native，不猜测）。
function resolveReadTaskText(sessionKey) {
  const envPrompt = String(process.env.CODE_GUARD_CLAUDE_PROMPT || "");
  if (envPrompt.trim()) return envPrompt;
  try {
    const safe = String(sessionKey || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const f = path.join(
      BASE_DIR,
      "context_budget",
      `claude_read_task_${safe || "unknown"}.json`
    );
    const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
    if (parsed && typeof parsed.prompt === "string" && parsed.prompt.trim()) {
      return parsed.prompt;
    }
  } catch (_e) {
    /* fail-open: 任务文本不可得 → R0 native */
  }
  return "";
}

// Line-6 R2/R3 identity map 解析（Map On-Demand，2026-09-09）：
//   显式 env（operator-owned，原样用）→ 仓内 cache（freshness = repo_head）
//   → 缺失/过期时用冻结 producer 按需生成 + 写回 cache → 失败墓碑 + null。
// 职责：map 只提供关系事实，不参与"是否 R2/R3"的判断（分类器职责）。
// 自动生成 gated：仅 READ_COMPRESSION=1 且 CODE_GUARD_READ_MAP_AUTOBUILD≠0，
// 且当前任务已被分类为 R2/R3（避免为 R1/R4/R5 读取触发全仓扫描）。
function resolveModuleMap(taskText) {
  const envMapPath = process.env.CODE_GUARD_STRUCTURAL_MAP || null;
  const readOn = process.env.CODE_GUARD_READ_COMPRESSION === "1";
  const autobuildAllowed =
    readOn && process.env.CODE_GUARD_READ_MAP_AUTOBUILD !== "0";
  let allowBuild = false;
  if (autobuildAllowed && taskText) {
    const strategy = classifyReadTask(taskText).strategy;
    allowBuild =
      strategy === "relation_evidence" || strategy === "implementation_chain";
  }
  return resolveOrBuildModuleMap({
    cwd: process.cwd(),
    envMapPath,
    allowBuild,
  });
}

const DEFAULT_STATE_FILE = path.join(BASE_DIR, "context_budget_state.json");
// 当前会话对应的状态文件;main() 解析 payload 后按 session_id 更新。
let ACTIVE_STATE_FILE = DEFAULT_STATE_FILE;

const TOOLS_DIR = process.env.CODE_GUARD_HELPER_DIR || path.join(__dirname, "tools");
const PY_COMPRESS_SCRIPT = path.join(TOOLS_DIR, "rlm_tool_compress.py");

// RLM 包目录的 venv 解释器兜底,避免系统 PATH 上没有 python 时 RLM 无法启动。
// 候选目录与 tools/rlm_tool_compress.py 保持一致:先 RLM_PACKAGE_DIR,再项目内置 rlm/。
function resolveRlmVenvPython() {
  const projectRoot = path.resolve(__dirname, "..");
  const candidates = [
    process.env.RLM_PACKAGE_DIR,
    projectRoot,
  ].filter(Boolean);
  for (const dir of candidates) {
    const venvPy = path.join(dir, ".venv", "Scripts", "python.exe");
    if (fs.existsSync(venvPy)) {
      return venvPy;
    }
  }
  return null;
}

const PYTHON_CANDIDATES = [
  process.env.GEMINI_HOOK_PYTHON,
  process.platform === "win32" ? "py" : null,
  "python",
  "python3",
  resolveRlmVenvPython(),
].filter(Boolean);

// RLM 压缩开关:默认开启;设置 CODE_GUARD_RLM_ENABLED=0/false/no/off 时,
// 大 read_file 输出跳过 RLM,直接使用快速截断回退,不再启动 Python。
function isRlmEnabled() {
  const raw = String(process.env.CODE_GUARD_RLM_ENABLED || "")
    .trim()
    .toLowerCase();
  if (raw === "") {
    return true;
  }
  return ["1", "true", "yes", "on"].includes(raw);
}

const MIN_COMPRESS_CHARS = 2000;
const HUGE_OUTPUT_CHARS = 10000;

// =========================================================
// Debug context dump
// =========================================================
const DUMP_AFTERTOOL_CONTEXT =
  process.env.GEMINI_DUMP_AFTERTOOL_CONTEXT === "1";

// 会话目录下的调试转储目录。
const getAftertoolDumpDir = () =>
  process.env.GEMINI_AFTERTOOL_DUMP_DIR ||
  sessionPath("aftertool_context_dumps");

const MAX_AFTERTOOL_DUMP_CHARS = Number(
  process.env.GEMINI_AFTERTOOL_DUMP_MAX_CHARS || "300000"
);

const MAX_TRANSCRIPT_DELTA_ENTRIES = Number(
  process.env.GEMINI_AFTERTOOL_DUMP_MAX_ENTRIES || "20"
);

const DUMP_RAW_TRANSCRIPT_JSON = process.env.GEMINI_DUMP_RAW_TRANSCRIPT_JSON === "1";

fs.mkdirSync(BASE_DIR, { recursive: true });

function log(msg) {
  const file = sessionPath("rlm_after_tool_hook.log");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `[${new Date().toISOString()}] ${msg}\n`,
    "utf8"
  );
}

// 压缩可观测性(第一阶段):统一单次压缩事件 + Session 累计。
// 所有 metrics I/O fail-open,observability failure 不影响 Tool Result 交付。
const metrics = createMetricsLogger({
  fs,
  path,
  sessionPath: (...args) => sessionPath(...args),
  log,
  extractToolText: (...args) => extractToolText(...args),
  extractToolName: (...args) => extractToolName(...args),
  compressionMetrics: createCompressionMetrics({}),
  sessionMetrics: createSessionMetrics({
    fs,
    path,
    sessionPath: (...args) => sessionPath(...args),
    log,
  }),
});

const { output, outputGuidanceOnce, setActivePayload } = createOutputTransport({
  fs,
  path,
  BASE_DIR,
  log,
  createOutputArchiver,
  extractToolText: (...args) => extractToolText(...args),
  extractToolName: (...args) => extractToolName(...args),
  loadState: (...args) => loadState(...args),
  normalizeAfterToolState: (...args) => normalizeAfterToolState(...args),
  saveState: (...args) => saveState(...args),
  metrics,
});
const { safeJsonStringify, dumpAfterToolContext } = createContextDump({
  fs,
  path,
  DUMP_AFTERTOOL_CONTEXT,
  getDumpDir: getAftertoolDumpDir,
  MAX_AFTERTOOL_DUMP_CHARS,
  MAX_TRANSCRIPT_DELTA_ENTRIES,
  normalizeAfterToolState: (...args) => normalizeAfterToolState(...args),
  loadState: (...args) => loadState(...args),
  saveState: (...args) => saveState(...args),
  log,
});
const {
  loadState,
  saveState,
  ensureObject,
  ensureArray,
  ensureNumber,
  addUniqueLimited,
  ensureSearchGovernanceState,
  normalizeAfterToolState,
  getKnownFiles,
  getKnownSymbols,
  hasKnownFiles,
  hasKnownSymbols,
  setPhaseIfForward,
  syncTopLevelEvidence,
  addUnique,
  extractResponseText,
  extractToolText,
  normalizeToolName,
  extractToolName,
  hasShellError,
} = createStateRuntime({
  fs,
  getStateFilePath: () => ACTIVE_STATE_FILE,
  log,
  safeJsonStringify: (...args) => safeJsonStringify(...args),
  mapCodeAgentToolName,
});
const {
  isReplaceFailedText,
  markReplaceFailed,
  clearReplaceFailed,
  markEditSuccessFromAfterTool,
} = createEditEvidence({
  loadState,
  saveState,
  log,
  normalizeAfterToolState,
  addUniqueLimited,
  ensureSearchGovernanceState,
  addUnique,
  ensureObject,
  setPhaseIfForward,
});
const {
  isHookPreCompressed,
  shouldSkipAfterToolCompression,
  quickShellSummary,
  quickSmartReadSummary,
  updateReadEvidenceFromOutput,
  quickGrepSummary,
  quickShellSearchSummary,
  extractReadRangesFromText,
  extractiveReadSummary,
} = createSummaries({
  normalizeToolName,
  extractCommand: (...args) => extractCommand(...args),
  hasShellError,
  isReplaceFailedText,
  loadState,
  normalizeAfterToolState,
  ensureObject,
  ensureArray,
  ensureSearchGovernanceState,
  addUnique,
  addUniqueLimited,
  syncTopLevelEvidence,
  saveState,
  log,
  extractFilePathsFromSearchText: (...args) => extractFilePathsFromSearchText(...args),
  extractLikelySymbolsFromSearchText: (...args) => extractLikelySymbolsFromSearchText(...args),
  shortenRepoPath: (...args) => shortenRepoPath(...args),
});
const {
  extractSearchQuery,
  extractCommand,
  isRepoMapCommand,
  looksLikeRepoMapSuccess,
  markRepoMapDoneFromAfterTool,
  isSearchCommand,
  extractFilePathsFromSearchText,
  shortenRepoPath,
  extractLikelySymbolsFromSearchText,
  updateSearchGovernanceFromSearchOutput,
  buildSearchPolicyContext,
} = createSearchEvidence({
  normalizeToolName,
  loadState,
  normalizeAfterToolState,
  ensureSearchGovernanceState,
  addUniqueLimited,
  ensureArray,
  ensureObject,
  ensureNumber,
  addUnique,
  syncTopLevelEvidence,
  saveState,
  log,
  getKnownFiles,
  getKnownSymbols,
  hasKnownFiles,
  hasKnownSymbols,
  hasShellError,
  setPhaseIfForward,
  extractReadRangesFromText,
});
const { fastTruncateSummary, callRlmCompress } = createCompressor({
  cp,
  PYTHON_CANDIDATES,
  PY_COMPRESS_SCRIPT,
  loadState,
  normalizeAfterToolState,
  ensureSearchGovernanceState,
  buildSearchPolicyContext,
  log,
});
// P0 Terminal-State Success Compression（实验期 primitive，Lab 阶段）。
// 纯函数模块；仅 CODE_GUARD_TERMINAL_STATE=1 时在 shell 分支启用，默认 Native。
const terminalState = createTerminalStateCompressor({});
function clampToolSummary(text, maxChars = 4000) {
  const s = String(text || "");

  if (s.length <= maxChars) {
    return s;
  }

  return (
    s.slice(0, 2500) +
    "\n\n...[AFTERTOOL_OUTPUT_TRUNCATED]...\n\n" +
    s.slice(-1200)
  );
}

/**
 * 以压缩摘要替换原始工具输出并退出。
 * 供 smart_read 压缩分支使用,行为与其它压缩分支保持一致:
 * 输出替换结果(replaceOutput=true)后正常退出。
 */
function emitCompressedResult(payload, summary) {
  const text = String(summary || "");
  const raw = extractToolText(payload);
  log(
    `smart read compressed tool=${extractToolName(payload)}, raw=${raw.length}, compressed=${text.length}`
  );
  metrics.noteCandidate("smart_read_compact", text);
  output(text, true);
  process.exit(0);
}


function extractReadRangeFromAfterPayload(payload) {
  const input =
    payload.tool_input || payload.toolInput || payload.args ||
    payload.arguments || payload.params || {};
  const file = String(
    input.file_path || input.filePath || input.path || input.filename || ""
  ).replace(/\\/g, "/").toLowerCase();
  const startLine = Number(input.start_line || input.startLine || input.offset || 0);
  let endLine = Number(input.end_line || input.endLine || 0);
  if (!endLine && input.limit) {
    endLine = startLine + Number(input.limit) - 1;
  }
  if (!file || !startLine || !endLine || endLine < startLine) return null;
  return { file, startLine, endLine };
}

function shouldCompactSmartReadOutput(text) {
  const raw = String(text || "");

  // 小输出不压缩，避免破坏正常读取
  if (raw.length <= 4000) {
    return false;
  }

  // 如果已经是精准 slice/read 输出，不压缩
  if (
    raw.includes("[READ_RANGE]") ||
    raw.includes("read_file_slice.py")
  ) {
    return false;
  }

  // 如果包含明显的修改上下文，保留原始代码
  if (
    raw.includes("old_string") ||
    raw.includes("new_string") ||
    raw.includes("safe_replace.py") ||
    raw.includes("[patch]") ||
    raw.includes("[diff]")
  ) {
    return false;
  }

  // smart_read 的长输出才压缩
  return (
    raw.includes("smart_read_file.py") ||
    raw.includes("[SMART_READ]") ||
    raw.includes("[SMART_READ_RESULT]")
  );
}

function looksLikeEditSucceeded(payload) {
  const text = JSON.stringify(payload || "").toLowerCase();

  return (
    text.includes("success") ||
    text.includes("replaced") ||
    text.includes("updated") ||
    text.includes("modified")
  );
}

function main() {
  const input = fs.readFileSync(0, "utf8");

  let payload = {};

  try {
    payload = JSON.parse(input || "{}");
    setActivePayload(payload);
  } catch (e) {
    log(`payload parse error: ${String(e)}`);
    output();
    process.exit(0);
  }
  setActiveSessionId(payload.session_id || payload.sessionId || "");
  metrics.setPayload(payload);
  log(`payload keys=${Object.keys(payload).join(",")}`);
  log(`payload preview=${JSON.stringify(payload).slice(0, 2000)}`);
  const sessionKey = sanitizeSessionId(payload.session_id || payload.sessionId);
  ACTIVE_STATE_FILE = sessionKey
    ? sessionPath("context_budget_state.json")
    : DEFAULT_STATE_FILE;
  const toolName = extractToolName(payload);
  const toolText = extractToolText(payload, toolName);
  const rawChars = toolText.length;
  // Line-6：R4 guard 位置（read_file dedup 块）产生的一次性交付决策，
  // 供下方 read_file 主分支的策略腿消费。
  let readDecision = null;

  if (!toolText) {
    log(`skip tool=${toolName}, reason=empty_output`);
    output();
    process.exit(0);
  }

  // =========================================================
  // Mojibake / encoding-corrupted output detection
  // Before any compression, summarization, or context dump,
  // check if the tool output is mojibake (encoding garbage).
  // If so, replace with a structured short notice and exit.
  // =========================================================
  const mojibakeResult = detectMojibake(toolText);
  if (mojibakeResult.mojibake) {
    const helperName = extractCommand(payload).includes("spec_read_file.py")
      ? "spec_read_file.py"
      : extractCommand(payload).includes("read_file_slice.py")
        ? "read_file_slice.py"
        : "";

    const droppedOutput = buildMojibakeDroppedOutput(
      mojibakeResult.hits,
      mojibakeResult.strongHits,
      mojibakeResult.weakHits,
      mojibakeResult.sampleChars,
      rawChars,
      { toolName, helperName }
    );

    // Structured trace log for AB experiment attribution.
    log(
      `mojibake_dropped=true ` +
      `tool=${toolName} ` +
      `helper=${helperName || "none"} ` +
      `hits=${mojibakeResult.hits} ` +
      `strongHits=${mojibakeResult.strongHits} ` +
      `weakHits=${mojibakeResult.weakHits} ` +
      `ratio=${mojibakeResult.ratio.toFixed(4)} ` +
      `original_chars=${rawChars} ` +
      `kept_chars=${droppedOutput.length}`
    );

    // Line-6 flag-gated override（CODE_GUARD_READ_COMPRESSION=1，仅 read_file）：
    // weak-only 证据（strongHits=0）按检测器自身契约只是"辅助证据"，但现行走
    // 逻辑会让 hits>=8 的纯 weak 命中丢弃整读——中文文档的常用字（功/板/強等）
    // 在 weak 名单里，实测 8085 字符真实文档被 0.15% weak ratio 误杀（R5 A/B
    // cell r5a 实证）。覆盖后进入 read runtime：R1/R5 提取逐行 verbatim，
    // 真 mojibake 字节仍会原样保留在交付中（保护损失有界）；strongHits>0 的
    // 强证据照常丢弃。flag 未设 → 逐字节 legacy。
    const readMojibakeOverride =
      toolName === "read_file" &&
      process.env.CODE_GUARD_READ_COMPRESSION === "1" &&
      mojibakeResult.strongHits === 0;

    // Also write a structured trace event file for AB analysis.
    try {
      const traceDir = path.join(BASE_DIR, "ab_trace");
      fs.mkdirSync(traceDir, { recursive: true });
      const traceEvent = {
        event: "mojibake_dropped",
        ts: new Date().toISOString(),
        tool_name: toolName,
        helper_name: helperName || "",
        read_override_weak_only: readMojibakeOverride || undefined,
        hits: mojibakeResult.hits,
        strong_hits: mojibakeResult.strongHits,
        weak_hits: mojibakeResult.weakHits,
        ratio: mojibakeResult.ratio,
        sample_chars: mojibakeResult.sampleChars,
        original_chars: rawChars,
        kept_chars: droppedOutput.length,
        session_id: payload.session_id || payload.sessionId || "",
      };
      const traceFile = path.join(traceDir, "mojibake_drop_events.jsonl");
      fs.appendFileSync(traceFile, JSON.stringify(traceEvent) + "\n", "utf8");
    } catch (e) {
      log(`mojibake trace event write error: ${String(e)}`);
    }

    if (readMojibakeOverride) {
      log(
        `mojibake weak-only override tool=${toolName}, strongHits=0, weakHits=${mojibakeResult.weakHits}, proceed_to_read_runtime`
      );
    } else {
      metrics.noteCandidate("mojibake_drop", droppedOutput);
      output(droppedOutput, true);
      process.exit(0);
    }
  }

  let dumpInfo = {};
  try {
    dumpInfo = dumpAfterToolContext(payload, toolName, toolText, rawChars);
  } catch (e) {
    log(`aftertool context dump failed tool=${toolName}, error=${String(e)}`);
  }

  log(`aftertool received tool=${toolName}, chars=${rawChars}`);

  if (dumpInfo.toolOutputDumpPath || dumpInfo.transcriptDeltaDumpPath) {
    log(
      `dump paths tool=${toolName}, tool_output=${dumpInfo.toolOutputDumpPath || ""}, transcript_delta=${dumpInfo.transcriptDeltaDumpPath || ""}`
    );
  }

  try {
    const st = normalizeAfterToolState(loadState());
    log(
      `state snapshot phase=${st.phase}, repo_map_done=${Boolean(st.phase_state?.repo_map_done)}, knownFiles=${getKnownFiles(st).length}, knownSymbols=${getKnownSymbols(st).length}`
    );
  } catch (e) {
    log(`state snapshot error=${String(e)}`);
  }

  // Must handle replace before any skip/compression-bypass logic.
  // Even short replace failure (<3000 chars) must enter recovery mode.
  if (toolName === "replace") {
    const failed = isReplaceFailedText(toolText);

    if (failed) {
      markReplaceFailed(toolText);

      const summaryText = "Replace failed. Read the latest exact 3-8 line slice, then retry Edit with a fresh stable old_string.";

      log(`replace output compressed tool=${toolName}, raw=${rawChars}, summary=${summaryText.length}, replaceOutput=true, status=failure`);
      outputGuidanceOnce(summaryText);
      process.exit(0);
    }

    clearReplaceFailed();
    markEditSuccessFromAfterTool(toolName, toolText);

    log(`replace success retained original tool=${toolName}, raw=${rawChars}, additional_context=false`);
    output();
    process.exit(0);
  }

  if (toolName === "read_file") {
    // Line-6 R4（CODE_GUARD_READ_COMPRESSION=1）：冻结 repeat_suppression
    // primitive 替换 legacy dedup hint——补充内容指纹（unchanged 才允许
    // suppress，changed 必须 refresh）与已交付 range 合并（gap 永不抑制
    // 未读行）、缺信息 fail-open deliver。主策略腿在 read_file 分支消费
    // 同一次决策（readDecision），R4 作为 delivery-level freshness guard
    // 与主策略组合（仲裁组合冻结口径：note 不含代码内容）。
    if (process.env.CODE_GUARD_READ_COMPRESSION === "1") {
      const stR4 = normalizeAfterToolState(loadState());
      const taskText = resolveReadTaskText(sessionKey);
      let rangeR4 = extractReadRangeFromAfterPayload(payload);
      // 无显式 range 的整文件读取（Claude Read 常态）：按行数推导全文件
      // range [1, lineCount]，使 R4 ledger 能覆盖整读（抑制重复整读）。
      // 行数取 tool_text 行数（对编号/非编号内容都是安全上界）。
      const r4Input = rangeR4
        ? {
            file_path: rangeR4.file,
            start_line: rangeR4.startLine,
            end_line: rangeR4.endLine,
          }
        : (() => {
            const fp = String(
              (payload.tool_input || payload.toolInput || payload.args ||
                payload.arguments || payload.params || {}).file_path ||
                (payload.tool_input || payload.toolInput || {}).path || ""
            ).replace(/\\/g, "/").toLowerCase();
            if (!fp) return null;
            const lines = toolText.split(/\r?\n/).length;
            return { file_path: fp, start_line: 1, end_line: Math.max(1, lines) };
          })();
      readDecision = decideReadDelivery({
        task_text: taskText,
        tool_input: r4Input ||
          (payload.tool_input || payload.toolInput || payload.args || payload.arguments || payload.params || {}),
        tool_text: toolText,
        previous: (stR4.after_read_deliveries &&
          stR4.after_read_deliveries[
            ((r4Input && r4Input.file_path) ||
              String((payload.tool_input || {}).file_path || "")).replace(/\\/g, "/").toLowerCase()
          ]) || null,
        module_map: resolveModuleMap(taskText),
      });
      if (readDecision.action === "suppress") {
        log(
          `[read-r4] suppress file=${readDecision.record ? readDecision.record.path : "?"} reason=${readDecision.reason} task_class=${readDecision.task_class}`
        );
        metrics.noteCandidate("read_repeat_suppression", readDecision.delivered);
        output(readDecision.delivered, true);
        process.exit(0);
      }
      if (readDecision.record) {
        stR4.after_read_deliveries = stR4.after_read_deliveries || {};
        stR4.after_read_deliveries[readDecision.record.path] = {
          path: readDecision.record.path,
          content_hash: readDecision.record.content_hash,
          ranges: readDecision.record.ranges,
          ts: Date.now(),
        };
        // ledger 有界：只保留最近 50 个文件的交付记录。
        const keys = Object.keys(stR4.after_read_deliveries);
        if (keys.length > 50) {
          for (const k of keys.sort((a, b) => (stR4.after_read_deliveries[a].ts || 0) - (stR4.after_read_deliveries[b].ts || 0)).slice(0, keys.length - 50)) {
            delete stR4.after_read_deliveries[k];
          }
        }
        saveState(stR4);
      }
      // 任务驱动的替换就地交付：guard 在 skip 检查之前运行，若在此不交付，
      // <3000 的小读取会被 small_or_low_risk 跳过、替换永远不可达
      // （A/B r3a 实证：2399 字符入口读取被判 replace 后遭 skip 丢弃）。
      if (readDecision.action === "replace" && readDecision.delivered && readDecision.delivered.length < toolText.length) {
        log(
          `read runtime applied (guard) tool=${toolName}, raw=${rawChars}, delivered=${readDecision.delivered.length}, strategy=${readDecision.strategy}, task_class=${readDecision.task_class}, reason=${readDecision.reason}`
        );
        metrics.noteCandidate(`read_${readDecision.strategy}`, readDecision.delivered);
        output(readDecision.delivered, true);
        process.exit(0);
      }
      log(
        `[read-r4] guard action=${readDecision.action} strategy=${readDecision.strategy} task_class=${readDecision.task_class} reason=${readDecision.reason}`
      );
    } else {
    // 第六阶段：重复读取检测。after 侧独立维护 after_read_history：
    // 首次读取记录并正常返回，后续相同 file+range 输出短提示。
    const st = normalizeAfterToolState(loadState());
    const range = extractReadRangeFromAfterPayload(payload);
    if (range) {
      st.after_read_history = st.after_read_history || [];
      const editBlocks = st.recent_edit_blocks || {};
      const editedRecently = Object.keys(editBlocks).some(
        (k) => String(k).replace(/\\/g, "/").toLowerCase() === range.file
      );
      const isRepeat = !editedRecently &&
        st.after_read_history.some(
          (h) =>
            h.file === range.file &&
            Number(h.startLine) === range.startLine &&
            Number(h.endLine) === range.endLine
        );
      if (isRepeat) {
        log(
          `[dedup] duplicate read replaced with short hint file=${range.file} ` +
          `range=${range.startLine}-${range.endLine}`
        );
        const dedupHint =
          "Already retrieved earlier result. Use the earlier content; avoid repeated full reads.";
        metrics.noteCandidate("dedup_read", dedupHint);
        output(dedupHint, true);
        process.exit(0);
      }
      st.after_read_history.push({
        file: range.file,
        startLine: range.startLine,
        endLine: range.endLine,
        ts: Date.now(),
      });
      st.after_read_history = st.after_read_history.slice(-500);
      saveState(st);
    } else {
      log("[dedup] no explicit range for read_file, skip dedup");
    }
    }
  }

  if (shouldSkipAfterToolCompression(toolName, toolText)) {

    if (toolName === "run_shell_command") {
      const command = extractCommand(payload);

      if (isRepoMapCommand(command) && looksLikeRepoMapSuccess(toolText)) {
        markRepoMapDoneFromAfterTool(command, toolText);
        output("");
        process.exit(0);
      }

      if (
        command.includes("smart_read_file.py") ||
        command.includes("read_file_slice.py")
      ) {
        updateReadEvidenceFromOutput(payload, toolName, toolText);
        output("");
        process.exit(0);
      }

      if (
        command.includes("safe_replace.py") &&
        !isReplaceFailedText(toolText) &&
        looksLikeEditSucceeded(toolText)
      ) {
        markEditSuccessFromAfterTool("safe_replace.py", toolText);
        output("");
        process.exit(0);
      }

      if (
        command.includes("safe_replace.py") &&
        isReplaceFailedText(toolText)
      ) {
        markReplaceFailed(toolText);
        output("");
        process.exit(0);
      }
    }

    // 小 grep / 小 shell search 虽然不压缩，但仍然要记录 knownFiles/knownSymbols。
    if (toolName === "grep_search") {
      const sg = updateSearchGovernanceFromSearchOutput(payload, toolName, toolText);

      log(
        `small grep evidence updated before skip tool=${toolName}, raw=${rawChars}, score=${sg.targetEvidenceScore}`
      );

      output();
      process.exit(0);
    }

    if (toolName === "run_shell_command" && isSearchCommand(extractCommand(payload))) {
      const sg = updateSearchGovernanceFromSearchOutput(payload, toolName, toolText);

      log(
        `small shell search evidence updated before skip raw=${rawChars}, score=${sg.targetEvidenceScore}`
      );

      output();
      process.exit(0);
    }

    log(`skip tool=${toolName}, reason=small_or_low_risk, chars=${rawChars}`);
    output();
    process.exit(0);
  }

  if (toolName === "read_file") {
    updateReadEvidenceFromOutput(payload, toolName, toolText);

    log(
      `small read_file evidence updated before skip raw=${rawChars}`
    );

    // Continue into the size threshold and RLM replacement path below.
  }

  if (toolName === "grep_search") {
    const sg = updateSearchGovernanceFromSearchOutput(payload, toolName, toolText);
    const summary = quickGrepSummary(toolName, toolText);
    // 透明治理：hook 内部状态（SEARCH_POLICY_ACTIVE / known_files / phase）
    // 不再注入模型可见输出。
    const finalContext = summary;

    log(
      `quick grep summary tool=${toolName}, raw=${rawChars}, compressed=${finalContext.length}, score=${sg.targetEvidenceScore}`
    );

    metrics.noteCandidate("quick_grep", finalContext);
    output(finalContext, true);
    process.exit(0);
  }

  if (rawChars < MIN_COMPRESS_CHARS) {
    log(`skip tool=${toolName}, reason=short_output, chars=${rawChars}`);
    output();
    process.exit(0);
  }


  if (toolName === "run_shell_command") {
    const SHELL_FORCE_SUMMARY_CHARS = 3000;
    const command = extractCommand(payload);
    const isShellSearch = isSearchCommand(command);

    if (isRepoMapCommand(command) && looksLikeRepoMapSuccess(toolText)) {
      markRepoMapDoneFromAfterTool(command, toolText);
    }

    const isHelperCommand =
      command.includes("smart_read_file.py") ||
      command.includes("spec_read_file.py") ||
      command.includes("read_file_slice.py") ||
      command.includes("repo_map.py") ||
      command.includes("safe_replace.py");

    if (
      command.includes("smart_read_file.py") ||
      command.includes("read_file_slice.py")
    ) {
      updateReadEvidenceFromOutput(payload, toolName, toolText);
    }

    if (
      command.includes("safe_replace.py") &&
      !isReplaceFailedText(toolText) &&
      looksLikeEditSucceeded(toolText)
    ) {
      markEditSuccessFromAfterTool("safe_replace.py", toolText);
    }


    if (
      toolName === "run_shell_command" &&
      toolText.includes("smart_read_file.py") &&
      shouldCompactSmartReadOutput(toolText)
    ) {
      const summary = quickSmartReadSummary(toolText);

      if (summary && summary.length < toolText.length) {
        return emitCompressedResult(payload, summary);
      }
    }

    // P0 Terminal-State Success Compression（实验期 primitive）。
    // 仅对「明确成功终态」的 test/build 输出做提取式压缩：summary / counts /
    // warning / skipped·pending / artifact 逐行 verbatim 保留，逐 case PASS 与
    // 构建过程行省略。失败 / 未知终态 / 无节省一律不介入，走既有分支。
    // 保留合同：METRICS-CONTRACT-V1 §7。
    const tsAuto = process.env.CODE_GUARD_TERMINAL_STATE === "1";
    const tsShadow = process.env.CODE_GUARD_TERMINAL_STATE_SHADOW === "1";
    if (tsAuto || tsShadow) {
      const shadowMode = tsShadow && !tsAuto; // auto wins; both-on guarded invalid upstream
      const tsSummary = terminalState.tryCompressSuccessTerminal({
        toolName,
        command,
        text: toolText,
      });

      if (tsSummary) {
        if (shadowMode) {
          // Shadow: classify + account through the REAL chain, but NEVER
          // replace the delivered output (actual_delivery = native). Rows go
          // to tasco_shadow.ndjson - a separate bucket from actual
          // tasco_compression / session_summary accounting (Stage 0 Metrics
          // Contract untouched; projected savings never become actual).
          const shadowRow = {
            event: "terminal_state_shadow",
            mode: "shadow",
            tool: toolName,
            command: String(command).slice(0, 200),
            eligible: true,
            would_select: true,
            would_apply: true,
            shadow_candidate_chars: tsSummary.length,
            shadow_delivered_chars: rawChars,
            shadow_projected_saved_chars: rawChars - tsSummary.length,
            actual_delivery: "native",
            reason_code: "ok",
          };
          try {
            const p = sessionPath("tasco_metrics/tasco_shadow.ndjson");
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.appendFileSync(p, `${JSON.stringify(shadowRow)}\n`, "utf8");
          } catch (_e) { /* fail-open: observability never blocks delivery */ }
          log(
            `terminal_state_shadow would_apply tool=${toolName}, raw=${rawChars}, candidate=${tsSummary.length}, projected_saved=${rawChars - tsSummary.length}`
          );
          output();
          process.exit(0);
        }
        log(
          `terminal_state_success compressed tool=${toolName}, raw=${rawChars}, compressed=${tsSummary.length}, command=${String(command).slice(0, 200)}`
        );
        metrics.noteCandidate("terminal_state_success", tsSummary);
        output(tsSummary, true);
        process.exit(0);
      }
      // Terminal-capability dispatch mode (adapter integration 2026-09-04):
      // this event was forwarded by claude_bridge only to consult the frozen
      // terminal-state classifier. If it declined (failure/unknown/no saving),
      // exit native here instead of falling through to quick_shell etc., so
      // the dispatch adds ONLY terminal semantics - no other policy branch
      // becomes reachable through the new leg.
      if (process.env.CODE_GUARD_TERMINAL_DISPATCH === "1") {
        // Shadow also records the declined decision for validation-shaped
        // commands (funnel eligibility explanation).
        if (shadowMode && terminalState.classifyCommand(command)) {
          const reason =
            terminalState.detectTerminalState(toolText, terminalState.classifyCommand(command)) === "failure"
              ? "failed_validation"
              : "unknown_or_no_saving";
          const declineRow = {
            event: "terminal_state_shadow",
            mode: "shadow",
            tool: toolName,
            command: String(command).slice(0, 200),
            eligible: false,
            would_select: false,
            would_apply: false,
            shadow_candidate_chars: null,
            shadow_delivered_chars: rawChars,
            shadow_projected_saved_chars: 0,
            actual_delivery: "native",
            reason_code: reason,
          };
          try {
            const p = sessionPath("tasco_metrics/tasco_shadow.ndjson");
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.appendFileSync(p, `${JSON.stringify(declineRow)}\n`, "utf8");
          } catch (_e) { /* fail-open */ }
        }
        log(
          `terminal_dispatch native exit tool=${toolName}, raw=${rawChars}, reason=terminal_not_applicable`
        );
        output();
        process.exit(0);
      }
    }


    if (isShellSearch) {
      const sg = updateSearchGovernanceFromSearchOutput(payload, toolName, toolText);

      log(
        `shell search evidence updated raw=${rawChars}, score=${sg.targetEvidenceScore}, command=${String(command).slice(0, 300)}`
      );
    }

    if (rawChars >= SHELL_FORCE_SUMMARY_CHARS || isHelperCommand || isShellSearch) {
      const summary = isShellSearch
        ? quickShellSearchSummary(toolName, toolText)
        : quickShellSummary(toolName, toolText);

      const finalContext = summary;

      log(
        `quick shell summary tool=${toolName}, reason=${isShellSearch ? "shell_search" : "large_output"}, raw=${rawChars}, compressed=${finalContext.length}`
      );

      metrics.noteCandidate(isShellSearch ? "quick_shell_search" : "quick_shell", finalContext);
      output(finalContext, true);
      process.exit(0);
    }

    if (hasShellError(toolText)) {
      const summary = quickShellSummary(toolName, toolText);
      const finalContext = summary;

      log(
        `quick shell summary tool=${toolName}, reason=has_error, raw=${rawChars}, compressed=${finalContext.length}`
      );
      metrics.noteCandidate("quick_shell_error", finalContext);
      output(finalContext, true);
      process.exit(0);
    }

    log(
      `skip shell tool=${toolName}, reason=small_and_no_error, chars=${rawChars}`
    );
    output();
    process.exit(0);
  }

  // =========================================================
  // invoke_agent / subagent result compression
  // Sub-agent returns full tool chain execution report (file paths,
  // symbol tables, directory structures, analysis text).
  // Compress to a structured summary preserving key findings.
  // =========================================================
  if (toolName === "invoke_agent" || toolName.includes("subagent")) {
    if (rawChars < 2000) {
      log(`skip invoke_agent compression, reason=small_output, chars=${rawChars}`);
      output();
      process.exit(0);
    }

    // Extract sub-agent name from payload
    const agentName =
      payload.tool_input?.agent_name ||
      payload.toolInput?.agent_name ||
      payload.tool_input?.agentName ||
      payload.toolInput?.agentName ||
      payload.args?.agent_name ||
      payload.args?.agentName ||
      "unknown_agent";

    const text = toolText;
    const lines = text.split(/\r?\n/);
    const cleanLines = lines.map(l => l.trim()).filter(Boolean);

    // Structured extraction patterns
    const files = new Set();
    const symbols = new Set();
    const dirs = new Set();
    const keyFindings = [];
    const errorLines = [];

    for (const line of cleanLines) {
      // Extract file paths (absolute Windows paths or relative paths with extensions)
      const fileMatches = line.match(/([A-Za-z]:\\\\(?:[^\\s:"]+\\\\)*[^\\s:"]+\.\w{1,4})/g);
      if (fileMatches) {
        for (const f of fileMatches) {
          if (/\.(c|cc|cpp|cxx|h|hpp|hh|py|js|ts|java|go|rs|md|txt|proto|cmake|json|yaml|yml|toml|ini|cfg|conf|xml|sh|bat|ps1|sql)$/i.test(f)) {
            files.add(f.replace(/[)";,]+$/, ""));
          }
        }
      }

      // Extract code symbols (CamelCase, UPPER_CASE, snake_case identifiers)
      const symbolMatches = line.match(/\b[A-Z][A-Za-z0-9_]{3,}\b/g);
      if (symbolMatches) {
        for (const s of symbolMatches) {
          if (!/^(The|This|That|With|From|File|Path|Name|Type|Size|Data|Info|Error|Warning|Note|True|False|None)$/i.test(s)) {
            symbols.add(s);
          }
        }
      }

      // Extract directory paths
      const dirMatches = line.match(/([A-Za-z]:\\\\(?:[^\\s:"]+\\)+)/g);
      if (dirMatches) {
        for (const d of dirMatches) {
          dirs.add(d.replace(/[)";,]+$/, ""));
        }
      }

      // Capture error/important lines
      if (/(?:error|fail|exception|traceback|not found|denied|blocked)/i.test(line) && line.length < 300) {
        errorLines.push(line.slice(0, 240));
      }

      // Capture section headers or summary lines (short, meaningful lines)
      if (line.length > 20 && line.length < 200 && !line.startsWith(" ") && !line.startsWith("\t")) {
        if (/^[A-Z#*\-]/.test(line) || /:\s*$/.test(line)) {
          keyFindings.push(line.slice(0, 240));
        }
      }
    }

    // Build compressed summary
    const parts = [];

    parts.push(`[INVOKE_AGENT_COMPRESSED]`);
    parts.push(`agent: ${agentName}`);
    parts.push(`raw_chars: ${rawChars}`);

    if (files.size > 0) {
      const fileList = Array.from(files).slice(0, 30);
      parts.push(`\nfiles (${files.size} total, showing ${fileList.length}):`);
      for (const f of fileList) {
        parts.push(`  ${f}`);
      }
      if (files.size > 30) {
        parts.push(`  ... and ${files.size - 30} more files`);
      }
    }

    if (symbols.size > 0) {
      const symbolList = Array.from(symbols).slice(0, 40);
      parts.push(`\nsymbols (${symbols.size} total, showing ${symbolList.length}):`);
      // Group symbols by prefix for compact display
      const grouped = {};
      for (const s of symbolList) {
        const prefix = s.slice(0, 4);
        if (!grouped[prefix]) grouped[prefix] = [];
        grouped[prefix].push(s);
      }
      for (const [prefix, syms] of Object.entries(grouped)) {
        parts.push(`  ${prefix}...: ${syms.join(", ")}`);
      }
      if (symbols.size > 40) {
        parts.push(`  ... and ${symbols.size - 40} more symbols`);
      }
    }

    if (dirs.size > 0) {
      const dirList = Array.from(dirs).slice(0, 15);
      parts.push(`\ndirectories explored (${dirList.length} shown):`);
      for (const d of dirList) {
        parts.push(`  ${d}`);
      }
    }

    if (keyFindings.length > 0) {
      parts.push(`\nkey_findings (${keyFindings.length} items):`);
      for (const f of keyFindings.slice(0, 20)) {
        parts.push(`  - ${f}`);
      }
    }

    if (errorLines.length > 0) {
      parts.push(`\nerrors (${errorLines.length}):`);
      for (const e of errorLines.slice(0, 10)) {
        parts.push(`  ! ${e}`);
      }
    }

    // Include first and last meaningful lines for context
    const bodyLines = cleanLines.filter(l => l.length > 30);
    if (bodyLines.length > 0) {
      parts.push(`\nhead_tail_snippet:`);
      for (const h of bodyLines.slice(0, 5)) {
        parts.push(`  > ${h.slice(0, 200)}`);
      }
      if (bodyLines.length > 10) {
        parts.push(`  ... (${bodyLines.length - 10} lines omitted)`);
        for (const t of bodyLines.slice(-5)) {
          parts.push(`  > ${t.slice(0, 200)}`);
        }
      }
    }

    const summary = parts.join("\n");

    log(
      `invoke_agent compressed agent=${agentName}, raw=${rawChars}, compressed=${summary.length}, files=${files.size}, symbols=${symbols.size}, errors=${errorLines.length}`
    );

    metrics.noteCandidate("invoke_agent_extract", summary);
    output(clampToolSummary(summary), true);
    process.exit(0);
  }

  if (toolName === "read_file") {
    const READ_FILE_RLM_MIN_CHARS = 8000;
    updateReadEvidenceFromOutput(payload, toolName, toolText);

    // Line-6 主策略腿（CODE_GUARD_READ_COMPRESSION=1）：read_file 分支由
    // read_runtime 决策接管——R1 任务派生符号提取（R1-WIRING-1 修复点，
    // 不再依赖首读为空的 session symbols）/ R2 关系边 / R3 实现链 / R5
    // 章节，全部 fail-closed（无任务符号、map 缺失、无节省 → native 原文）。
    // R4 suppress 已在 guard 位置交付；这里处理 replace 与 native。
    if (process.env.CODE_GUARD_READ_COMPRESSION === "1") {
      const d = readDecision || {
        action: "native",
        strategy: "native",
        task_class: "R0_unclassified",
        reason: "no_read_decision",
      };
      if (d.action === "replace" && d.delivered && d.delivered.length < rawChars) {
        log(
          `read runtime applied tool=${toolName}, raw=${rawChars}, delivered=${d.delivered.length}, strategy=${d.strategy}, task_class=${d.task_class}, reason=${d.reason}`
        );
        metrics.noteCandidate(`read_${d.strategy}`, d.delivered);
        output(d.delivered, true);
        process.exit(0);
      }
      log(
        `read runtime native tool=${toolName}, raw=${rawChars}, strategy=${d.strategy}, task_class=${d.task_class}, reason=${d.reason}`
      );
      output();
      process.exit(0);
    }

    if (rawChars < READ_FILE_RLM_MIN_CHARS) {
      log(
        `skip rlm for read_file, reason=read_file_not_large_enough, chars=${rawChars}, threshold=${READ_FILE_RLM_MIN_CHARS}`
      );
      output();
      process.exit(0);
    }

    if (!isRlmEnabled()) {
      log(
        `skip rlm for read_file, reason=disabled_by_config, chars=${rawChars}, threshold=${READ_FILE_RLM_MIN_CHARS}`
      );
      const fallback = fastTruncateSummary(toolName, toolText);
      metrics.noteCandidate("fast_truncate", fallback);
      if (fallback.length < rawChars) {
        output(fallback, true);
      } else {
        output();
      }
      process.exit(0);
    }

    const textForRlm = toolText;

    // P2: Selective/Extractive Read v1（CODE_GUARD_EXTRACTIVE_READ=1）：
    // 用机械筛选的原始代码片段替代 RLM 语义摘要（lexical fidelity 100%）。
    if (process.env.CODE_GUARD_EXTRACTIVE_READ === "1") {
      const st = normalizeAfterToolState(loadState());
      const extracted = extractiveReadSummary(textForRlm, getKnownSymbols(st));
      log(
        `extractive read tool=${toolName}, raw=${rawChars}, extracted=${extracted.length}`
      );
      metrics.noteCandidate("extractive_read", extracted);
      output(clampToolSummary(extracted), true);
      process.exit(0);
    }

    log(
      `rlm compress start tool=${toolName}, raw=${rawChars}, input=${textForRlm.length}`
    );

    const compressedResult = callRlmCompress(toolName, textForRlm);

    if (
      compressedResult &&
      compressedResult.compressed &&
      compressedResult.reason !== "compress_failed"
    ) {
      const compressedText = String(compressedResult.compressed);
      const compressedChars =
        compressedResult.compressed_chars || compressedText.length;
      if (compressedChars >= rawChars * 0.8) {
        log(
          `discard compressed result tool=${toolName}, reason=not_smaller_enough, raw=${rawChars}, compressed=${compressedChars}`
        );
        // candidate 已生成但被丢弃 → output() 为空文本;先打点候选,
        // 使事件记为 selected=true / fallback=true,而非 native。
        metrics.noteCandidate("rlm_compress", compressedText);
        output();
        process.exit(0);
      }
      const summary = `
  [工具输出已压缩 / RLM Compressed Summary]
  
  工具名称: ${toolName}
  原始长度: ${rawChars} chars
  送入 RLM 长度: ${textForRlm.length} chars
  压缩后长度: ${compressedChars} chars
  
  压缩摘要:
  ${compressedText}
  
  READ_FILE_COMPRESSED_POLICY:
  Do not compensate compressed read_file output by reading the next sequential chunk.
  Use exact symbols, smart_read_file.py, or read_file_slice.py around known target lines.
  Do not continue reading the whole file in order.
  `.trim();

      log(
        `rlm compress success tool=${toolName}, raw=${rawChars}, input=${textForRlm.length}, compressed=${compressedChars}`
      );

      // Use replaceOutput=true so the compressed summary replaces the original tool output
      // instead of being appended alongside it. This makes RLM compression effective.
      metrics.noteCandidate("rlm_compress", compressedText);
      output(clampToolSummary(summary), true);
      process.exit(0);
    }

    log(`rlm compress failed, fallback fast truncate tool=${toolName}`);

    const fallback = fastTruncateSummary(toolName, toolText);
    metrics.noteCandidate("fast_truncate", fallback);
    if (fallback.length < rawChars) {
      output(fallback, true);
    } else {
      output();
    }
    process.exit(0);
  }

  if (rawChars >= HUGE_OUTPUT_CHARS) {
    const summary = fastTruncateSummary(toolName, toolText);
    log(
      `unknown tool fast truncate tool=${toolName}, raw=${rawChars}, compressed=${summary.length}`
    );
    metrics.noteCandidate("fast_truncate", summary);
    output(clampToolSummary(summary), true);
    process.exit(0);
  }

  log(`skip tool=${toolName}, reason=unknown_tool_not_large, chars=${rawChars}`);
  output();
  process.exit(0);
}

main();
