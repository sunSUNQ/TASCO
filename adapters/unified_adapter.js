"use strict";

// Unified Agent Adapter — 统一入口（facade）。
// 第一个跨 Agent 重构只允许改变以下四件事：
//   1. Agent detection（agent_runtime.js）
//   2. Tool-name normalization（canonical_tools.js）
//   3. Payload normalization（unified_payload.js）
//   4. Result adaptation（result_adapter.js）
// 冻结边界之外的一切（Router / Eligibility Boundary / Diagnostic primitive /
// Apply Policy / Quality Gate / Fallback policy）不在此层出现。

const { detectAgent, AGENT_OPENCODE, AGENT_CLAUDE_CODE } = require("./agent_runtime");
const { normalizeToolName, canonicalToolFamily, TOOL_TABLES } = require("./canonical_tools");
const { normalizeBefore, normalizeAfter } = require("./unified_payload");
const { adaptBeforeDecision, adaptAfterResult } = require("./result_adapter");

module.exports = {
  detectAgent,
  normalizeToolName,
  canonicalToolFamily,
  normalizeBefore,
  normalizeAfter,
  adaptBeforeDecision,
  adaptAfterResult,
  AGENT_OPENCODE,
  AGENT_CLAUDE_CODE,
  TOOL_TABLES
};
