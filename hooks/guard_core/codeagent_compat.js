"use strict";

const CODEAGENT_TOOL_MAP = Object.freeze({
  Bash: "run_shell_command",
  Read: "read_file",
  Write: "write_file",
  Edit: "replace",
  MultiEdit: "replace",
  NotebookEdit: "replace",
  Glob: "glob_search",
  Grep: "grep_search",
  Agent: "invoke_agent",
  Task: "invoke_agent",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
});

const LOWERCASE_TOOL_MAP = Object.freeze(
  Object.fromEntries(
    Object.entries(CODEAGENT_TOOL_MAP).map(([name, canonical]) => [name.toLowerCase(), canonical])
  )
);

function mapCodeAgentToolName(name) {
  const raw = String(name || "unknown_tool").trim();
  return CODEAGENT_TOOL_MAP[raw] || LOWERCASE_TOOL_MAP[raw.toLowerCase()] || raw;
}

module.exports = {
  CODEAGENT_TOOL_MAP,
  mapCodeAgentToolName,
};
