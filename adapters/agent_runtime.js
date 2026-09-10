"use strict";

// Unified Agent Adapter — agent detection.
// 只做运行时识别，不接触任何核心策略。未知运行时返回 null（调用方 fail-open）。

const AGENT_OPENCODE = "opencode";
const AGENT_CLAUDE_CODE = "claude-code";

function normalizeAgentName(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (raw === "claude" || raw === "claude-code" || raw === "claudecode") {
    return AGENT_CLAUDE_CODE;
  }
  if (raw === "opencode") return AGENT_OPENCODE;
  return null;
}

// 识别优先级：显式 env > context.agentRuntime > hook/事件形状启发式。
function detectAgent(context) {
  const fromEnv = normalizeAgentName(process.env.CODE_GUARD_AGENT_RUNTIME);
  if (fromEnv) return fromEnv;

  const ctx = context || {};
  const explicit = normalizeAgentName(ctx.agentRuntime);
  if (explicit) return explicit;

  const hookName = String(ctx.hookEventName || ctx.hookName || "");
  if (/^(PreToolUse|PostToolUse|Notification|UserPromptSubmit)$/.test(hookName)) {
    return AGENT_CLAUDE_CODE;
  }
  if (/^(BeforeTool|AfterTool|chat\.message|experimental\.)/.test(hookName)) {
    return AGENT_OPENCODE;
  }

  const sessionId = String(ctx.sessionId || ctx.sessionID || "");
  if (/^ses_/.test(sessionId)) return AGENT_OPENCODE;
  return null;
}

module.exports = { AGENT_OPENCODE, AGENT_CLAUDE_CODE, detectAgent };
