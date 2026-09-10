"use strict";

// ============================================================================
// compression_policy.js — Compression Policy Router (Phase 1)
// ============================================================================
// Replaces the binary Skill gate (ON/OFF) with a three-tier compression policy:
//
//   native     — no skill, no summary, keep raw context.
//                rename / API migration / known-target spec→code.
//   assist     — task boundary + decision control, keep read outputs raw.
//                traceability / gap analysis / impact analysis.
//   aggressive — read compression + repo_map + search governance + context budget.
//                bug analysis / complex debugging / large-repo investigation.
//
// Deterministic and explainable: every decision carries the matched signals and
// a reason string, so A/B results can attribute mode choice per case.
//
// Phase 2 note: contextBudget is reserved for the Token Budget Controller.
// ============================================================================

const COMPRESSION_MODES = {
  NATIVE: "native",
  ASSIST: "assist",
  AGGRESSIVE: "aggressive",
};

const VALID_MODE_OVERRIDES = new Set([
  COMPRESSION_MODES.NATIVE,
  COMPRESSION_MODES.ASSIST,
  COMPRESSION_MODES.AGGRESSIVE,
]);

// Per-mode policy knobs consumed by the plugin (system-prompt injection and
// post-tool translation) and by the A/B harness (skill install + prompt).
const COMPRESSION_POLICY = {
  [COMPRESSION_MODES.NATIVE]: {
    label: "Native",
    loadSkill: "none",
    workflow: "none",
    readCompression: false,
    summaryGeneration: false,
    repoMap: false,
    searchGovernance: "safety",
    contextBudget: null,
  },
  [COMPRESSION_MODES.ASSIST]: {
    label: "Assist — Context Boundary Control",
    loadSkill: "light",
    workflow: "assist",
    readCompression: false,
    summaryGeneration: false,
    repoMap: false,
    searchGovernance: "bounded",
    contextBudget: null,
  },
  [COMPRESSION_MODES.AGGRESSIVE]: {
    label: "Aggressive Compression",
    loadSkill: "full",
    workflow: "full",
    readCompression: true,
    summaryGeneration: true,
    repoMap: true,
    searchGovernance: "strict",
    contextBudget: { softLimit: 80000, hardLimit: 120000 },
  },
};

const TASK_CLASSES = {
  RENAME: "rename",
  API_MIGRATION: "api_migration",
  SPEC_TO_CODE: "spec_to_code",
  TRACEABILITY: "traceability",
  GAP_ANALYSIS: "gap_analysis",
  BUG_ANALYSIS: "bug_analysis",
  COMPLEX_DEBUGGING: "complex_debugging",
  UNKNOWN: "unknown",
};

// ============================ signal tables ================================

const AGGRESSIVE_SIGNALS = [
  // bug / defect / debugging
  "bug", "定位根因", "根因", "root cause", "debug", "调试", "crash",
  "崩溃", "exception", "异常", "报错", "错误", "traceback", "fail",
  "failed", "failure", "复现", "reproduce", "编译错误", "断言失败",
  "assertionerror",
  // repo-wide / cross-module investigation
  "仓库架构", "repo architecture", "跨模块", "cross-module", "整体分析",
  "整个项目", "整个仓库", "全仓", "多模块", "深挖", "复杂调试",
  "complex debugging", "疑难", "intermittent", "偶发", "线上问题",
  "多模块排查", "cross-module bug",
];

const ASSIST_SIGNALS = [
  // traceability / coverage
  "traceability", "追溯", "追踪", "requirement mapping", "需求映射",
  "需求覆盖", "覆盖分析", "coverage",
  // gap detection
  "gap", "差距", "缺口", "遗漏", "missing", "incomplete", "未实现",
  "部分实现", "gap analysis",
  // impact / dependency / call-chain analysis
  "影响分析", "impact analysis", "调用链", "call chain", "调用关系",
  "依赖分析", "dependency", "上下游", "被谁调用", "谁调用",
  // generic analysis (decision control only)
  "分析", "梳理", "audit", "审计",
  // fix intent without strong defect context (weak signal)
  "修复", "排查", "影响范围", "impact scope",
];

const NATIVE_SIGNALS = [
  // rename / migration
  "重命名", "改名", "rename", "迁移", "migration", "接口迁移",
  "api migration", "migrate",
  // single-document read / small known-target edits
  "读一下", "读取", "查看", "看下", "读这个文件", "read file",
  "read the file", "show me", "view", "open",
  "小改动", "small change", "简单修改", "simple", "单文件", "single file",
  "已知文件", "known file", "修改一个", "改一个", "直接修改", "直接实现",
  "增加字段", "add field", "补测试", "small fix", "minor fix",
];

// Explicit low-risk guards downgrade aggressive -> assist. Mirrors the proven
// LOW_RISK_TERMS behavior of the binary riskGate, but only de-escalates one tier.
const LOW_RISK_GUARDS = [
  "只修改", "只允许修改", "只改", "仅改", "只重命名", "仅重命名",
  "只修复", "仅修复", "一个文件", "单文件", "小改动", "简单修改",
  "不要修改测试", "不要修改其他", "不要动其他", "修改一个", "改一个",
  "only fix", "only rename", "small fix", "minor fix",
];

// spec→code escalates to assist when the target must still be located.
const EXPLORATION_SIGNALS = [
  "探索", "找到", "找一下", "定位", "locate", "where", "哪个文件",
  "仓库结构", "repo structure", "未知", "unknown",
];

// Task class -> base mode. Escalation/downgrade rules then refine it.
const CLASS_BASE_MODE = {
  [TASK_CLASSES.RENAME]: COMPRESSION_MODES.NATIVE,
  [TASK_CLASSES.API_MIGRATION]: COMPRESSION_MODES.NATIVE,
  [TASK_CLASSES.SPEC_TO_CODE]: COMPRESSION_MODES.NATIVE,
  [TASK_CLASSES.TRACEABILITY]: COMPRESSION_MODES.ASSIST,
  [TASK_CLASSES.GAP_ANALYSIS]: COMPRESSION_MODES.ASSIST,
  [TASK_CLASSES.BUG_ANALYSIS]: COMPRESSION_MODES.AGGRESSIVE,
  [TASK_CLASSES.COMPLEX_DEBUGGING]: COMPRESSION_MODES.AGGRESSIVE,
  [TASK_CLASSES.UNKNOWN]: COMPRESSION_MODES.ASSIST,
};

const SIGNAL_GROUPS = {
  aggressive: AGGRESSIVE_SIGNALS,
  assist: ASSIST_SIGNALS,
  native: NATIVE_SIGNALS,
  lowRiskGuard: LOW_RISK_GUARDS,
  exploration: EXPLORATION_SIGNALS,
};

function matchSignals(text, signals) {
  const s = String(text || "").toLowerCase();
  return signals.filter((term) => s.includes(String(term).toLowerCase()));
}

function collectSignals(text) {
  const out = {};
  for (const [name, terms] of Object.entries(SIGNAL_GROUPS)) {
    out[name] = matchSignals(text, terms);
  }
  return out;
}

// ============================ task classification ===========================

function classifyTaskClass(userText) {
  const s = String(userText || "").toLowerCase();

  if (
    ["复杂调试", "complex debugging", "疑难", "偶发", "intermittent", "深挖",
     "多模块排查", "cross-module bug", "线上问题"].some((t) => s.includes(t))
  ) {
    return TASK_CLASSES.COMPLEX_DEBUGGING;
  }
  if (
    ["bug", "定位根因", "根因", "root cause", "debug", "调试",
     "crash", "崩溃", "exception", "异常", "报错", "错误", "traceback",
     "复现", "reproduce", "编译错误", "断言失败", "assertionerror",
     "fail", "failed", "failure"].some((t) => s.includes(t))
  ) {
    return TASK_CLASSES.BUG_ANALYSIS;
  }
  if (
    ["gap", "差距", "缺口", "遗漏", "missing", "incomplete", "未实现",
     "部分实现", "gap analysis"].some((t) => s.includes(t))
  ) {
    return TASK_CLASSES.GAP_ANALYSIS;
  }
  if (
    ["traceability", "追溯", "追踪", "requirement mapping", "需求映射",
     "覆盖", "coverage"].some((t) => s.includes(t))
  ) {
    return TASK_CLASSES.TRACEABILITY;
  }
  if (
    ["迁移", "migration", "接口迁移", "api migration", "migrate"].some((t) => s.includes(t))
  ) {
    return TASK_CLASSES.API_MIGRATION;
  }
  if (["重命名", "改名", "rename"].some((t) => s.includes(t))) {
    return TASK_CLASSES.RENAME;
  }
  if (
    ["spec", "需求", "requirement", "implement", "实现", "生成代码",
     "spec_to_code", "spec-to-code", "按 spec", "依据 spec", "契约"].some((t) => s.includes(t))
  ) {
    return TASK_CLASSES.SPEC_TO_CODE;
  }
  return TASK_CLASSES.UNKNOWN;
}

// ============================ mode resolution ===============================

function resolveOverride(env = process.env) {
  const raw = String(env.CODE_GUARD_COMPRESSION_MODE || "auto")
    .trim()
    .toLowerCase();
  return VALID_MODE_OVERRIDES.has(raw) ? raw : null;
}

/**
 * Three-tier risk analysis. Returns the compression mode plus explainable
 * signals and a reason string.
 *
 * Order of precedence:
 *   1. explicit CODE_GUARD_COMPRESSION_MODE override;
 *   2. task class base mode (rename/migration/spec→code -> native,
 *      traceability/gap -> assist, bug/complex -> aggressive);
 *   3. strong defect/cross-module signals escalate analysis classes to
 *      aggressive; low-risk guards downgrade aggressive back to assist;
 *   4. spec→code with exploration required escalates native -> assist;
 *   5. unknown tasks with only low-risk signals settle on native.
 */
function analyzeCompressionPolicy(userText, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const override = resolveOverride(env);
  const text = String(userText || "").trim();
  const taskClass = classifyTaskClass(text);
  const signals = collectSignals(text);

  let mode;
  let reason;

  if (override) {
    mode = override;
    reason = `explicit override CODE_GUARD_COMPRESSION_MODE=${override}`;
  } else {
    mode = CLASS_BASE_MODE[taskClass];
    if (mode !== COMPRESSION_MODES.AGGRESSIVE && signals.aggressive.length > 0) {
      mode = COMPRESSION_MODES.AGGRESSIVE;
      reason = `escalated to aggressive by high-risk signals: ${signals.aggressive.join(",")}`;
    } else if (
      taskClass === TASK_CLASSES.SPEC_TO_CODE &&
      mode === COMPRESSION_MODES.NATIVE &&
      signals.exploration.length > 0
    ) {
      mode = COMPRESSION_MODES.ASSIST;
      reason = `spec→code with exploration needed: ${signals.exploration.join(",")}`;
    } else if (mode === COMPRESSION_MODES.AGGRESSIVE && signals.lowRiskGuard.length > 0) {
      mode = COMPRESSION_MODES.ASSIST;
      reason = `downgraded aggressive -> assist by low-risk guards: ${signals.lowRiskGuard.join(",")}`;
    } else if (
      mode === COMPRESSION_MODES.ASSIST &&
      taskClass === TASK_CLASSES.UNKNOWN &&
      signals.native.length > 0 &&
      signals.assist.length === 0
    ) {
      mode = COMPRESSION_MODES.NATIVE;
      reason = `low-risk signals: ${signals.native.join(",")}`;
    } else if (mode === COMPRESSION_MODES.NATIVE) {
      reason = `taskClass=${taskClass} -> native (known target / low risk)`;
    } else if (mode === COMPRESSION_MODES.ASSIST) {
      reason =
        signals.assist.length > 0
          ? `medium-risk signals: ${signals.assist.join(",")}`
          : "no strong signal (assist default)";
    } else {
      reason = `taskClass=${taskClass} -> aggressive`;
    }
  }

  const risk =
    mode === COMPRESSION_MODES.NATIVE
      ? "low"
      : mode === COMPRESSION_MODES.AGGRESSIVE
        ? "high"
        : "medium";

  const skill = {
    load: COMPRESSION_POLICY[mode].loadSkill,
    resources: selectSkillResources(mode, taskClass),
  };

  return {
    mode,
    taskClass,
    risk,
    signals,
    reason,
    skill,
    policy: COMPRESSION_POLICY[mode],
  };
}

function detectCompressionMode(userText, options) {
  return analyzeCompressionPolicy(userText, options).mode;
}

// ============================ skill resource routing ========================

const PRIMARY_RESOURCE = {
  [TASK_CLASSES.RENAME]: "resources/mutation.md",
  [TASK_CLASSES.API_MIGRATION]: "resources/mutation.md",
  [TASK_CLASSES.SPEC_TO_CODE]: "resources/mutation.md",
  [TASK_CLASSES.TRACEABILITY]: "resources/traceability.md",
  [TASK_CLASSES.GAP_ANALYSIS]: "resources/gap_analysis.md",
  [TASK_CLASSES.BUG_ANALYSIS]: "resources/bug_analysis.md",
  [TASK_CLASSES.COMPLEX_DEBUGGING]: "resources/bug_analysis.md",
  [TASK_CLASSES.UNKNOWN]: "resources/exploration.md",
};

/**
 * Progressive disclosure: native loads nothing; assist loads exactly one
 * primary resource; aggressive loads the primary plus exploration when the
 * primary is not already the orientation module.
 */
function selectSkillResources(mode, taskClass) {
  if (mode === COMPRESSION_MODES.NATIVE) return [];
  const primary = PRIMARY_RESOURCE[taskClass] || PRIMARY_RESOURCE[TASK_CLASSES.UNKNOWN];
  if (mode === COMPRESSION_MODES.ASSIST) return [primary];
  const resources = [primary];
  if (primary !== PRIMARY_RESOURCE[TASK_CLASSES.UNKNOWN]) {
    resources.push(PRIMARY_RESOURCE[TASK_CLASSES.UNKNOWN]);
  }
  return resources;
}

module.exports = {
  COMPRESSION_MODES,
  VALID_MODE_OVERRIDES,
  COMPRESSION_POLICY,
  TASK_CLASSES,
  SIGNAL_GROUPS,
  matchSignals,
  collectSignals,
  classifyTaskClass,
  resolveOverride,
  analyzeCompressionPolicy,
  detectCompressionMode,
  selectSkillResources,
};
