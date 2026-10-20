"use strict";

// Claude Native passthrough telemetry boundary.
// This adapter-only helper records an already-decided Native result through the
// frozen observability pipeline. It never invokes compression policy, creates a
// candidate, or returns a replacement to Claude Code.

const fsDefault = require("fs");
const pathDefault = require("path");
const runtimeDefault = require("../hooks/guard_core/runtime_paths");
const { createMetricsLogger } = require("../hooks/post_tool/observability/metrics_logger");
const { createCompressionMetrics } = require("../hooks/post_tool/observability/compression_metrics");
const { createSessionMetrics } = require("../hooks/post_tool/observability/session_metrics");

function textOf(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (value.file && typeof value.file === "object" && typeof value.file.content === "string") return value.file.content;
  if (typeof value.file === "string") return value.file;
  if (Array.isArray(value.filenames)) return value.filenames.join("\n");
  if (typeof value.stdout === "string") return [value.stdout, value.stderr].filter(Boolean).join("\n");
  if (typeof value.content === "string") return value.content;
  if (typeof value.output === "string") return value.output;
  if (Array.isArray(value.content)) return value.content.map((part) => typeof part === "string" ? part : part && part.text).filter((part) => typeof part === "string").join("\n");
  return "";
}

function createClaudeNativeObservability(deps = {}) {
  const fs = deps.fs || fsDefault;
  const path = deps.path || pathDefault;
  const runtime = deps.runtime || runtimeDefault;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const metrics = createMetricsLogger({
    fs,
    path,
    sessionPath: (...parts) => runtime.sessionPath(...parts),
    log,
    extractToolText: (payload) => textOf(payload && payload.tool_response),
    extractToolName: (payload) => String((payload && payload.tool_name) || "unknown_tool"),
    compressionMetrics: createCompressionMetrics({}),
    sessionMetrics: createSessionMetrics({
      fs,
      path,
      sessionPath: (...parts) => runtime.sessionPath(...parts),
      log,
    }),
  });

  function recordNative({ event, canonicalToolName, deliveredText }) {
    try {
      const source = event || {};
      const sessionId = String(source.session_id || source.sessionId || "");
      runtime.setActiveSessionId(sessionId);
      metrics.setPayload({
        session_id: sessionId,
        tool_use_id: String(source.tool_use_id || source.toolUseId || ""),
        tool_name: String(canonicalToolName || "unknown_tool"),
        tool_input: source.tool_input || source.toolInput || {},
        tool_response: source.tool_response,
      });
      metrics.finalize({
        text: "",
        replaceOutput: false,
        delivered: deliveredText == null ? textOf(source.tool_response) : String(deliveredText),
        reason: "native",
      });
      return true;
    } catch (_e) {
      // Telemetry is fail-open: a logging failure must not alter Native output.
      return false;
    }
  }

  return { recordNative };
}

module.exports = { createClaudeNativeObservability, textOf };
