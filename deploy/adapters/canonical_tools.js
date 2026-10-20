"use strict";

// Unified Agent Adapter — tool-name normalization.
// opencode 表复用既有 OPENCODE_TOOL_MAP（行为不变）；claude-code 表为
// Claude Code hook 工具名的规范映射。未知工具一律原样透传（fail-open）。

const { OPENCODE_TOOL_MAP } = require("./opencode_tool_map");

const CLAUDE_TOOL_MAP = Object.freeze({
  Bash: "run_shell_command",
  Read: "read_file",
  Write: "write_file",
  Edit: "replace",
  MultiEdit: "replace",
  NotebookEdit: "replace",
  Glob: "glob_search",
  Grep: "grep_search",
  Task: "invoke_agent",
  TodoWrite: "todowrite",
  WebFetch: "web_fetch",
  WebSearch: "web_search"
});

const TOOL_TABLES = Object.freeze({
  opencode: OPENCODE_TOOL_MAP,
  "claude-code": CLAUDE_TOOL_MAP
});

function normalizeToolName(name, agent) {
  const raw = String(name || "").trim();
  if (!raw) return "unknown_tool";
  const table = TOOL_TABLES[agent] || OPENCODE_TOOL_MAP;
  return table[raw] || table[raw.toLowerCase()] || raw;
}

// 规范工具名 -> 工具族（router 信号 / telemetry tool_family 用）。
const TOOL_FAMILY = Object.freeze({
  read_file: "read",
  grep_search: "search",
  glob_search: "search",
  list_directory: "search",
  run_shell_command: "bash",
  write_file: "edit",
  replace: "edit",
  apply_patch: "edit",
  invoke_agent: "agent",
  web_fetch: "web",
  web_search: "web",
  skill: "skill",
  todowrite: "todo",
  todoread: "todo",
  question: "question",
  lsp: "lsp"
});

function canonicalToolFamily(toolName) {
  return TOOL_FAMILY[toolName] || "other";
}

module.exports = {
  CLAUDE_TOOL_MAP,
  TOOL_TABLES,
  TOOL_FAMILY,
  normalizeToolName,
  canonicalToolFamily
};
