"use strict";

// ============================================================================
// edit_policy.js — Adaptive Edit Governance（ECOR v1.2）
// ============================================================================
// 5 轮重复实验确认 turns 中位数 13（>10），TGL≈0.26：Edit Governance Latency
// 是 Pilot 前最后一个瓶颈。核心 hook 对“old_string 不够稳定”的原生编辑一律
// BLOCK_NATIVE_REPLACE_UNSTABLE 并要求 safe_replace，模型反复适配产生
// BLOCK → RECOVERY → RETRY 循环。
//
// 本模块是 policy 层置信度评估（不修改核心 hook）：
//   single_line_exact_match -> native（置信度足够，直接放行）
//   multi_line / cross_file / uncertain -> safe_replace（走恢复指令）
//
// 置信度条件：单文件、old/new_string 均为单行、文件中 old_string 恰好出现
// 一次（唯一精确匹配）。不满足任何一条都退回 safe_replace。
// CODE_GUARD_EDIT_POLICY=strict 可关闭（回到 v1.1 全拦截行为）。
// ============================================================================

const fs = require("fs");
const MAX_SCAN_CHARS = 2 * 1024 * 1024;

const EDIT_POLICY = {
  single_line_exact_match: "native",
  multi_line: "safe_replace",
  cross_file: "safe_replace",
  uncertain: "safe_replace",
};

function getEditPolicyMode(env) {
  const e = env || process.env;
  const raw = String(e.CODE_GUARD_EDIT_POLICY || "adaptive").trim().toLowerCase();
  return raw === "strict" ? "strict" : "adaptive";
}

function readEditArgs(args) {
  const filePath = args.file_path || args.filePath;
  const oldString =
    args.old_string !== undefined ? args.old_string : args.oldString;
  const newString =
    args.new_string !== undefined ? args.new_string : args.newString;
  return { filePath, oldString, newString };
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

/**
 * 置信评估。返回 { decision, reason, occurrences, singleLine }。
 */
function assessNativeEdit(args, options) {
  const opts = options || {};
  const { filePath, oldString, newString } = readEditArgs(args);
  if (!filePath || oldString === undefined || newString === undefined) {
    return { decision: "safe_replace", reason: "incomplete_args" };
  }
  const oldText = String(oldString);
  const newText = String(newString);
  if (/[\r\n]/.test(oldText) || /[\r\n]/.test(newText)) {
    return { decision: "safe_replace", reason: "multi_line" };
  }
  let content = null;
  try {
    const full = fs.readFileSync(filePath, "utf8");
    content = full.length > MAX_SCAN_CHARS ? full.slice(0, MAX_SCAN_CHARS) : full;
  } catch (_e) {
    return { decision: "safe_replace", reason: "file_unreadable" };
  }
  const occurrences = countOccurrences(content, oldText);
  if (occurrences === 1) {
    return {
      decision: "native",
      reason: "single_line_exact_match",
      occurrences,
      singleLine: true,
    };
  }
  return {
    decision: "safe_replace",
    reason: occurrences === 0 ? "no_match" : "ambiguous_match",
    occurrences,
  };
}

/**
 * 插件层置信度绕过入口。仅 adaptive 模式且置信足够时返回 bypass。
 */
function shouldBypassNativeEdit(args, options) {
  const opts = options || {};
  if (getEditPolicyMode(opts.env) !== "adaptive") {
    return { bypass: false, reason: "strict_policy", occurrences: 0 };
  }
  const assessment = assessNativeEdit(args, opts);
  if (assessment.decision === "native") {
    return {
      bypass: true,
      reason: assessment.reason,
      occurrences: assessment.occurrences,
    };
  }
  return {
    bypass: false,
    reason: assessment.reason,
    occurrences: assessment.occurrences || 0,
  };
}

module.exports = {
  EDIT_POLICY,
  MAX_SCAN_CHARS,
  getEditPolicyMode,
  readEditArgs,
  countOccurrences,
  assessNativeEdit,
  shouldBypassNativeEdit,
};
