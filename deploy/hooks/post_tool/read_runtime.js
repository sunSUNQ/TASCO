"use strict";

// ============================================================================
// post_tool/read_runtime.js — Line-6 Read Runtime Integration orchestrator
// ============================================================================
// 纯函数编排（除注入的 hash 外无 I/O、确定性）。把冻结的分类器
// (pre_tool/read_strategy.js) 与五个冻结 primitive 组合为一次 read_file
// 交付决策：
//
//   1. R4 freshness guard（delivery-level，与主策略可组合）：
//      unchanged + covered → suppress（note，不含代码内容，可审计）；
//      changed → refresh；new range → deliver_unseen；缺信息 → deliver。
//   2. 主策略腿（按 classifyReadTask 冻结映射）：
//      R1 extractive_read      → extractiveReadSummary(tool_text, taskSymbols)
//                                （R1-WIRING-1：符号来自任务文本，而非
//                                  session state——首读 session symbols 为空
//                                  的缺口在此修复）
//      R2 relation_evidence    → buildRelationEvidence（边全部来自 map）
//      R3 implementation_chain → buildImplementationChain（cycle-safe 链）
//      R5 section_extraction   → extractRelevantSections（章节 verbatim）
//      R0 / 无法解析 / 无节省 → native（完整原文，不猜测）
//
// 铁律：
//   - 任一 primitive 返回 null / 无节省 → native（fail-closed，绝不猜测）；
//   - suppress note 不含任何代码内容（仲裁组合测试冻结口径）；
//   - 本模块不读 env、不读文件——任务文本 / map / 状态由调用方注入；
//   - 未触发任何转换时 action="native"，调用方原样交付并记录 R4 ledger。
// ============================================================================

const crypto = require("crypto");

const { classifyReadTask } = require("../pre_tool/read_strategy.js");
const { extractSymbols, extractConceptTerms } = require("../pre_tool/search_guidance.js");
const { extractiveReadSummary } = require("./summaries.js").createSummaries({});
const {
  decideRepeatRead,
  mergeRanges,
} = require("./read_repeat_suppression.js");
const { buildRelationEvidence } = require("../structural_router/read_relation_evidence.js");
const { buildImplementationChain } = require("../structural_router/read_implementation_chain.js");
const { extractRelevantSections } = require("./read_section_extraction.js");

function contentHash(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

// R1 输入 canon 适配：真实 Claude 会话中 read_file 的 tool_text 是**未编号
// 的文件原文**（.code-guard tool_output_archive 实证），而冻结 R1 primitive
// 的输入契约是 `<path>` + "N: line" 编号格式。检测不到编号行时确定性补
// 编号（行号 = 文件行号，模型可见且可引用）。已编号（legacy runtime 格式）
// 的输入逐字节透传。
function canonicalReadText(raw, filePath) {
  const text = String(raw || "");
  if (!text.trim()) return text;
  if (/^\s*\d+:\s/m.test(text)) return text;
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const header = filePath ? `<path>${filePath}</path>\n` : "";
  return `${header}${lines.map((l, i) => `${i + 1}: ${l}`).join("\n")}\n`;
}

// R5 词项：任务文本中的标识符/文件名（extractSymbols）+ 概念词
// （extractConceptTerms，英文裸词去停用词）。只剔除路径的目录段；文件名
// （含扩展名的末段）是合法词项——R5 任务点名文档文件本身。
function taskTerms(taskText) {
  const dirSegments = new Set();
  for (const hint of String(taskText || "").match(/\b(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\b/g) || []) {
    const segs = String(hint).split(/[\\/]/).filter(Boolean);
    for (const seg of segs.slice(0, -1)) dirSegments.add(seg);
  }
  const symbols = extractSymbols(taskText).filter((s) => !dirSegments.has(s));
  const seen = new Set(symbols.map((s) => s.toLowerCase()));
  const terms = [...symbols];
  for (const t of extractConceptTerms(taskText)) {
    if (seen.has(String(t).toLowerCase())) continue;
    seen.add(String(t).toLowerCase());
    terms.push(t);
    if (terms.length >= 12) break;
  }
  return terms;
}

/**
 * 一次 read_file 交付决策。
 *
 * @param {object} input
 * @param {string} input.task_text        任务文本（prompt）；空 = R0
 * @param {object} input.tool_input       { file_path|path, start_line|offset, end_line|limit }
 * @param {string} input.tool_text        read 工具原始输出（模型可见全文）
 * @param {object|null} input.previous    R4 ledger：{ path, content_hash, ranges } | null
 * @param {object|string|null} input.module_map R2/R3 identity map（JSON 文本或对象；null = 不可用）
 * @returns {object} decision
 *   task_class / strategy      冻结映射结果
 *   action                     "suppress" | "replace" | "native"
 *   delivered                  替换文本（action=replace/suppress 时非空）
 *   record                     R4 ledger 更新 { path, content_hash, ranges }（null = 不记）
 *   reason                     决策原因（遥测/审计用，确定性）
 */
function decideReadDelivery({ task_text, tool_input, tool_text, previous, module_map } = {}) {
  const raw = String(tool_text || "");
  const input = tool_input || {};
  const filePath = String(
    input.file_path || input.filePath || input.path || input.filename || ""
  ).replace(/\\/g, "/");
  const startLine = Number(input.start_line || input.startLine || input.offset || 0);
  let endLine = Number(input.end_line || input.endLine || 0);
  if (!endLine && input.limit) endLine = startLine + Number(input.limit) - 1;
  const hash = contentHash(raw);
  const hasRange = Number.isFinite(startLine) && Number.isFinite(endLine) && endLine >= startLine && startLine >= 1;
  const record = filePath
    ? {
        path: filePath,
        content_hash: hash,
        ranges: hasRange ? mergeRanges([...((previous && previous.path === filePath && previous.ranges) || []), [startLine, endLine]]) : [],
      }
    : null;

  const task = classifyReadTask(task_text);
  const base = { task_class: task.task_class, strategy: task.strategy };

  // ---- R4 freshness guard（delivery-level，先于主策略；changed 永不 suppress）
  const r4 = decideRepeatRead({
    previous,
    request: {
      path: filePath,
      start_line: hasRange ? startLine : undefined,
      end_line: hasRange ? endLine : undefined,
      content_hash: hash,
    },
  });
  if (r4.action === "suppress") {
    return {
      ...base,
      action: "suppress",
      delivered: r4.note,
      record,
      reason: `r4_suppress:${r4.reason}`,
    };
  }

  // ---- 主策略腿（R4 primary 无内容变换 → native passthrough，ledger 已更新）
  if (task.suppressed || task.strategy === "native") {
    return { ...base, action: "native", delivered: null, record, reason: `native:${task.reason}` };
  }

  // ---- R4 primary 无内容变换：suppress 已在上方处理，refresh / unseen /
  // ---- 不同文件一律 native passthrough（交付原文，ledger 已更新）。
  if (task.strategy === "repeat_suppression") {
    return { ...base, action: "native", delivered: null, record, reason: `r4_${r4.action}` };
  }

  if (task.strategy === "extractive_read") {
    const symbols = extractSymbols(task_text);
    if (!symbols.length) {
      return { ...base, action: "native", delivered: null, record, reason: "r1_no_task_symbols" };
    }
    // fail-closed：任务符号一个都不在所读**正文**（剔除 <path> 行；目录名
    // 等路径线索不算命中）中出现 → 提取不可能任务驱动（primitive 会回退
    // keep-first 通用截断）→ native。
    const bodyLower = raw.replace(/<path>.*?<\/path>/g, "").toLowerCase();
    const matchedSymbols = symbols.filter((s) => bodyLower.includes(String(s).toLowerCase()));
    if (!matchedSymbols.length) {
      return { ...base, action: "native", delivered: null, record, reason: "r1_task_symbols_absent_in_file" };
    }
    const extracted = extractiveReadSummary(canonicalReadText(raw, filePath), symbols);
    if (!extracted || extracted.length >= raw.length) {
      return { ...base, action: "native", delivered: null, record, reason: "r1_no_saving" };
    }
    return { ...base, action: "replace", delivered: extracted, record, reason: "r1_task_symbols_extraction" };
  }

  if (task.strategy === "relation_evidence" || task.strategy === "implementation_chain") {
    const built =
      task.strategy === "relation_evidence"
        ? buildRelationEvidence({ task_text, module_map, task_class: "R2" })
        : buildImplementationChain({ task_text, module_map, task_class: "R3" });
    if (!built) {
      return { ...base, action: "native", delivered: null, record, reason: `${task.strategy}_unresolved` };
    }
    // 作用域守卫：边证据只转换**任务入口文件本身**的读取。agent 顺藤读
    // 下游文件时，那些读取必须保持 Native（把 callee 原文换成入口边是
    // 语义劫持——A/B r2a 实证 3 连替换）。Claude Read 的 tool_input 是
    // 绝对路径，与 map 的 repo-relative entry 按 "/<entry>" 后缀匹配。
    const entryNorm = String(built.entry_path || "").replace(/\\/g, "/").toLowerCase();
    const fileNorm = filePath.toLowerCase();
    const matchesEntry =
      entryNorm && (fileNorm === entryNorm || fileNorm.endsWith(`/${entryNorm}`));
    if (!matchesEntry) {
      return { ...base, action: "native", delivered: null, record, reason: `${task.strategy}_file_mismatch` };
    }
    if (built.text.length >= raw.length) {
      return { ...base, action: "native", delivered: null, record, reason: `${task.strategy}_no_saving` };
    }
    return {
      ...base,
      action: "replace",
      delivered: built.text,
      record,
      reason: `${task.strategy}_map_evidence`,
    };
  }

  if (task.strategy === "section_extraction") {
    const terms = taskTerms(task_text);
    if (!terms.length) {
      return { ...base, action: "native", delivered: null, record, reason: "r5_no_task_terms" };
    }
    const extracted = extractRelevantSections({ text: raw, task_terms: terms });
    if (!extracted || extracted.text.length >= raw.length) {
      return { ...base, action: "native", delivered: null, record, reason: "r5_no_saving" };
    }
    return { ...base, action: "replace", delivered: extracted.text, record, reason: "r5_section_extraction" };
  }

  return { ...base, action: "native", delivered: null, record, reason: "native_unhandled_strategy" };
}

module.exports = { decideReadDelivery, contentHash, taskTerms, canonicalReadText };
