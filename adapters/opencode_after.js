"use strict";

const { runHookScript } = require("./opencode_bridge");
const {
  resolveHookDir,
  assertHookInstalled,
  buildSpawnEnv
} = require("./opencode_runtime");
const { buildAfterPayload } = require("./opencode_payload");

// 运行 post_tool 压缩,并把结果写回 opencode 的 output.output。
function runOpenCodeAfter(input, output, ctx, options) {
  const opts = options || {};
  const hookDir = opts.hookDir || resolveHookDir();
  assertHookInstalled(hookDir);
  const payload = buildAfterPayload(input, output, ctx);
  const env = buildSpawnEnv(opts.env || {});
  const result = runHookScript(hookDir, "post_tool_policy_hook.js", payload, env);
  // native/assist 模式保持 read 输出原始内容：post hook 仍运行（维护证据状态、
  // 归档和 telemetry），但丢弃 updatedToolOutput 替换，不压缩、不摘要。
  if (opts.keepRawOutput) {
    return {
      changed: false,
      changes: {},
      hookSpecificOutput: (result && result.hookSpecificOutput) || {},
      skippedCompression: true,
    };
  }
  return translateAfterResult(result, output);
}

function extractReplacementText(updated) {
  if (typeof updated === "string") return updated;
  if (!updated || typeof updated !== "object") return null;
  if (typeof updated.content === "string") return updated.content;
  if (typeof updated.stdout === "string") {
    return [updated.stdout, updated.stderr].filter(Boolean).join("\n");
  }
  if (updated.file && typeof updated.file === "object" && typeof updated.file.content === "string") {
    return updated.file.content;
  }
  if (typeof updated.output === "string") return updated.output;
  if (Array.isArray(updated.content)) {
    const text = updated.content
      .map((block) => (typeof block === "string" ? block : block && block.text))
      .filter((value) => typeof value === "string" && value)
      .join("\n");
    if (text) return text;
  }
  return null;
}

function translateAfterResult(result, output) {
  const hso = (result && result.hookSpecificOutput) || {};
  const out = output || {};
  const changes = {};

  if (hso.updatedToolOutput !== undefined) {
    const text = extractReplacementText(hso.updatedToolOutput);
    if (text !== null) {
      changes.output = text;
      changes.replaced = true;
      if (typeof out.output === "string") out.output = text;
    }
  }

  if (hso.additionalContext) {
    const guidance = String(hso.additionalContext);
    const current = typeof out.output === "string" ? out.output : "";
    const merged = current ? current + "\n\n" + guidance : guidance;
    changes.output = merged;
    changes.guidance = true;
    out.output = merged;
  }

  return {
    changed: Object.prototype.hasOwnProperty.call(changes, "output"),
    changes,
    hookSpecificOutput: hso
  };
}

module.exports = { runOpenCodeAfter, translateAfterResult, extractReplacementText };
