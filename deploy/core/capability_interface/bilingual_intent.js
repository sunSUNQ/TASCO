"use strict";

// ============================================================================
// bilingual_intent.js — Bilingual (EN/ZH) intent normalization for
// prompt-text policies.
//
//   raw prompt
//     -> detectLanguage + canonical intent detection (with negation priority)
//     -> router-compatible classifyPrompt (scores / flags / dominant)
//
// English behavior is preserved exactly: the EN regexes below are copied
// verbatim from the frozen shadow_router and the scoring algorithm is
// identical. ZH patterns only add matches for Chinese text, so English-only
// prompts produce byte-identical scores/flags.
//
// Negation priority: explicit negation phrases are evaluated first and
// suppress the corresponding positive intent (e.g. "不要修改代码" ->
// noMutation=true, mutationRequested=false). Negation is phrase-based; bare
// single characters (修改 / 错误 / 分析) are intentionally NOT used as intent
// signals.
//
// This module is normalization + diagnostics only. It never decides policy by
// itself; the router's decide() order / thresholds / eligibility boundary are
// unchanged. matchedPatterns is debug-only and never feeds policy.
// ============================================================================

// ---------------- language detection ----------------

function detectLanguage(prompt) {
  const text = String(prompt || "");
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (cjk > 0 && latin > 0) return "mixed";
  if (cjk > 0) return "zh";
  if (latin > 0) return "en";
  return "unknown";
}

// ---------------- router keyword tables (EN verbatim + ZH) ----------------

const DIAGNOSTIC_KEYWORDS = [
  // EN — verbatim from frozen shadow_router
  /root[- ]cause/i, /failure/i, /\berror/i, /\blog(s)?\b/i, /diagnos/i,
  /exception/i, /\bfail\b/i, /\bcrash\b/i, /incident/i,
  // ZH — phrase-based; bare 错误 / 分析 deliberately excluded so that
  // "错误处理模块" and "分析历史记录" do not become diagnostic signals.
  /根因/, /失败原因/, /报错/, /错误日志/, /错误信息/, /错误堆栈/,
  /编译错误/, /运行错误/, /构建失败/, /测试失败/, /断言失败/,
  /异常/, /崩溃/, /复现/, /诊断/, /排错/, /故障/, /日志/,
];

const SEARCH_KEYWORDS = [
  /\bsearch\b/i, /\bgrep\b/i, /\bfind\b/i, /\bsymbol/i, /reference/i,
  /\bmatches?\b/i, /lookalike/i, /imported and called/i,
  /搜索/, /查找/, /引用/, /匹配/, /符号/, /相似的/, /找出/,
];

const READ_EXTRACTIVE_KEYWORDS = [
  /\bread\b/i, /\bclass\b/i, /\bstruct\b/i, /\btype\b/i, /\bmethod\b/i,
  /\binterface\b/i, /\bfunction\b/i,
  // 类 alone is too broad (类似/分类/人类) — only phrase forms are used.
  /定义/, /结构体/, /方法/, /函数/, /接口/, /类型/, /类的定义/, /类定义/,
  /读取/, /阅读/,
];

const STRUCTURAL_KEYWORDS = [
  /call(er|s| chain|s)?\b/i, /dependenc/i, /\bimport/i, /relation/i,
  /call graph/i, /call chain/i, /\btrace/i, /flows?/i, /pipeline/i,
  /(flows|goes|traces?) .* (into|through)/i, /error path/i, /error[- ]status/i,
  /error routing/i, /onError/i, /500\/404/i, /lifecycle/i,
  /调用链/, /调用关系/, /调用图/, /依赖/, /依赖关系/, /模块依赖/,
  /导入/, /上下游/, /被谁调用/, /谁调用/, /错误路径/, /生命周期/, /管线/,
];

const GUARDS = {
  distribution: [
    /how many/i, /\bdistribution\b/i, /across many files/i, /every mention/i,
    /comment references/i, /summarize the distribution/i, /which test file\(s\)/i,
    /有多少/, /分布/, /所有出现/, /每一处/, /所有文件里/,
    /全部.*(出现|引用|调用)/, /哪些.*文件/, /统计.*次数/,
  ],
  location: [
    /which file defines/i, /at which line/i, /which line/i, /defined at/i,
    /where (is|does|can)/i,
    /哪个文件/, /哪一行/, /定义在/, /在哪个文件/, /在哪一行/, /位于哪/,
  ],
  testSuite: [
    /npm test/i, /npx mocha/i, /run the .*test suite/i, /failing test/i,
    /the failing assertion/i, /should ensure/i, /test .*fails/i,
    /运行测试/, /执行测试/, /跑测试/, /测试套件/, /失败的测试/,
    /测试不通过/, /\bmocha\b/,
  ],
  editIntent: [
    /\bfix\b/i, /\badd\b/i, /implement/i, /migrat/i, /refactor/i,
    /write .*tests?/i, /\bupdate\b/i, /\bchange\b/i, /\bremove\b/i,
    /\brename\b/i, /spec-to-code/i, /spec to code/i,
    // ZH — phrase-based; bare 修改 / 改 / 修复 are excluded.
    /修复代码/, /修复bug/, /修复缺陷/, /修改代码/, /修改实现/, /修改逻辑/,
    /修改功能/, /添加功能/, /实现功能/, /实现需求/, /迁移代码/, /重构/,
    /更新代码/, /删除文件/, /删除代码/, /重命名/, /增加字段/, /补测试/,
    /补单元测试/, /改代码/, /改这个文件/, /改文件/,
    /修复.*(?:bug|缺陷|问题|实现|逻辑|函数|方法|代码)/, /添加字段/, /加字段/,
    /实现.*(?:功能|需求|模块|接口|服务)/,
  ],
  analysisOnly: [
    /do not modify/i, /read-only/i, /\banalysis\b/i,
    // Negation phrases are matched with a required trailing context so that
    // "不要修改测试" (which implies editing code, just not tests) is NOT
    // treated as no-mutation.
    /不要修改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /不修改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /不改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /无需修改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /不需要修改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /禁止修改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /不要改动(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /不改变代码/, /不要动代码/, /只读/, /仅分析/, /只分析/, /仅查看/, /只查看/,
  ],
  multiSourceSynthesis: [
    /synthesize evidence from at least two sources/i,
    /(?:correlate|combine) evidence across multiple sources/i,
    /compare evidence from [^.\n]+ and [^.\n]+/i,
    /综合(?:至少)?(?:两个|多个)(?:来源|信息源|证据源)?[^。\n]{0,30}(?:判断|归因|定位|分析)/i,
    /结合[^。\n]{0,30}(?:日志|log)[^。\n]{0,30}(?:配置|config)[^。\n]{0,20}(?:定位|判断|归因|分析)/i,
    /综合(?:两个|多个|至少两个)来源/, /结合多个(?:来源|信息源)/, /交叉验证/,
  ],
  selective: [
    /actually/i, /distinguish/i, /the real symbol/i, /lookalike/i,
    /which one/i, /unused/i,
    /区分/, /真正/, /哪一个/, /未被使用/, /没有使用/, /相似符号/,
  ],
  selfContained: [
    // NOTE: \btype\b excluded - property names like tx.type are not type definitions.
    /\bclass\b/i, /\bstruct\b/i, /\bmethod\b/i, /\binterface\b/i,
    /结构体/, /方法/, /接口/, /类的定义/, /类定义/,
  ],
  crossFilePrompt: [
    /\bfiles\b/i, /\bmodules\b/i, /across/i, /referenced from/i,
    /struct_lab\/s\d/i, /multiple files/i, /and src\//i,
    /(into|through|from .* to|->)[^.\n]{0,40}(serve|send|module|lib\\?\/|src\\?\/|compiler\\?\/|services\\?\/|server\\?\/|application|view|hooks|reply|error|checker|binder|parser|session)/i,
    /跨文件/, /多个文件/, /模块之间/, /引用自/, /跨模块/,
  ],
};

// ---------------- negation priority ----------------

const NEGATIONS = {
  // Negating mutation -> noMutation (and suppress mutationRequested).
  noMutation: [
    /do not modify/i, /no code changes/i, /without modifying/i,
    /read-only/i, /only analyze/i, /only inspect/i, /don't modify/i,
    /do not change/i, /leave unchanged/i, /don't change/i,
    /不要修改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /不修改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /不改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /无需修改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /不需要修改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /禁止修改(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /不要改动(?:代码|文件|任何文件|实现|逻辑|[。，；!！?？\s]|$)/,
    /不改变代码/, /不要动代码/, /只读/, /仅分析/, /只分析/, /仅查看/, /只查看/,
  ],
  // "不要运行测试" must not become precisionSensitive (testSuite suppressed).
  testRun: [
    /don't run tests/i, /do not run tests/i, /without running tests/i,
    /不要运行测试/, /不需要运行测试/, /不运行测试/, /不执行测试/,
    /不需要执行测试/, /别跑测试/, /不用跑测试/, /无需运行测试/, /不要执行测试/,
  ],
  // exhaustive/distribution negation (symmetry with the other groups).
  exhaustive: [
    /no need to list all/i, /not all occurrences/i, /don't enumerate/i,
    /不需要全部列出/, /不用全部列出/, /不必枚举/, /不要列举所有/, /不需要所有/,
  ],
};

// ---------------- canonical-intent extra tables ----------------

const DEFINITION_PATTERNS = [
  /definition|definitions|defined at|declaration|declare/i,
  /定义/, /声明/, /定义位置/, /声明位置/,
];
const REFERENCE_PATTERNS = [/reference|referenced/i, /引用/, /使用处/];
const EXHAUSTIVE_PATTERNS = [
  /all occurrences|every occurrence|find all|list every|search all/i,
  /所有出现|每一处|列出所有|查找所有|找出所有|全部.*(出现|引用|调用)|所有.*(出现|位置|包含)/,
];
const TEST_RUN_PATTERNS = [
  /run (the )?tests?|execute (the )?tests?|run the test suite|run all tests/i,
  /运行测试|执行测试|跑测试|测试套件|运行所有测试/,
];
const OVERVIEW_PATTERNS = [
  /repo (overview|structure|architecture)/i,
  /overview of the (repo|codebase|project)/i,
  /仓库(结构|架构|总览|概览)/, /项目结构/, /整体(了解|分析|看)/,
];
// Aligned with compression_policy's bilingual task-class terms. Kept
// self-contained so this module has no cross-directory require; an alignment
// test asserts the two agree for representative prompts.
const DEBUG_PATTERNS = [
  /bug|debug|root cause|crash|exception|traceback|fail|failed|failure|intermittent|reproduce/i,
  /根因|调试|崩溃|异常|报错|错误日志|复现|偶发|疑难|线上问题|断言失败|编译错误|排查问题|定位问题|深挖|多模块排查/,
];
const FIX_PATTERNS = [
  /rename|migration|migrate|small fix|minor fix|refactor|add field|api migration/i,
  /重命名|改名|迁移|接口迁移|小改动|简单修改|增加字段|补测试|重构/,
];
const SPEC_PATTERNS = [
  /spec|requirement|spec-to-code|spec to code|implement/i,
  /spec|需求|实现|生成代码|按spec|依据spec|契约/,
];

// ---------------- matching ----------------

function matchPatterns(patterns, text) {
  const out = [];
  for (const re of patterns) {
    if (re.test(text)) out.push(String(re));
  }
  return out;
}

/**
 * Router-compatible classification. Returns the SAME shape as the frozen
 * shadow_router.classifyPrompt: { scores, flags, dominant }. EN behavior is
 * identical because the EN regexes and the scoring algorithm are unchanged.
 */
function classifyPrompt(prompt) {
  const text = String(prompt || "");
  const scores = { diagnostic: 0, search: 0, read_extractive: 0, structural: 0 };
  const matches = { diagnostic: [], search: [], read_extractive: [], structural: [] };
  const CATS = [
    ["diagnostic", DIAGNOSTIC_KEYWORDS],
    ["search", SEARCH_KEYWORDS],
    ["read_extractive", READ_EXTRACTIVE_KEYWORDS],
    ["structural", STRUCTURAL_KEYWORDS],
  ];
  for (const [cat, patterns] of CATS) {
    for (const re of patterns) {
      if (re.test(text)) {
        scores[cat] += 1;
        matches[cat].push(String(re));
      }
    }
  }
  const flags = {};
  for (const g of Object.keys(GUARDS)) {
    flags[g] = GUARDS[g].some((re) => re.test(text));
    if (flags[g]) matches[g] = matchPatterns(GUARDS[g], text);
  }

  // Negation priority: explicit negation overrides positive signals.
  const negNoMutation = NEGATIONS.noMutation.some((re) => re.test(text));
  const negTestRun = NEGATIONS.testRun.some((re) => re.test(text));
  const negExhaustive = NEGATIONS.exhaustive.some((re) => re.test(text));
  if (negNoMutation) {
    flags.analysisOnly = true;
    flags.editIntent = false;
  }
  if (negTestRun) flags.testSuite = false;
  if (negExhaustive) flags.distribution = false;

  // dominant — identical algorithm to the frozen router (ties -> unknown).
  const sorted = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  const top = sorted[0];
  const second = sorted[1];
  const dominant =
    scores[top] > 0 && scores[top] - scores[second] >= 1 ? top : null;

  return {
    scores,
    flags,
    dominant,
    matches,
    negation: { noMutation: negNoMutation, testRun: negTestRun, exhaustive: negExhaustive },
  };
}

function capPatterns(list, max) {
  const n = Number(max) || 3;
  return (list || []).slice(0, n);
}

/**
 * Canonical intent detection (diagnostic layer only — never feeds policy).
 * Returns { language, intents, matchedPatterns? }.
 * matchedPatterns is included only in debug mode (CODE_GUARD_INTENT_DEBUG=1 or
 * options.debug), capped at 3 patterns per group.
 */
function detectIntents(prompt, options) {
  const opts = options || {};
  const cls = classifyPrompt(prompt);
  const text = String(prompt || "");
  const noMutation = cls.flags.analysisOnly;
  const exhaustive =
    (cls.flags.distribution || EXHAUSTIVE_PATTERNS.some((re) => re.test(text))) &&
    !cls.negation.exhaustive;
  const precision =
    (cls.flags.testSuite || TEST_RUN_PATTERNS.some((re) => re.test(text))) &&
    !cls.negation.testRun;
  const intents = {
    noMutation,
    mutationRequested: cls.flags.editIntent && !noMutation,
    focusedSearch: cls.scores.search > 0 && !exhaustive,
    exhaustiveSearch: exhaustive,
    definitionLookup:
      cls.scores.read_extractive > 0 ||
      cls.flags.location ||
      DEFINITION_PATTERNS.some((re) => re.test(text)),
    referenceLookup:
      cls.scores.search > 0 || REFERENCE_PATTERNS.some((re) => re.test(text)),
    callChainAnalysis: cls.scores.structural > 0,
    repoOverview: OVERVIEW_PATTERNS.some((re) => re.test(text)),
    debugging: DEBUG_PATTERNS.some((re) => re.test(text)),
    codeFix: FIX_PATTERNS.some((re) => re.test(text)),
    specToCode: SPEC_PATTERNS.some((re) => re.test(text)),
    diagnosticAnalysis: cls.scores.diagnostic > 0,
    multiSourceSynthesis: cls.flags.multiSourceSynthesis,
    precisionSensitive: precision,
  };
  const result = {
    language: detectLanguage(text),
    intents,
  };
  if (opts.debug || process.env.CODE_GUARD_INTENT_DEBUG === "1") {
    const matchedPatterns = {};
    for (const [k, v] of Object.entries(cls.matches)) {
      if (Array.isArray(v) && v.length) matchedPatterns[k] = capPatterns(v, 3);
    }
    result.matchedPatterns = matchedPatterns;
  }
  return result;
}

module.exports = {
  detectLanguage,
  detectIntents,
  classifyPrompt,
  DIAGNOSTIC_KEYWORDS,
  SEARCH_KEYWORDS,
  READ_EXTRACTIVE_KEYWORDS,
  STRUCTURAL_KEYWORDS,
  GUARDS,
  NEGATIONS,
};
