"use strict";

// ============================================================================
// claude_bridge_read_compression.test.js — Line-6 Read Runtime Integration
// ============================================================================
// 真实 spawn claude_bridge（stdin event -> stdout hook result），验证：
//   flag OFF : read 事件逐字节 legacy（无 read leg、无压缩行）
//   flag ON  : R1/R2/R5 策略腿 model-visible 交付；R4 跨调用 suppress /
//              refresh；R0 native；UserPromptSubmit 分类持久化
// 运行：node --test deploy/adapters/claude_bridge_read_compression.test.js
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const BRIDGE = path.join(__dirname, "claude_bridge.js");
const HOOK_DIR = path.join(__dirname, "..", "hooks");
const ROOT = path.join(__dirname, "..", "..");
const R1_FILE = path.join(ROOT, "compression_lab", "repo", "read_lab", "r1.js");
const MAP_FILE = path.join(ROOT, "pilot_manifests", "fastify_lib_moduledeps_identity_v1.json");
const API_DOC = path.join(ROOT, "hook_ab_test", "enterprise_test_repo", "docs", "api_v2.md");

const R1_TASK =
  "Read read_lab/r1.js and analyze parseConnectionString: what default port does it use for each scheme, and when is tls enabled? Do not modify code.";
const R1_TASK_AGAIN =
  "I already read read_lab/r1.js earlier in this session; read it again to double-check the parseConnectionString port logic. Do not modify code.";
const R2_TASK =
  "Read-only analysis of Fastify request dispatch. Starting at lib/route.js, trace the bounded one-hop internal dependency path that passes a request into processing. Identify how route dispatch reaches handle-request, validation/hooks, and error handling. Do not modify files.";
const R5_TASK =
  "Read docs/api_v2.md and report the required header for creating a v2 order, and state when the v1 endpoints are removed. Only use the document. Do not modify code.";
const R0_TASK = "Give me a general onboarding overview of this project.";

const r1Raw = fs.readFileSync(R1_FILE, "utf8");
const apiDocRaw = fs.readFileSync(API_DOC, "utf8");
const routeRaw = "const routeOptions = require('./route-options');\n".repeat(400);

function readEvent(sessionId, over = {}) {
  return {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    cwd: process.cwd(),
    tool_name: "Read",
    tool_input: { file_path: "read_lab/r1.js" },
    tool_response: {
      type: "text",
      file: { filePath: "read_lab/r1.js", content: r1Raw, numLines: r1Raw.split(/\r?\n/).length },
    },
    ...over,
  };
}

function runBridgeIn(base, event, extraEnv = {}) {
  const env = {
    ...process.env,
    CODE_GUARD_BASE_DIR: base,
    CODE_GUARD_HOOK_DIR: HOOK_DIR,
    CODE_GUARD_AUTO_CANARY_V1A: "1",
    CODE_GUARD_AUTO_CANARY_APPLY_POLICY: "current",
    CODE_GUARD_TERMINAL_STATE: "",
    CODE_GUARD_VALIDATION_DELTA: "",
    CODE_GUARD_FAILURE_CARRIER_AUTO: "",
    CODE_GUARD_SEARCH_GUIDANCE: "",
    CODE_GUARD_CLAUDE_PROMPT: R1_TASK,
    ...extraEnv,
  };
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env,
    encoding: "utf8",
    timeout: 120000,
  });
  return { env, res };
}

function runBridge(event, extraEnv = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "read-int-"));
  const { env, res } = runBridgeIn(base, event, extraEnv);
  return { base, env, res };
}

function parseOut(res) {
  return JSON.parse(String(res.stdout).trim() || "{}");
}

function deliveredText(out) {
  const u = out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput;
  if (typeof u === "string") return u;
  if (u && u.file && typeof u.file.content === "string") return u.file.content;
  return (u && (u.content || u.stdout)) || null;
}

function rows(base, session, name) {
  const f = path.join(base, "context_budget", "claude_auto_canary.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.type === name);
}

test("flag OFF: read event stays legacy native (no read leg, no compression row)", () => {
  const { base, res } = runBridge(readEvent("sess-off"), { CODE_GUARD_READ_COMPRESSION: "" });
  assert.equal(res.status, 0, String(res.stderr).slice(0, 300));
  const out = parseOut(res);
  assert.equal(out.hookSpecificOutput, undefined, "no replacement when flag off");
  assert.equal(rows(base, "sess-off", "compression").filter((r) => r.capability === "read_task_compression").length, 0);
});

test("flag ON + R1 task: task-symbol extraction delivered model-visible", () => {
  const { base, res } = runBridge(readEvent("sess-r1"), { CODE_GUARD_READ_COMPRESSION: "1" });
  assert.equal(res.status, 0, String(res.stderr).slice(0, 300));
  const out = parseOut(res);
  const delivered = deliveredText(out);
  assert.ok(delivered, "model-visible replacement delivered");
  assert.match(delivered, /\[EXTRACTIVE READ v1\]/);
  assert.match(delivered, /parseConnectionString/, "task symbol preserved");
  assert.ok(delivered.length < r1Raw.length, "reduced");
  const comp = rows(base, "sess-r1", "compression").filter((r) => r.capability === "read_task_compression");
  assert.equal(comp.length, 1);
  assert.equal(comp[0].read_strategy, "extractive_read");
  assert.equal(comp[0].transport_replacement_emitted, true);
  const arb = rows(base, "sess-r1", "auto_arbitration_v1");
  assert.ok(arb.some((r) => r.applied_capability === "read_task_compression"), "arbitration applied read capability");
});

test("flag ON + R4: second identical read suppressed; changed content refreshes", () => {
  const sid = "sess-r4";
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "read-r4-"));

  // first read (R1 primary applies; R4 ledger records the delivery)
  const res1 = runBridgeIn(base, readEvent(sid), { CODE_GUARD_READ_COMPRESSION: "1" }).res;
  assert.equal(res1.status, 0, String(res1.stderr).slice(0, 300));
  const d1 = deliveredText(parseOut(res1));
  assert.ok(d1 && d1.includes("[EXTRACTIVE READ v1]"), "first read delivered extraction");

  // second identical read (fresh process, same session state) -> R4 suppress
  const res2 = runBridgeIn(
    base,
    readEvent(sid, { tool_input: { file_path: "read_lab/r1.js", offset: 1, limit: r1Raw.split(/\r?\n/).length } }),
    { CODE_GUARD_READ_COMPRESSION: "1", CODE_GUARD_CLAUDE_PROMPT: R1_TASK_AGAIN }
  ).res;
  assert.equal(res2.status, 0, String(res2.stderr).slice(0, 300));
  const d2 = deliveredText(parseOut(res2));
  assert.ok(d2, "suppress note delivered");
  assert.match(d2, /\[READ_SUPPRESSED\]/);
  assert.ok(!/parseConnectionString/.test(d2), "suppress note carries no code content");
  const comp2 = rows(base, sid, "compression").filter((r) => r.capability === "read_task_compression");
  assert.equal(comp2[comp2.length - 1].read_strategy, "repeat_suppression");

  // changed content -> refresh (never suppress stale): raw re-delivered
  const changed = `// TAMPERED-MARKER-9f3\n${r1Raw}`;
  const out3 = parseOut(
    runBridgeIn(
      base,
      readEvent(sid, { tool_response: { type: "text", file: { filePath: "read_lab/r1.js", content: changed } } }),
      { CODE_GUARD_READ_COMPRESSION: "1", CODE_GUARD_CLAUDE_PROMPT: R1_TASK_AGAIN }
    ).res
  );
  const d3 = deliveredText(out3);
  assert.equal(
    out3.hookSpecificOutput,
    undefined,
    "changed content must re-deliver raw (native passthrough)"
  );
  assert.equal(d3, null);
});

test("flag ON + R2 task: relation evidence from map replaces the read", () => {
  const { base, res } = runBridge(
    readEvent("sess-r2", {
      tool_input: { file_path: "lib/route.js" },
      tool_response: { type: "text", file: { filePath: "lib/route.js", content: routeRaw } },
    }),
    {
      CODE_GUARD_READ_COMPRESSION: "1",
      CODE_GUARD_CLAUDE_PROMPT: R2_TASK,
      CODE_GUARD_STRUCTURAL_MAP: MAP_FILE,
    }
  );
  assert.equal(res.status, 0, String(res.stderr).slice(0, 300));
  const delivered = deliveredText(parseOut(res));
  assert.ok(delivered, "evidence delivered");
  assert.match(delivered, /\[READ_RELATION_EVIDENCE\]/);
  assert.match(delivered, /lib\/route\.js -> lib\/handle-request\.js/);
  const comp = rows(base, "sess-r2", "compression").filter((r) => r.capability === "read_task_compression");
  assert.equal(comp[0].read_strategy, "relation_evidence");
});

test("flag ON + R5 task: relevant sections extracted from real doc", () => {
  // 真实 api_v2.md 仅 406 chars（< 3000 阈值 → native 正确）；R5 正区需要
  // 大文档——用真实 doc 内容放大到阈值以上（wiring 测试；真实 A/B 用大文档 fixture）。
  const bigDoc = apiDocRaw.repeat(30);
  const { base, res } = runBridge(
    readEvent("sess-r5", {
      tool_input: { file_path: "docs/api_v2.md" },
      tool_response: { type: "text", file: { filePath: "docs/api_v2.md", content: bigDoc } },
    }),
    {
      CODE_GUARD_READ_COMPRESSION: "1",
      CODE_GUARD_CLAUDE_PROMPT: R5_TASK,
    }
  );
  assert.equal(res.status, 0, String(res.stderr).slice(0, 300));
  const delivered = deliveredText(parseOut(res));
  assert.ok(delivered, "sections delivered");
  assert.match(delivered, /\[READ_SECTION_EXTRACTION\]/);
  const comp = rows(base, "sess-r5", "compression").filter((r) => r.capability === "read_task_compression");
  assert.equal(comp[0].read_strategy, "section_extraction");
});

test("flag ON + R0 task: unclassifiable read stays native", () => {
  const { base, res } = runBridge(readEvent("sess-r0"), {
    CODE_GUARD_READ_COMPRESSION: "1",
    CODE_GUARD_CLAUDE_PROMPT: R0_TASK,
  });
  assert.equal(res.status, 0);
  const out = parseOut(res);
  assert.equal(out.hookSpecificOutput, undefined, "R0 stays native");
  const arb = rows(base, "sess-r0", "auto_arbitration_v1");
  assert.ok(arb.some((r) => r.fallback_reason === "read_delivery_fallback"));
});

test("UserPromptSubmit leg: classification persisted + telemetry; flag off writes nothing", () => {
  const on = runBridge(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-ups", prompt: R1_TASK },
    { CODE_GUARD_READ_COMPRESSION: "1" }
  );
  assert.equal(on.res.status, 0);
  const taskFile = path.join(on.base, "context_budget", "claude_read_task_sess-ups.json");
  assert.ok(fs.existsSync(taskFile), "task file persisted");
  const saved = JSON.parse(fs.readFileSync(taskFile, "utf8"));
  assert.equal(saved.strategy, "extractive_read");
  assert.ok(rows(on.base, "sess-ups", "read_strategy_selected").length === 1);

  const off = runBridge(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-ups2", prompt: R1_TASK },
    { CODE_GUARD_READ_COMPRESSION: "" }
  );
  assert.equal(off.res.status, 0);
  assert.ok(!fs.existsSync(path.join(off.base, "context_budget", "claude_read_task_sess-ups2.json")));
  assert.equal(rows(off.base, "sess-ups2", "read_strategy_selected").length, 0);
});
