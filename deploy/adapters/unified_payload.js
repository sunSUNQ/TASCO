"use strict";

// Unified Agent Adapter — payload normalization.
// 统一入口：normalizeBefore / normalizeAfter 把 agent 专属事件归一为
// 核心 hook 消费的规范载荷。opencode 路径直接复用既有 builders（零行为变化）。

const { AGENT_OPENCODE, AGENT_CLAUDE_CODE, detectAgent } = require("./agent_runtime");
const { buildBeforePayload, buildAfterPayload } = require("./opencode_payload");
const { normalizeToolName } = require("./canonical_tools");

function resolveSessionId(input) {
  const session = (input && input.session) || {};
  return (
    (session && (session.session_id || session.sessionId)) ||
    (input && (input.session_id || input.sessionID)) ||
    ""
  );
}

function buildClaudeBeforePayload(input, output, ctx) {
  const toolName = (input && input.tool_name) || "";
  const toolInput = (input && input.tool_input) || {};
  const cwd = (input && input.cwd) || (ctx && (ctx.directory || ctx.cwd)) || process.cwd();
  return {
    hook_event_name: "PreToolUse",
    hookEventName: "PreToolUse",
    session_id: resolveSessionId(input),
    cwd,
    transcript_path: (input && input.transcript_path) || "",
    tool_name: normalizeToolName(toolName, AGENT_CLAUDE_CODE),
    tool_input: toolInput
  };
}

function buildClaudeAfterPayload(input, output, ctx) {
  const toolName = (input && input.tool_name) || "";
  const toolInput = (input && input.tool_input) || {};
  const response = (output && (output.tool_response || output.output)) || "";
  const text = typeof response === "string" ? response : JSON.stringify(response);
  return {
    hook_event_name: "PostToolUse",
    hookEventName: "PostToolUse",
    session_id: resolveSessionId(input),
    cwd: (input && input.cwd) || (ctx && (ctx.directory || ctx.cwd)) || process.cwd(),
    transcript_path: (input && input.transcript_path) || "",
    tool_name: normalizeToolName(toolName, AGENT_CLAUDE_CODE),
    tool_input: toolInput,
    output: text,
    tool_response: { content: text }
  };
}

function normalizeBefore(input, output, ctx, agent) {
  const resolved = agent || detectAgent({
    hookEventName: input && input.hookEventName,
    sessionId: input && (input.sessionID || input.session_id)
  }) || AGENT_OPENCODE;
  if (resolved === AGENT_CLAUDE_CODE) return buildClaudeBeforePayload(input, output, ctx);
  return buildBeforePayload(input, output, ctx);
}

function normalizeAfter(input, output, ctx, agent) {
  const resolved = agent || detectAgent({
    hookEventName: input && input.hookEventName,
    sessionId: input && (input.sessionID || input.session_id)
  }) || AGENT_OPENCODE;
  if (resolved === AGENT_CLAUDE_CODE) return buildClaudeAfterPayload(input, output, ctx);
  return buildAfterPayload(input, output, ctx);
}

module.exports = {
  normalizeBefore,
  normalizeAfter,
  buildClaudeBeforePayload,
  buildClaudeAfterPayload
};
