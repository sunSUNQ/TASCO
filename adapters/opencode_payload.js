"use strict";

const { mapOpenCodeToolName } = require("./opencode_tool_map");

function resolveCwd(ctx, fallback) {
  return (ctx && (ctx.directory || ctx.worktree)) || fallback || process.cwd();
}

function buildBeforePayload(input, output, ctx) {
  const args = (output && output.args) || (input && input.args) || {};
  const payload = {
    hook_event_name: "BeforeTool",
    hookEventName: "BeforeTool",
    session_id: (input && input.sessionID) || "",
    cwd: resolveCwd(ctx),
    transcript_path: "",
    tool_name: mapOpenCodeToolName(input && input.tool),
    tool_input: args
  };
  if (input && input.userQuery) {
    payload.user_query = String(input.userQuery).slice(0, 1000);
  }
  return payload;
}

function buildAfterPayload(input, output, ctx) {
  const args = (input && input.args) || {};
  const raw = (output && output.output) || "";
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return {
    hook_event_name: "AfterTool",
    hookEventName: "AfterTool",
    session_id: (input && input.sessionID) || "",
    cwd: resolveCwd(ctx),
    transcript_path: "",
    tool_name: mapOpenCodeToolName(input && input.tool),
    tool_input: args,
    output: text,
    tool_response: { content: text }
  };
}

module.exports = { buildBeforePayload, buildAfterPayload, resolveCwd };
