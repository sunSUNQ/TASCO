"use strict";

// Unified Agent Adapter — result adaptation.
// 把核心 hook 的规范结果适配回 agent 专属输出语义。
// opencode 路径复用既有 translators（零行为变化）；claude-code 输出为
// Claude Code hook 契约（approve/deny + hookSpecificOutput）。

const { AGENT_OPENCODE, AGENT_CLAUDE_CODE } = require("./agent_runtime");
const {
  translateBeforeDecision,
  applyOpenCodeBeforeDecision
} = require("./opencode_before");
const { translateAfterResult, extractReplacementText } = require("./opencode_after");

function adaptBeforeDecision(decision, agent, output) {
  if (agent === AGENT_CLAUDE_CODE) {
    const hso = (decision && decision.hookSpecificOutput) || {};
    const denied =
      (decision && decision.decision === "deny") || hso.permissionDecision === "deny";
    const result = {
      decision: denied ? "deny" : "approve",
      hookSpecificOutput: hso
    };
    if (denied) {
      result.reason = String(
        (decision && decision.reason) ||
          hso.permissionDecisionReason ||
          "BLOCKED_BY_CODE_GUARD"
      );
    }
    return result;
  }
  const translated = translateBeforeDecision(decision);
  applyOpenCodeBeforeDecision(translated, output);
  return translated;
}

function adaptAfterResult(result, agent, output) {
  if (agent === AGENT_CLAUDE_CODE) {
    const hso = (result && result.hookSpecificOutput) || {};
    const adapted = { hookSpecificOutput: {} };
    if (hso.updatedToolOutput !== undefined) {
      adapted.hookSpecificOutput.updatedToolOutput = hso.updatedToolOutput;
    }
    if (hso.additionalContext) {
      adapted.hookSpecificOutput.additionalContext = hso.additionalContext;
    }
    return adapted;
  }
  return translateAfterResult(result, output);
}

module.exports = {
  adaptBeforeDecision,
  adaptAfterResult,
  extractReplacementText
};
