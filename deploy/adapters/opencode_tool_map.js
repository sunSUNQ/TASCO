"use strict";

// OpenCode V1 内置工具名 -> 治理内部规范名。
// apply_patch / todowrite / skill / question / lsp 等 opencode 特有工具保留原名,
// 治理入口对未知工具默认放行(fail-open),避免误拦。
const OPENCODE_TOOL_MAP = Object.freeze({
  bash: "run_shell_command",
  read: "read_file",
  write: "write_file",
  edit: "replace",
  multiedit: "replace",
  glob: "glob_search",
  grep: "grep_search",
  list: "list_directory",
  task: "invoke_agent",
  webfetch: "web_fetch",
  websearch: "web_search",
  apply_patch: "apply_patch",
  todowrite: "todowrite",
  todoread: "todoread",
  skill: "skill",
  question: "question",
  lsp: "lsp"
});

function mapOpenCodeToolName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "unknown_tool";
  return OPENCODE_TOOL_MAP[raw] || OPENCODE_TOOL_MAP[raw.toLowerCase()] || raw;
}

module.exports = { OPENCODE_TOOL_MAP, mapOpenCodeToolName };
