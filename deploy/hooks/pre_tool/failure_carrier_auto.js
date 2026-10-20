"use strict";

// ============================================================================
// pre_tool/failure_carrier_auto.js — P1-S2b PreToolUse Auto Failure Carrier
// ============================================================================
// Rewrites an eligible validation/build Bash command into the exit-0 carrier
// shim form so a real failure reaches PostToolUse as a
// FAILURE-CARRIER-CONTRACT-V1 report (the only productizable failure entry on
// Claude Code 2.1.263; see P1-S0).
//
// Core invariants (fail-closed):
//   - original_command is the agent's semantic command. It travels in-band as
//     base64url (no shell quoting hazards, no state side-channel):
//       node "<shim>" --orig "<base64url>"
//     Same original command => byte-identical rewritten command.
//   - Only simple, frozen test/build command forms are eligible. Anything with
//     shell metacharacters, watch/interactive flags, unknown forms, or an
//     already-carried command stays native (legacy execution, no rewrite).
//   - The flag CODE_GUARD_FAILURE_CARRIER_AUTO=1 gates the whole path; unset
//     means the bridge never rewrites (default Native).
//
// The shim replays the original command exactly once and either passes the
// success result through untouched (exit 0) or prints the carrier report and
// exits 0 (transport success). Failure semantics always come from
// original_exit_code, never from the wrapper process exit code.
// ============================================================================

const path = require("path");
const { classifyCommand } = require("../post_tool/terminal_state");

const SHIM_REL_PATH = path.join("carrier", "failure_carrier_shim.js");
const MAX_COMMAND_CHARS = 1000;

// Fail-closed v1 eligibility: exclude every shell construct that could change
// word-splitting, interpolation, redirection, globbing or background semantics
// between the original Git Bash execution and the carrier replay. Quoted
// arguments are also excluded (quoting fidelity is not proven in v1).
const UNSAFE_COMMAND_CHARS = /[|&;><`$()*?\[\]{}~\\'"\r\n]/;
const INTERACTIVE_RE =
  /(^|\s)(--watch|--watchAll|--inspect|--interactive|--shell|-i)(\s|$|=)/;

function isAutoCarrierEligible({ toolName, command }) {
  if (toolName !== "Bash") return { eligible: false, reason: "tool_not_bash" };
  const cmd = String(command === undefined || command === null ? "" : command);
  if (!cmd.trim()) return { eligible: false, reason: "empty_command" };
  if (cmd.length > MAX_COMMAND_CHARS) {
    return { eligible: false, reason: "command_too_long" };
  }
  if (cmd.includes("failure_carrier_shim.js")) {
    return { eligible: false, reason: "already_carrier_wrapped" };
  }
  if (UNSAFE_COMMAND_CHARS.test(cmd)) {
    return { eligible: false, reason: "unsafe_shell_shape" };
  }
  if (INTERACTIVE_RE.test(cmd)) {
    return { eligible: false, reason: "interactive_or_watch" };
  }
  const kind = classifyCommand(cmd);
  if (!kind) {
    return { eligible: false, reason: "not_test_or_build_form" };
  }
  // Line-7 A 阶段：kind 现含 "check"（lint/check 工具族）。reason 字符串保持
  // 冻结值（历史断言依赖）；具体类别由返回的 kind 字段区分。
  return { eligible: true, reason: "test_or_build_validation_form", kind };
}

function buildCarrierRewrite({ command, hookDir }) {
  const originalCommand = String(command === undefined || command === null ? "" : command);
  const token = Buffer.from(originalCommand, "utf8").toString("base64url");
  const shimPath = path.join(String(hookDir || ""), SHIM_REL_PATH).replace(/\\/g, "/");
  const rewrittenCommand = `node "${shimPath}" --orig "${token}"`;
  return { rewrittenCommand, originalCommand, token, shimPath };
}

// Restores the agent-semantic original command from a rewritten wrapper.
// Returns null for any non-wrapper command (legacy path is unaffected).
function parseCarrierWrapper(command) {
  const m = /^node "(.+?\/carrier\/failure_carrier_shim\.js)" --orig "([A-Za-z0-9_-]+)"\s*$/.exec(
    String(command === undefined || command === null ? "" : command).trim()
  );
  if (!m) return null;
  let originalCommand = null;
  try {
    originalCommand = Buffer.from(m[2], "base64url").toString("utf8");
  } catch (_e) {
    return null;
  }
  if (!originalCommand || !originalCommand.trim()) return null;
  return { originalCommand, shimPath: m[1] };
}

module.exports = {
  SHIM_REL_PATH,
  MAX_COMMAND_CHARS,
  isAutoCarrierEligible,
  buildCarrierRewrite,
  parseCarrierWrapper,
};
