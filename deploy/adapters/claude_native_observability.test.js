"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");
const { createClaudeNativeObservability } = require("./claude_native_observability");

function runtimeAt(root) {
  let active = "";
  return {
    setActiveSessionId(id) { active = String(id || "").replace(/[^A-Za-z0-9._-]/g, "_"); },
    sessionPath(...parts) { return path.join(root, active, ...parts); },
  };
}

function readEvents(root, sessionId) {
  const file = path.join(root, sessionId, "tasco_metrics", "tasco_compression.ndjson");
  return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function readSummary(root, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(root, sessionId, "tasco_metrics", "session_summary.json"), "utf8"));
}

function nativeEvent(id, text = "native body") {
  return {
    session_id: "native-session",
    tool_use_id: id,
    tool_name: "Read",
    tool_input: { file_path: "lib/example.js" },
    tool_response: { file: { content: text } },
  };
}

test("W1 native event keeps delivered content and records zero saving", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tasco-native-w1-"));
  const telemetry = createClaudeNativeObservability({ runtime: runtimeAt(root) });
  const event = nativeEvent("tool-1", "const answer = 42;");
  assert.equal(telemetry.recordNative({ event, canonicalToolName: "read_file", deliveredText: "const answer = 42;" }), true);
  const row = readEvents(root, "native-session")[0];
  assert.equal(row.selected, false);
  assert.equal(row.applied, false);
  assert.equal(row.fallback, false);
  assert.equal(row.before_chars, row.delivered_chars);
  assert.equal(row.saved_chars, 0);
  assert.equal(row.reason, "native");
});

test("W2 two Native calls aggregate as native passthrough only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tasco-native-w2-"));
  const telemetry = createClaudeNativeObservability({ runtime: runtimeAt(root) });
  for (const id of ["tool-1", "tool-2"]) {
    const event = nativeEvent(id, `body ${id}`);
    telemetry.recordNative({ event, canonicalToolName: "read_file", deliveredText: `body ${id}` });
  }
  const summary = readSummary(root, "native-session");
  assert.equal(summary.total_calls, 2);
  assert.equal(summary.native_calls, 2);
  assert.equal(summary.selected_calls, 0);
  assert.equal(summary.applied_calls, 0);
  assert.equal(summary.saved_chars, 0);
});

test("W3 missing session writes audit event without a default summary bucket", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tasco-native-w3-"));
  const telemetry = createClaudeNativeObservability({ runtime: runtimeAt(root) });
  const event = nativeEvent("tool-1");
  event.session_id = "";
  telemetry.recordNative({ event, canonicalToolName: "read_file", deliveredText: "native body" });
  const file = path.join(root, "tasco_metrics", "tasco_compression.ndjson");
  const row = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(row.aggregation_skipped_reason, "missing_session_id");
  assert.equal(fs.existsSync(path.join(root, "tasco_metrics", "session_summary.json")), false);
});

test("W4 telemetry write failure remains fail-open", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tasco-native-w4-"));
  const failingFs = { ...fs, appendFileSync() { throw new Error("simulated telemetry failure"); } };
  const telemetry = createClaudeNativeObservability({ fs: failingFs, runtime: runtimeAt(root) });
  assert.doesNotThrow(() => telemetry.recordNative({
    event: nativeEvent("tool-1"),
    canonicalToolName: "read_file",
    deliveredText: "native body",
  }));
});
