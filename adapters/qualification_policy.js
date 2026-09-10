"use strict";

// Qualification Auto-Approval Policy (bridge-layer, NOT frozen TASCO Core).
//
// Classification of PreToolUse requests during automated qualification:
//   - local read/search/test/analysis        -> auto approve (bypassPermissions
//     already covers most; this layer makes the decision explicit)
//   - bounded-profile external exploration    -> auto deny (curl/wget/github/
//     npm pack/npm install/git fetch...)
//   - dangerous / mutating / credential ops  -> deny (never auto-approved)
//   - unknown                                -> deny (never auto-YES)
//
// Every decision is emitted as a "qualification_policy" telemetry event so the
// live runner can print PERMISSION auto-approved / denied in real time.

const READ_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "read_file",
  "grep_search",
  "glob_search",
  "notebookread",
]);

const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "create",
  "mcp__filesystem__write",
]);

function classifyBash(command, bounded) {
  const c = String(command || "").toLowerCase();
  // External network / upstream exploration (never allowed in bounded profile).
  if (
    /\b(curl|wget|nc|telnet|ping|nslookup|dig)\b/.test(c) ||
    /github\.com|raw\.githubusercontent|npm (pack|install|view|info|publish)|git (clone|fetch|push|pull|ls-remote)/.test(
      c
    )
  ) {
    return {
      verdict: "deny",
      category: "network",
      reason: bounded
        ? "bounded_profile_external_exploration"
        : "network_access",
    };
  }
  // Dangerous / mutating / system / credential operations.
  if (
    /\b(rm|del|rd|rmdir|unlink|mkfs|format|git (commit|push|tag|reset --hard)|sudo|chmod|chown|scp|ssh)\b/.test(
      c
    ) ||
    // Redirection write, but NOT JavaScript arrow functions (`=>`) or
    // stderr redirects like `2>&1`.
    /(^|[^=\w])(>|>>)\s*\S+/.test(c) ||
    /~\/\.ssh|\.aws|api[_-]?key|password|token\s*=|credential|secrets?|\.npmrc|\.env\b/i.test(
      c
    ) ||
    /^(reg|sc|net user|netsh|taskkill|systeminfo)\b/i.test(c)
  ) {
    return {
      verdict: "deny",
      category: "dangerous",
      reason: "dangerous_or_mutating_operation",
    };
  }
  // Local test / analysis / read-only inspection.
  if (
    /\b(?:npm test|npm run|npx (?:(?:mocha|borp|jest|vitest|node)\b)|node\b|git (?:status|diff|log|show|grep|rev-parse)\b|ls\b|cat\b|type\b|rg\b|grep\b|find\b|pwd\b|echo\b|head\b|tail\b|wc\b|dir\b|where\b)/.test(
      c
    )
  ) {
    return {
      verdict: "approve",
      category: "local_analysis",
      reason: "local test/analysis",
    };
  }
  // Anything else in the shell is unknown -> do not auto-approve.
  return {
    verdict: "deny",
    category: "unknown_shell",
    reason: "unknown_shell_command_default_deny",
  };
}

function classifyToolAccess({ toolName, toolInput, bounded }) {
  const name = String(toolName || "").toLowerCase();
  const input = toolInput || {};
  const command =
    String(input.command || input.Command || input.cmd || "").trim();
  const filePath = String(
    input.file_path || input.filePath || input.path || ""
  ).trim();

  if (READ_TOOLS.has(name)) {
    return {
      verdict: "approve",
      category: "read_only",
      reason: "local read/search",
      command: filePath,
    };
  }
  if (name === "bash" || name === "run_shell_command") {
    const d = classifyBash(command, bounded);
    return { ...d, command };
  }
  if (WRITE_TOOLS.has(name)) {
    return {
      verdict: "deny",
      category: "mutation",
      reason: "no_mutation_in_qualification",
      command: filePath,
    };
  }
  if (name === "task" || name === "agent" || name === "invoke_agent") {
    return {
      verdict: "deny",
      category: "subagent",
      reason: "subagent_disabled",
      command: "",
    };
  }
  return {
    verdict: "deny",
    category: "unknown",
    reason: "unknown_tool_default_deny",
    command: filePath || command,
  };
}

module.exports = { classifyToolAccess };
