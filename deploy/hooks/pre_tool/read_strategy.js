"use strict";

// ============================================================================
// pre_tool/read_strategy.js — Line-6 任务驱动 Read：任务类型 → 读取策略映射
// ============================================================================
// 第六条线重构后的第一份冻结资产（2026-09-08）：把"什么 Read 任务适合什么压缩
// 方式"固化为确定性映射。本阶段**只冻结映射与分类器**，不做 runtime 接线、
// 不做 AUTO 承诺（默认 Native 原则； Structural repo-router 已按
// STRUCTURAL-ROUTER-V4-G1-VERDICT-V1.md 冻结为 Native passthrough）。
//
// 类别（与 pilot_manifests/read_task_driven_corpus_v1.json 对齐）：
//   R1 局部目标读取   → extractive_read     （runtime 已有 frozen primitive）
//   R2 调用关系读取   → relation_evidence   （待建；v1.1 callee-following 已否决）
//   R3 wrapper→实现链 → implementation_chain（待建）
//   R4 重复读取       → repeat_suppression  （dedup hint 已有；内容新鲜度待建）
//   R5 大文档定向阅读 → section_extraction  （RLM 通用摘要有；章节感知待建）
//   R0 无法分类       → native（完整原文，不加干预）
//
// 铁律：纯函数、无 I/O、确定性；分类只依据任务文本，不读仓库、不改 tool_input。
// ============================================================================

const TASK_CLASSES = Object.freeze({
  R1: "R1_local_target",
  R2: "R2_call_relation",
  R3: "R3_implementation_chain",
  R4: "R4_repeat_read",
  R5: "R5_section_read",
  R0: "R0_unclassified",
});

const STRATEGIES = Object.freeze({
  R1: "extractive_read",
  R2: "relation_evidence",
  R3: "implementation_chain",
  R4: "repeat_suppression",
  R5: "section_extraction",
  R0: "native",
});

const SIGNALS = Object.freeze({
  // R4 重复读取：优先级最高——"再看一遍/是否有变化"类任务与内容无关，只与
  // 会话历史有关，任何更细的解析都没有意义。
  R4: [
    "re-read", "read .* again", "再读", "重新读", "再读一次", "又一次读",
    "already read", "已经读过", "已读取过", "has anything changed",
    "是否有变化", "有没有变化", "double-check.*earlier", "confirm.*again",
  ],
  // R3 wrapper→实现链：转发/最终实现/封装接线。
  R3: [
    "wrapper", "实际实现", "real implementation", "actual implementation",
    "implementation chain", "实现链路", "最终调用", "ultimately calls",
    "最终交给", "forwarding", "转发", "封装层", "encapsulation", "封装接线",
    "delegates? to.*(implementation|module)",
  ],
  // R2 调用关系：链/边/传播/上下游/直接依赖枚举。
  R2: [
    "call chain", "调用链", "调用关系", "call relationship", "调用路径",
    "上下游", "caller", "callee", "propagat", "传播", "数据流", "data flow",
    "trace.*through", "dependency path", "依赖路径", "调用方", "被谁调用",
    "passes? .* into processing", " diverted", "internal modules",
    "direct dependency", "直接依赖", "直接内部模块",
  ],
  // R5 大文档/Spec 定向阅读：以文档制品为对象。
  R5: [
    "docs/", ".md", "readme", "spec", "规格", "文档", "章节", "section",
    "api_v\\d", "migration notes", "design doc", "配置文档", "说明文档",
  ],
  // R1 局部目标读取：命名符号/函数/类的行为或修改类问题（兜底类）。
  R1: [
    "函数", "function", "method", "class", "symbol", "默认", "default port",
    "default value", "which condition", "哪个条件", "哪种", "which branch",
    "which field", "which getter", "which method", "which error",
    "which error code", "error code", "分支", "bug", "fix", "修复", "修改",
    "改这个", "逻辑", "behavior of", "行为", "what default", "how.*handles?",
  ],
});

const DOC_FILE_RE = /(?:\bdocs\/|\bdocs\\|\bREADME\b|\.md\b|api_v\d|architecture\.md|migration\.md|\bspecs?\/)/i;
const SYMBOL_RE = /\b[A-Za-z_][A-Za-z0-9_]{3,}\b/;

function normalize(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hitsFor(text, signals) {
  const found = [];
  for (const signal of signals) {
    const re = new RegExp(signal, "i");
    if (re.test(text)) found.push(signal);
  }
  return found;
}

/**
 * 任务文本 → 读取任务类别 + 策略。确定性；无法分类 → R0/native。
 * 优先级：R4（重复读）> R3（实现链）> R2（调用关系）> R5（文档章节）>
 * R1（命名符号的局部目标，兜底）> R0。
 */
function classifyReadTask(prompt) {
  const text = normalize(prompt);
  if (!text) {
    return { task_class: TASK_CLASSES.R0, strategy: STRATEGIES.R0, signals: [], suppressed: true, reason: "empty_task" };
  }

  const order = ["R4", "R3", "R2", "R5", "R1"];
  const CODE_FILE_RE = /\b[\w.-]+\.(?:js|ts|jsx|tsx|py|go|rs|java)\b/i;
  for (const cls of order) {
    const hits = hitsFor(text, SIGNALS[cls]);
    if (!hits.length) continue;
    // R5 需要文档制品信号；R1 需要命名符号/文件；其余类命中信号即成立。
    if (cls === "R5" && !DOC_FILE_RE.test(prompt)) continue;
    if (cls === "R1" && !SYMBOL_RE.test(prompt)) continue;
    return {
      task_class: TASK_CLASSES[cls],
      strategy: STRATEGIES[cls],
      signals: hits,
      suppressed: false,
      reason: `${cls.toLowerCase()}_task_strategy_mapping`,
    };
  }

  // 兜底（R1 residual）：任务引用了代码文件或符号、且没有命中任何更具体的
  // 类别——读代码文件提行为问题默认按"局部目标读取"处理。
  if (CODE_FILE_RE.test(prompt) && SYMBOL_RE.test(prompt)) {
    return {
      task_class: TASK_CLASSES.R1,
      strategy: STRATEGIES.R1,
      signals: ["residual_code_file_question"],
      suppressed: false,
      reason: "r1_residual_code_file_question",
    };
  }

  return {
    task_class: TASK_CLASSES.R0,
    strategy: STRATEGIES.R0,
    signals: [],
    suppressed: true,
    reason: "unclassified_read_task_default_native",
  };
}

module.exports = { TASK_CLASSES, STRATEGIES, SIGNALS, classifyReadTask };
