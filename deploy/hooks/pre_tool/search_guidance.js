"use strict";

// Search Task-Aware Governance — P0 thin guidance module（2026-08-27）。
//
// 极薄、纯函数、无副作用：只做
//   1. 搜索意图粗分类（lookup / filter / discovery / enumeration / statistics / unknown）
//   2. 任务关键词 / symbol / 文件名提取
//   3. scope hint 提取（path-like token）
//   4. 固定模板 + 动态 intent/keywords/scope 的 guidance 文本
//
// 铁律（与 SEARCH-TASK-AWARE-GOVERNANCE-V1.md §5.3/§5.5 一致）：
//   - 不 deny、不改 tool_input、不调用 Router、不触发 Search primitive；
//   - 不读 fs / state / network；同一输入输出完全确定；
//   - 不整体迁移 legacy search_policy.js，只复用其验证过的思路（关键词提取、
//     宽窄判断、scope 判断）。

const INTENTS = Object.freeze({
  LOOKUP: "lookup",
  FILTER: "filter",
  DISCOVERY: "discovery",
  ENUMERATION: "enumeration",
  STATISTICS: "statistics",
  UNKNOWN: "unknown",
});

const INTENT_SIGNALS = Object.freeze({
  enumeration: [
    "all calls", "all usages", "all references", "all occurrences",
    "every call", "every usage", "every reference", "list all",
    "enumerate", "complete list", "all implementations",
    "all call sites", "all callers", "every occurrence", "complete set",
    "full list", "complete enumeration", "all files", "across files",
    "missing references", "no omissions", "do not omit", "遗漏引用",
    "所有调用", "所有引用", "所有出现", "全部调用", "全部引用",
    "列出所有", "枚举", "全部实现", "所有实现", "遗漏", "全部",
    "所有", "是否存在遗漏", "全部匹配", "所有匹配",
  ],
  statistics: [
    "count", "how many", "distribution", "how often", "per module",
    "number of", "统计", "数量", "多少处", "分布", "占比",
    "per directory", "frequency", "how many times", "usage count",
    "classification count", "categorized count", "each module",
    "使用次数", "调用次数", "计数", "分类计数", "匹配项",
  ],
  lookup: [
    "definition", "where is", "defined", "locate", "find the definition",
    "symbol lookup", "exact symbol", "declaration",
    "定义", "在哪", "位置", "定位", "声明", "符号",
  ],
  discovery: [
    "where might", "which parts", "explore", "find out", "discover",
    "what implements", "which modules", "likely",
    "哪里", "哪些", "探索", "可能", "摸清", "范围",
    "在什么情况下", "如何判断", "不能继续复用", "重新处理", "失效",
    "判断流程", "触发条件", "传播", "机制",
  ],
  filter: [
    "most relevant", "similar", "candidates", "filter", "shortlist",
    "distinguish", "which one", "lookalike", "related", "relevant",
    "筛选", "相似", "候选", "最相关", "区分", "哪些是",
  ],
});

// 固定规则模板（用户批准版本）。动态段只允许 intent / keywords / scope。
const FIXED_RULES = Object.freeze([
  "Prefer exact task-specific identifiers before generic terms.",
  "Restrict search scope to the relevant source subtree when the task or known repository structure identifies one.",
  "Prefer one focused search over repeated broad searches.",
  "Preserve Native search when the task requires complete enumeration, counts, or distribution.",
]);

const COMMON_WORDS = new Set([
  "the", "this", "that", "with", "from", "which", "what", "where",
  "find", "search", "list", "show", "check", "review", "lookup",
  "find", "contains", "contain", "implement", "implementation",
  "file", "files", "code", "function", "symbol", "module", "repo",
  "and", "for", "are", "not", "its", "into", "than", "then",
  "请", "找到", "搜索", "查找", "使用", "分析", "判断", "确定",
  // 产品/框架名（避免被当作任务 symbol 提取）
  "typescript", "javascript", "express", "fastify", "node", "react",
  "angular", "vue", "python", "java", "golang", "rust", "nextjs",
]);

// 中文任务词 -> 英文概念词映射（有界、确定性；只用于无 code symbol 场景）。
const CHINESE_CONCEPT_MAP = [
  ["增量构建", "incremental build"],
  ["构建状态", "build state"],
  ["不能继续复用", "reuse invalid"],
  ["重新处理", "reprocess"],
  ["相关文件", "affected files"],
  ["复用", "reuse"],
  ["失效", "invalid"],
  ["缓存", "cache"],
  ["淘汰", "eviction"],
  ["过期", "expiration"],
  ["解析", "parse"],
  ["校验", "validation"],
  ["序列化", "serialize"],
  ["作用域", "scope"],
  ["封装", "encapsulation"],
  ["错误处理", "error handling"],
  ["请求体", "request body"],
  ["调用关系", "call relationship"],
  ["模块", "module"],
  ["依赖", "dependency"],
  ["传播", "propagation"],
];

// 概念词提取用的停用词（含任务动词与泛化词）。提取结果只作为"组合搜索"的
// 提示，来自任务 prompt 自身的词汇，不含答案 symbol。
const CONCEPT_STOPWORDS = new Set([
  ...COMMON_WORDS,
  "explore", "project", "identify", "explain", "modify", "analyze",
  "determine", "describe", "summarize", "inspect", "locate", "ensure",
  "report", "review", "evaluate", "understand", "consider", "need",
  "must", "should", "will", "can", "would", "also", "than", "then",
  "which", "where", "when", "what", "who", "how", "why", "with",
  "into", "onto", "from", "over", "under", "about", "within", "after",
  "before", "during", "between", "through", "across", "these", "those",
  "their", "there", "here", "were", "been", "being", "have", "has",
  "had", "does", "did", "doing", "get", "gets", "got", "make", "makes",
  "made", "take", "takes", "took", "given", "give", "gives", "using",
  "used", "use", "your", "you", "our", "its", "his", "her", "them",
  "each", "every", "both", "either", "other", "another", "such", "same",
  "most", "more", "much", "many", "few", "some", "any", "all", "only",
  "very", "just", "also", "even", "still", "well", "back", "down", "up",
  "file", "files", "code", "codes", "path", "paths", "line", "lines",
  "main", "index", "src", "lib", "test", "tests", "docs", "readme",
  "conditions", "primary", "call", "calls", "lives", "relationships",
  "relevant", "key", "most", "various", "several", "different", "under",
]);

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 搜索意图粗分类。命中多个时取命中信号数最多的意图；并列取固定优先级。
 */
function classifySearchIntent(prompt) {
  const text = normalizeText(prompt);
  const hits = {};
  for (const [intent, signals] of Object.entries(INTENT_SIGNALS)) {
    const found = signals.filter((s) => text.includes(s));
    if (found.length) hits[intent] = found;
  }
  const ranked = Object.keys(hits).sort((a, b) => {
    const diff = hits[b].length - hits[a].length;
    if (diff !== 0) return diff;
    const priority = ["enumeration", "statistics", "lookup", "discovery", "filter"];
    return priority.indexOf(a) - priority.indexOf(b);
  });
  if (!ranked.length) {
    return { intent: INTENTS.UNKNOWN, confidence: 0, signals: [] };
  }
  return {
    intent: ranked[0],
    confidence: hits[ranked[0]].length,
    signals: hits[ranked[0]],
  };
}

/**
 * 提取任务概念词（英文裸词，去停用词）。只用于 DISCOVERY / 无代码 symbol
 * 的场景；cap 6，按首次出现顺序。
 */
function extractConceptTerms(prompt) {
  const text = String(prompt || "").toLowerCase();
  const tokens = text.match(/[a-z][a-z0-9]{3,}/g) || [];
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    if (CONCEPT_STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 6) break;
  }
  // 中文任务词映射（追加，去重，总量 cap 8）。
  for (const [zh, en] of CHINESE_CONCEPT_MAP) {
    if (!text.includes(zh)) continue;
    for (const w of en.split(" ")) {
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= 8) break;
    }
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 提取任务相关 symbol / 文件名。只做词法提取，不做语义判断。
 */
function extractSymbols(prompt) {
  const text = String(prompt || "");
  const out = new Set();
  const add = (t) => {
    const s = String(t || "").trim();
    if (s.length >= 3 && !COMMON_WORDS.has(s.toLowerCase())) out.add(s);
  };
  // 引号包裹的标识符
  for (const m of text.matchAll(/["'`]([A-Za-z_][A-Za-z0-9_]{2,})["'`]/g)) add(m[1]);
  // CamelCase / PascalCase
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[A-Z][a-z0-9]+)+[A-Za-z0-9]*\b/g)) {
    add(m[0]);
  }
  // snake_case / UPPER_SNAKE
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+[A-Za-z0-9]\b/g)) {
    add(m[0]);
  }
  // 文件名（word.ext，排除常见通用扩展名干扰：只收已知代码/文档扩展名）
  for (const m of text.matchAll(
    /\b[A-Za-z0-9_.-]+\.(?:js|ts|tsx|jsx|py|java|go|rs|c|cc|cpp|h|hpp|md|json|yaml|yml|proto|sh|ps1)\b/gi
  )) {
    add(m[0]);
  }
  return [...out].slice(0, 8);
}

/**
 * 提取 scope hint：path-like token（含 / 或 \ 分隔的路径片段）。
 */
function extractScopeHints(prompt) {
  const text = String(prompt || "");
  const out = new Set();
  for (const m of text.matchAll(
    /\b(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\b/g
  )) {
    out.add(m[0].replace(/\\/g, "/"));
  }
  return [...out].slice(0, 4);
}

/**
 * 生成 guidance 文本。动态段严格限制为 intent / keywords / scope；
 * 不给具体答案（不出现"请搜索 X"类指令）。
 */
function buildSearchGuidance({ prompt }) {
  const intentInfo = classifySearchIntent(prompt);
  const scopes = extractScopeHints(prompt);
  // 目录片段（scope 的首段）不属于 symbol，从关键词中剔除。
  const scopeSegments = new Set(
    scopes.flatMap((s) => String(s).split("/").filter(Boolean))
  );
  const symbols = extractSymbols(prompt).filter((s) => !scopeSegments.has(s));
  const conceptTerms = symbols.length ? [] : extractConceptTerms(prompt);
  const enumerationLike =
    intentInfo.intent === INTENTS.ENUMERATION ||
    intentInfo.intent === INTENTS.STATISTICS;
  const discoveryLike = intentInfo.intent === INTENTS.DISCOVERY;

  // 负区安全逻辑（2026-08-27 冻结 + 2026-08-31 一次边界修正）：
  // ENUMERATION / STATISTICS / UNKNOWN / LOOKUP 一律不注入 guidance
  // （连"不要缩窄"的反向提示也不给），保持 Native planning。
  // LOOKUP 修正依据：Fastify pilot 18 cells 显示对"位置/定义/在哪"类
  // lookup 任务注入通用 guidance 会把"少搜"推成"多读"（search ↓ 但
  // reads ↑，FP1 系统性反向），跨任务经济性不稳定 → LOOKUP 并入负区
  // （此前"待单独验证"，现冻结为 Native）。DISCOVERY / FILTER 分支不受影响。
  if (
    enumerationLike ||
    intentInfo.intent === INTENTS.UNKNOWN ||
    intentInfo.intent === INTENTS.LOOKUP
  ) {
    return {
      intent: intentInfo.intent,
      confidence: intentInfo.confidence,
      signals: intentInfo.signals,
      symbols: [],
      conceptTerms: [],
      scopes: [],
      chars: 0,
      text: "",
      suppressed: true,
      suppressReason: enumerationLike
        ? "negative_intent_full_coverage_required"
        : intentInfo.intent === INTENTS.LOOKUP
          ? "lookup_intent_default_native"
        : "unknown_intent_default_native",
    };
  }

  const lines = ["Search guidance:", `Task intent: ${intentInfo.intent}.`, "Guidance:"];
  FIXED_RULES.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  if (discoveryLike) {
    lines.push(
      "For discovery tasks, use task-derived concepts to narrow the candidate space before broad repository enumeration when possible."
    );
    lines.push(
      "Prefer focused evidence discovery before reading many loosely related files."
    );
    if (conceptTerms.length) {
      lines.push(`Relevant task concepts: ${conceptTerms.join(", ")}.`);
    }
  } else if (symbols.length) {
    lines.push(`Task-derived identifiers detected: ${symbols.join(", ")}.`);
  } else if (conceptTerms.length) {
    lines.push(
      `Task-derived terms to combine in search: ${conceptTerms.join(", ")}.`
    );
  }
  if (scopes.length) {
    lines.push(`Relevant subtree mentioned: ${scopes.join(", ")}.`);
  }
  const text = lines.join("\n");
  return {
    intent: intentInfo.intent,
    confidence: intentInfo.confidence,
    signals: intentInfo.signals,
    symbols,
    conceptTerms,
    scopes,
    chars: text.length,
    text,
    suppressed: false,
  };
}

/**
 * Transport probe marker（Probe A: UserPromptSubmit；Probe B: PreToolUse）。
 * 仅用于确认 guidance 是否进入模型上下文 / 当前调用是否不变。
 */
function buildProbeMarker(phase) {
  const p = String(phase || "").toUpperCase();
  return [
    "TASCO_SEARCH_GUIDANCE_PROBE",
    `phase=${p}`,
    "This marker verifies that task-aware search guidance reaches the model's planning context.",
  ].join("\n");
}

module.exports = {
  INTENTS,
  classifySearchIntent,
  extractSymbols,
  extractConceptTerms,
  extractScopeHints,
  buildSearchGuidance,
  buildProbeMarker,
};
