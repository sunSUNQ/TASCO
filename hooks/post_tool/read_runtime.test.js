"use strict";

// ============================================================================
// read_runtime.test.js — Line-6 Read Runtime Integration orchestrator 单测
// ============================================================================
// 纯函数层：R4 freshness guard + R1/R2/R3/R5 策略腿的组合决策。
// 运行：node --test deploy/hooks/post_tool/read_runtime.test.js
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { decideReadDelivery, contentHash, taskTerms, canonicalReadText } = require("./read_runtime.js");

const MAP_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "pilot_manifests",
  "fastify_lib_moduledeps_identity_v1.json"
);
const MODULE_MAP = fs.readFileSync(MAP_PATH, "utf8");
const R1_FILE = path.join(__dirname, "..", "..", "..", "compression_lab", "repo", "read_lab", "r1.js");

function numberedRead(filePath, source) {
  const lines = String(source).split(/\r?\n/);
  const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
  return `<path>${filePath}</path>\n${numbered}\n`;
}

const R1_TASK =
  "Read read_lab/r1.js and analyze parseConnectionString: what default port does it use for each scheme, and when is tls enabled? Do not modify code.";
const R2_TASK =
  "Read-only analysis of Fastify request dispatch. Starting at lib/route.js, trace the bounded one-hop internal dependency path that passes a request into processing. Identify how route dispatch reaches handle-request, validation/hooks, and error handling. Do not modify files.";
const R3_TASK =
  "分析这个仓库中 lib/wrap-thenable.js 包装的 thenable 错误最终交给哪个模块处理，包装层自身的依赖是什么。梳理实现链路。不要修改代码。";
const R5_TASK =
  "Read docs/api_v2.md and report the required header for creating a v2 order, and state when the v1 endpoints are removed. Only use the document. Do not modify code.";
const R5_TASK_NO_ANCHOR =
  "阅读 docs/api_v2.md：创建 v2 订单的必填请求头是什么？v1 端点何时被移除？只回答文档里有依据的部分。不要修改代码。";
const R0_TASK = "Summarize this project for a new team member onboarding overview.";

test("R4 guard: same file + same range + unchanged -> suppress with auditable note (no code content)", () => {
  const text = numberedRead("read_lab/r1.js", fs.readFileSync(R1_FILE, "utf8"));
  const first = decideReadDelivery({
    task_text: R1_TASK,
    tool_input: { file_path: "read_lab/r1.js", start_line: 1, end_line: 700 },
    tool_text: text,
    previous: null,
    module_map: null,
  });
  assert.equal(first.action, "replace"); // R1 primary applies on first read
  const second = decideReadDelivery({
    task_text: "Read read_lab/r1.js again - has anything changed? Just confirm. Do not modify code.",
    tool_input: { file_path: "read_lab/r1.js", start_line: 1, end_line: 700 },
    tool_text: text,
    previous: first.record,
    module_map: null,
  });
  assert.equal(second.task_class, "R4_repeat_read");
  assert.equal(second.strategy, "repeat_suppression");
  assert.equal(second.action, "suppress");
  assert.match(second.delivered, /\[READ_SUPPRESSED\]/);
  assert.ok(!/parseConnectionString/.test(second.delivered), "suppress note carries no code content");
});

test("R4 guard: changed content -> refresh (never suppress stale)", () => {
  const text1 = numberedRead("lib/reply.js", "function a() {\n  return 1;\n}\n");
  const text2 = numberedRead("lib/reply.js", "function a() {\n  return 2;\n}\n");
  const first = decideReadDelivery({
    task_text: R1_TASK,
    tool_input: { file_path: "lib/reply.js", start_line: 1, end_line: 4 },
    tool_text: text1,
    previous: null,
    module_map: null,
  });
  const second = decideReadDelivery({
    task_text: "Read lib/reply.js again - has anything changed? Just confirm. Do not modify code.",
    tool_input: { file_path: "lib/reply.js", start_line: 1, end_line: 4 },
    tool_text: text2,
    previous: first.record,
    module_map: null,
  });
  assert.equal(second.action, "native", "changed content must re-deliver raw");
  assert.equal(second.reason, "r4_refresh");
  assert.equal(second.record.content_hash, contentHash(text2), "ledger updated to new fingerprint");
});

test("R4 guard: missing range/hash info -> fail-open deliver (no guessing)", () => {
  const text = numberedRead("lib/reply.js", "function a() {}\n");
  const d = decideReadDelivery({
    task_text: R0_TASK,
    tool_input: { file_path: "lib/reply.js" },
    tool_text: text,
    previous: { path: "lib/reply.js", content_hash: "unknown", ranges: [[1, 1]] },
    module_map: null,
  });
  assert.equal(d.action, "native");
});

test("R1: task-derived symbols drive extraction (R1-WIRING-1 semantics)", () => {
  const text = numberedRead("read_lab/r1.js", fs.readFileSync(R1_FILE, "utf8"));
  const d = decideReadDelivery({
    task_text: R1_TASK,
    tool_input: { file_path: "read_lab/r1.js" },
    tool_text: text,
    previous: null,
    module_map: null,
  });
  assert.equal(d.task_class, "R1_local_target");
  assert.equal(d.action, "replace");
  assert.match(d.delivered, /\[EXTRACTIVE READ v1\]/);
  assert.match(d.delivered, /parseConnectionString/);
  assert.ok(d.delivered.length < text.length * 0.35, `reduction: ${d.delivered.length}`);
});

test("R1 negative: task symbols absent in the read file -> native (no keep-first guessing)", () => {
  const other = numberedRead("read_lab/unrelated.js", "function totallyDifferent() {\n  return 9;\n}\n".repeat(40));
  const d = decideReadDelivery({
    task_text: R1_TASK,
    tool_input: { file_path: "read_lab/unrelated.js" },
    tool_text: other,
    previous: null,
    module_map: null,
  });
  assert.equal(d.action, "native");
  assert.equal(d.reason, "r1_task_symbols_absent_in_file");
});

test("R2: relation edges from identity map; wrong task class never reaches R2", () => {
  const big = numberedRead("lib/route.js", "const x = 1;\n".repeat(800));
  const d = decideReadDelivery({
    task_text: R2_TASK,
    tool_input: { file_path: "lib/route.js" },
    tool_text: big,
    previous: null,
    module_map: MODULE_MAP,
  });
  assert.equal(d.task_class, "R2_call_relation");
  assert.equal(d.action, "replace");
  assert.match(d.delivered, /\[READ_RELATION_EVIDENCE\]/);
  assert.match(d.delivered, /lib\/route\.js -> lib\/handle-request\.js/);

  const wrong = decideReadDelivery({
    task_text: R1_TASK,
    tool_input: { file_path: "lib/route.js" },
    tool_text: big,
    previous: null,
    module_map: MODULE_MAP,
  });
  assert.notEqual(wrong.strategy, "relation_evidence", "wrong_strategy=0");
});

test("R2 negative: missing map -> native (no hallucinated edges)", () => {
  const big = numberedRead("lib/route.js", "const x = 1;\n".repeat(800));
  const d = decideReadDelivery({
    task_text: R2_TASK,
    tool_input: { file_path: "lib/route.js" },
    tool_text: big,
    previous: null,
    module_map: null,
  });
  assert.equal(d.action, "native");
  assert.equal(d.reason, "relation_evidence_unresolved");
});

test("R2 scope guard: read of a NON-entry file stays native (no evidence hijack)", () => {
  const other = numberedRead("lib/handle-request.js", "const h = 1;\n".repeat(800));
  const d = decideReadDelivery({
    task_text: R2_TASK,
    tool_input: { file_path: "lib/handle-request.js" },
    tool_text: other,
    previous: null,
    module_map: MODULE_MAP,
  });
  assert.equal(d.action, "native");
  assert.equal(d.reason, "relation_evidence_file_mismatch");
});

test("R3: implementation chain from map (1-2 hops, bounded)", () => {
  const big = numberedRead("lib/wrap-thenable.js", "const t = 1;\n".repeat(800));
  const d = decideReadDelivery({
    task_text: R3_TASK,
    tool_input: { file_path: "lib/wrap-thenable.js" },
    tool_text: big,
    previous: null,
    module_map: MODULE_MAP,
  });
  assert.equal(d.task_class, "R3_implementation_chain");
  assert.equal(d.action, "replace");
  assert.match(d.delivered, /\[READ_IMPLEMENTATION_CHAIN\]/);
  assert.ok(d.delivered.split("\n").length <= 32, "bounded delivery");
});

test("R5: section extraction on REAL unnumbered doc reads; numbered canon would break headings (pinned)", () => {
  const md = [
    "# API v2",
    "",
    "## Creating orders",
    "Required header: Idempotency-Key.",
    "Auth uses Bearer tokens for all v2 endpoints.",
    "",
    "## Rate limits",
    "1000 req/min per key.",
    "",
    "## Unrelated section",
    "Nothing relevant here at all.",
    "",
  ].join("\n").repeat(30);
  // R5 消费未编号原文（真实 Claude read_file 形态；编号行会破坏 heading 解析）
  const text = md;
  const d = decideReadDelivery({
    task_text: R5_TASK,
    tool_input: { file_path: "docs/api_v2.md" },
    tool_text: text,
    previous: null,
    module_map: null,
  });
  assert.equal(d.task_class, "R5_section_read");
  assert.equal(d.action, "replace");
  assert.match(d.delivered, /\[READ_SECTION_EXTRACTION\]/);
  assert.match(d.delivered, /Idempotency-Key/);
  assert.ok(!/1000 req\/min/.test(d.delivered), "unrelated sections dropped");

  // 诚实边界：prompt 无词法锚点（zh 散词，文档为英文）→ 无命中 → native。
  const d2 = decideReadDelivery({
    task_text: R5_TASK_NO_ANCHOR,
    tool_input: { file_path: "docs/api_v2.md" },
    tool_text: text,
    previous: null,
    module_map: null,
  });
  assert.equal(d2.task_class, "R5_section_read");
  assert.equal(d2.action, "native");
});

test("R1 canon adapter: real Claude unnumbered read gets numbered canon (R1-WIRING-1 on real shape)", () => {
  const unnumbered = fs.readFileSync(R1_FILE, "utf8");
  assert.ok(!/^\s*\d+:\s/m.test(unnumbered), "fixture starts unnumbered (real Claude shape)");
  const d = decideReadDelivery({
    task_text: R1_TASK,
    tool_input: { file_path: "read_lab/r1.js" },
    tool_text: unnumbered,
    previous: null,
    module_map: null,
  });
  assert.equal(d.action, "replace");
  assert.match(d.delivered, /\[EXTRACTIVE READ v1\]/);
  assert.match(d.delivered, /parseConnectionString/);
  assert.match(d.delivered, /443/, "ground truth port preserved via canon numbering");
  const canon = canonicalReadText(unnumbered, "read_lab/r1.js");
  assert.match(canon, /^<path>read_lab\/r1\.js<\/path>/);
  assert.ok(!/^1: </m.test(canon.replace(/^<path>[^\n]*<\/path>\n/, "")), "canon has no double path header");
});

test("R0: unclassifiable task stays native (default native principle)", () => {
  const big = numberedRead("lib/route.js", "const x = 1;\n".repeat(800));
  const d = decideReadDelivery({
    task_text: R0_TASK,
    tool_input: { file_path: "lib/route.js" },
    tool_text: big,
    previous: null,
    module_map: MODULE_MAP,
  });
  assert.equal(d.task_class, "R0_unclassified");
  assert.equal(d.action, "native");
  assert.ok(d.record, "R4 ledger still recorded for native delivery");
});

test("determinism: identical inputs -> byte-identical decisions", () => {
  const text = numberedRead("read_lab/r1.js", fs.readFileSync(R1_FILE, "utf8"));
  const a = decideReadDelivery({ task_text: R1_TASK, tool_input: { file_path: "read_lab/r1.js" }, tool_text: text, previous: null, module_map: null });
  const b = decideReadDelivery({ task_text: R1_TASK, tool_input: { file_path: "read_lab/r1.js" }, tool_text: text, previous: null, module_map: null });
  assert.deepEqual(a, b);
});

test("taskTerms: scope path segments are not terms", () => {
  const terms = taskTerms("阅读 docs/api_v2.md：创建 v2 订单的必填请求头是什么？");
  assert.ok(!terms.includes("docs"), "path segment excluded");
  assert.ok(terms.includes("api_v2.md"), "file name kept");
});
