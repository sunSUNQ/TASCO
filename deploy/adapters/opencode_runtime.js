"use strict";

const fs = require("fs");
const path = require("path");

// 默认 hook 安装目录。可用 CODE_GUARD_HOOK_DIR 覆盖。
const DEFAULT_HOOK_DIR = "D:\\hook_gemini";

function resolveHookDir() {
  return path.resolve(process.env.CODE_GUARD_HOOK_DIR || DEFAULT_HOOK_DIR);
}

function assertHookInstalled(hookDir) {
  // The TASCO deploy closure ships a single execution entry
  // (post_tool_policy_hook.js); PreTool/BeforeTool governance is handled
  // inline by the agent adapters (mirroring claude_bridge.js). The legacy full
  // runtime (D:\hook_gemini) also provides pre_tool_policy_hook.js, but it is
  // not required for the after/compression path.
  const required = ["post_tool_policy_hook.js"];
  const missing = required.filter((file) => !fs.existsSync(path.join(hookDir, file)));
  if (missing.length > 0) {
    throw new Error(
      `code-guard hook install dir is incomplete (${hookDir}): missing ${missing.join(", ")}. ` +
        "Set CODE_GUARD_HOOK_DIR to the directory containing post_tool_policy_hook.js."
    );
  }
  return hookDir;
}

function buildSpawnEnv(extra) {
  return Object.assign({}, process.env, { CODE_GUARD_RUNTIME: "opencode" }, extra || {});
}

module.exports = {
  DEFAULT_HOOK_DIR,
  resolveHookDir,
  assertHookInstalled,
  buildSpawnEnv
};
