"use strict";

// Read-only Claude persisted-output transport observer.  This is deliberately
// separate from routing and compression: it records transport fidelity only
// and never returns updatedToolOutput or reads a guessed/recent session file.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.content === "string") return value.content;
  if (typeof value.text === "string") return value.text;
  return "";
}

function baseDir() {
  return process.env.CODE_GUARD_BASE_DIR || path.join(process.cwd(), ".code-guard");
}

function append(record) {
  try {
    const file = path.join(baseDir(), "context_budget", "claude_transport_fidelity.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch (_e) {}
}

function measurement(value) {
  const text = textOf(value);
  return { chars: text.length, lines: text ? text.split(/\r?\n/).length : 0, sha256: sha256(text) };
}

// Structural-only schema capture: never persists values, only their JSON
// paths, types, cardinality, and one-way fingerprints for string leaves.
function shapeFingerprint(value, at = "$") {
  if (value === null) return [{ path: at, type: "null" }];
  if (typeof value === "string") {
    return [{ path: at, type: "string", chars: value.length, sha256: sha256(value), likely_content: /(^|\.)(content|output|stdout|text)$/i.test(at) }];
  }
  if (typeof value !== "object") return [{ path: at, type: typeof value }];
  if (Array.isArray(value)) {
    return [{ path: at, type: "array", length: value.length }, ...value.flatMap((item, i) => shapeFingerprint(item, `${at}[${i}]`))];
  }
  const entries = Object.entries(value);
  return [{ path: at, type: "object", keys: entries.map(([key]) => key).sort() }, ...entries.flatMap(([key, item]) => shapeFingerprint(item, `${at}.${key}`))];
}

function allowedTranscript(transcriptPath, sessionId) {
  if (!transcriptPath || !sessionId || !path.isAbsolute(transcriptPath)) return null;
  const resolved = path.resolve(transcriptPath);
  const parts = resolved.toLowerCase().split(path.sep);
  const claude = parts.lastIndexOf(".claude");
  const projects = claude >= 0 ? parts.indexOf("projects", claude + 1) : -1;
  if (projects < 0 || projects + 1 >= parts.length) return null;
  if (resolved.includes("..") || path.basename(resolved).toLowerCase() !== `${String(sessionId).toLowerCase()}.jsonl`) return null;
  return resolved;
}

// Scan only the event-provided current transcript.  A record is accepted only
// when its session and embedded tool_result id exactly equal the current event.
function transcriptResult(event) {
  const sessionId = String(event.session_id || "");
  const toolUseId = String(event.tool_use_id || "");
  const transcript = allowedTranscript(String(event.transcript_path || ""), sessionId);
  if (!toolUseId) return { status: "tool_use_id_unavailable" };
  if (!transcript) return { status: "transcript_rejected" };
  if (!fs.existsSync(transcript)) return { status: "transcript_unavailable" };
  let lines;
  try { lines = fs.readFileSync(transcript, "utf8").split(/\r?\n/); } catch (_e) { return { status: "transcript_unreadable" }; }
  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (String(entry.sessionId || "") !== sessionId) continue;
      const blocks = entry && entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
      const hit = blocks.find((b) => b && b.type === "tool_result" && String(b.tool_use_id || "") === toolUseId);
      if (!hit) continue;
      const actual = entry.toolUseResult && typeof entry.toolUseResult.content === "string"
        ? entry.toolUseResult.content : textOf(hit.content);
      const expectedPersisted = path.join(path.dirname(transcript), sessionId, "tool-results", `${toolUseId}.txt`);
      // This is not discovery: the allowed file name is deterministically
      // derived from the current transcript + current tool_use_id, and the
      // transcript's exact result must explicitly point at the same path.
      const wrapper = textOf(hit.content);
      const persisted = wrapper.includes(expectedPersisted) && fs.existsSync(expectedPersisted)
        ? measurement(fs.readFileSync(expectedPersisted, "utf8"))
        : { status: "not_available_at_ptu" };
      return { status: "exact_match", transcript_result: measurement(actual), persisted_result: persisted };
    } catch (_e) {}
  }
  return { status: "exact_match_not_landed" };
}

function observePostToolUse(event) {
  const response = event.tool_response;
  append({
    type: "claude_transport_fidelity",
    layer: "PostToolUse",
    session_id: String(event.session_id || ""),
    tool_use_id: String(event.tool_use_id || ""),
    tool_name: String(event.tool_name || ""),
    hook_response: measurement(response),
    hook_response_shape: Array.isArray(response) ? "array" : typeof response,
    shape_fingerprint: shapeFingerprint(response),
    transcript_at_ptu: transcriptResult(event),
    at: new Date().toISOString(),
  });
}

function observeUpdatedToolOutput(event, updatedToolOutput, metadata = {}) {
  append({
    type: "claude_transport_fidelity",
    layer: "PostToolUseUpdated",
    session_id: String(event.session_id || ""),
    tool_use_id: String(event.tool_use_id || ""),
    tool_name: String(event.tool_name || ""),
    updated_response: measurement(updatedToolOutput),
    updated_response_shape: Array.isArray(updatedToolOutput) ? "array" : typeof updatedToolOutput,
    ...metadata,
    at: new Date().toISOString(),
  });
}

function observePostToolBatch(event) {
  const sessionId = String(event.session_id || "");
  for (const call of Array.isArray(event.tool_calls) ? event.tool_calls : []) {
    append({
      type: "claude_transport_fidelity",
      layer: "PostToolBatch",
      session_id: sessionId,
      tool_use_id: String(call && call.tool_use_id || ""),
      tool_name: String(call && call.tool_name || ""),
      model_response: measurement(call && call.tool_response),
      model_response_shape: Array.isArray(call && call.tool_response) ? "array" : typeof (call && call.tool_response),
      at: new Date().toISOString(),
    });
  }
}

module.exports = { observePostToolUse, observeUpdatedToolOutput, observePostToolBatch, measurement, shapeFingerprint, transcriptResult };
