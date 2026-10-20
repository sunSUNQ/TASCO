"use strict";

// Unified Agent Adapter — 统一运行时入口。
// native event → unified_adapter → 冻结核心 hook → result_adapter。
// opencode 分支委托既有 runOpenCodeBefore/After（行为不变，deep-equal 由
// 委托保证）；claude-code 分支仅做协议翻译，核心 hook 与策略全部复用。

const { AGENT_OPENCODE, AGENT_CLAUDE_CODE, detectAgent } = require("./agent_runtime");
const { runOpenCodeBefore } = require("./opencode_before");
const { runOpenCodeAfter } = require("./opencode_after");
const { runHookScript } = require("./opencode_bridge");
const { resolveHookDir, buildSpawnEnv } = require("./opencode_runtime");
const { normalizeBefore, normalizeAfter } = require("./unified_payload");
const { adaptBeforeDecision, adaptAfterResult } = require("./result_adapter");

function resolveAgent(input, options) {
  if (options && options.agent) return options.agent;
  return (
    detectAgent({
      hookEventName: input && (input.hookEventName || input.hook_event_name),
      sessionID: input && (input.sessionID || input.session_id)
    }) || AGENT_OPENCODE
  );
}

function runUnifiedBefore(input, output, ctx, options) {
  const agent = resolveAgent(input, options);
  if (agent === AGENT_CLAUDE_CODE) {
    const opts = options || {};
    const hookDir = opts.hookDir || resolveHookDir();
    const payload = normalizeBefore(input, output, ctx, agent);
    const env = buildSpawnEnv(opts.env || {});
    const result = runHookScript(hookDir, "pre_tool_policy_hook.js", payload, env);
    return adaptBeforeDecision(result, agent, output);
  }
  return runOpenCodeBefore(input, output, ctx, options);
}

function runUnifiedAfter(input, output, ctx, options) {
  const agent = resolveAgent(input, options);
  if (agent === AGENT_CLAUDE_CODE) {
    const opts = options || {};
    const hookDir = opts.hookDir || resolveHookDir();
    const payload = normalizeAfter(input, output, ctx, agent);
    const env = buildSpawnEnv(opts.env || {});
    const result = runHookScript(hookDir, "post_tool_policy_hook.js", payload, env);
    return adaptAfterResult(result, agent, output);
  }
  return runOpenCodeAfter(input, output, ctx, options);
}

module.exports = { runUnifiedBefore, runUnifiedAfter, resolveAgent };
