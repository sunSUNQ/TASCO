// ============================================================================
// guard_core/log.js — Logging utilities for pre_tool_policy_hook.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const { sessionPath } = require("./runtime_paths");

/**
 * Append a timestamped message to the log file.
 * @param {string} msg
 */
function log(msg) {
  const file = sessionPath("before_tool_large_file_guard.log");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
}

module.exports = { log }; 
