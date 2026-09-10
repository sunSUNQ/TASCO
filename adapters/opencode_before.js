"use strict";

const { runHookScript } = require("./opencode_bridge");
const {
  resolveHookDir,
  assertHookInstalled,
  buildSpawnEnv
} = require("./opencode_runtime");
const { buildBeforePayload } = require("./opencode_payload");

// 运行 pre_tool 治理,返回 { decision, reason, rewrittenInput }。
function runOpenCodeBefore(input, output, ctx, options) {
  const opts = options || {};
  const hookDir = opts.hookDir || resolveHookDir();
  assertHookInstalled(hookDir);
  const payload = buildBeforePayload(input, output, ctx);
  if (opts.userQuery) {
    payload.user_query = String(opts.userQuery).slice(0, 1000);
  }
  if (opts.compression) {
    payload.compression = opts.compression;
  }
  const env = buildSpawnEnv(opts.env || {});
  const result = runHookScript(hookDir, "pre_tool_policy_hook.js", payload, env);
  return translateBeforeDecision(result);
}

function translateBeforeDecision(result) {
  const hso = (result && result.hookSpecificOutput) || {};
  const denied =
    (result && result.decision === "deny") || hso.permissionDecision === "deny";
  if (denied) {
    return {
      decision: "deny",
      reason: String(
        (result && result.reason) ||
          hso.permissionDecisionReason ||
          "BLOCKED_BY_CODE_GUARD"
      )
    };
  }
  const rewritten = hso.tool_input || hso.updatedInput;
  return {
    decision: "allow",
    rewrittenInput:
      rewritten && typeof rewritten === "object" && Object.keys(rewritten).length > 0
        ? rewritten
        : null
  };
}

// 把决策翻译成 opencode V1 语义:deny -> throw;改写 -> 替换 output.args。
function applyOpenCodeBeforeDecision(decision, output) {
  if (!decision) return;
  if (decision.decision === "deny") {
    const err = new Error(decision.reason || "BLOCKED_BY_CODE_GUARD");
    err.code = "CODE_GUARD_DENY";
    throw err;
  }
  if (decision.rewrittenInput && output) {
    output.args = Object.assign({}, output.args || {}, decision.rewrittenInput);
  }
}

module.exports = {
  runOpenCodeBefore,
  translateBeforeDecision,
  applyOpenCodeBeforeDecision
};
