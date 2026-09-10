"use strict";

// Line-6 Read Strategy Arbitration — C1-C10 conflict suite (deterministic).
// The frozen classifier IS the single-winner selector: one read request ->
// at most one primary strategy (priority R4 > R3 > R2 > R5 > R1 > R0).
// R4 additionally acts as the delivery-level freshness guard (composable with
// any primary strategy), gated by the R4 primitive (never double-suppress).
// 运行：node --test deploy/hooks/pre_tool/read_arbitration.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyReadTask } = require("./read_strategy.js");
const { decideRepeatRead } = require("../post_tool/read_repeat_suppression.js");

const H = "aaaabbbbccccdddd1111222233334444";

test("C1: local edit -> R1 (extractive)", () => {
  const r = classifyReadTask("Fix the bug in lib/reply.js: read the send function first and analyze its branch logic. Do not modify code.");
  assert.equal(r.task_class, "R1_local_target");
  assert.equal(r.strategy, "extractive_read");
});

test("C2: call chain -> R2 (relation evidence)", () => {
  const r = classifyReadTask("分析 lib/handle-request.js 的调用链：请求进入后经过哪些模块，错误向哪条路径传播。不要修改代码。");
  assert.equal(r.task_class, "R2_call_relation");
  assert.equal(r.strategy, "relation_evidence");
});

test("C3: wrapper implementation -> R3 (implementation chain)", () => {
  const r = classifyReadTask("这个 API 是否只是 wrapper？从 lib/plugin-override.js 追到真实实现，说明最终交给哪个模块处理。不要修改代码。");
  assert.equal(r.task_class, "R3_implementation_chain");
  assert.equal(r.strategy, "implementation_chain");
});

test("C4: repeat unchanged -> R4 + primitive suppress", () => {
  const r = classifyReadTask("再读一次 lib/reply.js，确认与本次会话之前读取的内容相比是否有变化。不要修改代码。");
  assert.equal(r.task_class, "R4_repeat_read");
  const d = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 200]] },
    request: { path: "lib/reply.js", start_line: 1, end_line: 200, content_hash: H },
  });
  assert.equal(d.action, "suppress");
});

test("C5: section-specific doc -> R5 (section extraction)", () => {
  const r = classifyReadTask("阅读 docs/api_v2.md：创建 v2 订单的必填请求头是什么？不要修改代码。");
  assert.equal(r.task_class, "R5_section_read");
  assert.equal(r.strategy, "section_extraction");
});

test("C6: unknown -> Native", () => {
  const r = classifyReadTask("Run the validation suite and report pass/fail counts.");
  assert.equal(r.task_class, "R0_unclassified");
  assert.equal(r.strategy, "native");
  assert.equal(r.suppressed, true);
});

test("C7: local edit + dependency-rich module -> R1 (never misdirected to R2 by structure)", () => {
  // The module name hints at rich dependencies, but the task semantics are a
  // single-symbol local fix: R1 must win.
  const r = classifyReadTask("修复 lib/route.js 中 handleRequest 分支的默认端口问题：先读相关函数，说明现有逻辑。不要真的修改文件。");
  assert.equal(r.task_class, "R1_local_target", "structural complexity must not flip R1 to R2");
});

test("C8: call chain + large file -> R2 (never misdirected to R1 by file size)", () => {
  // "large file" / size wording is irrelevant: chain semantics decide.
  const r = classifyReadTask("分析这个 3000 行大文件 lib/handle-request.js 的调用关系：请求经过哪些模块、错误传播到哪。不要修改代码。");
  assert.equal(r.task_class, "R2_call_relation");
});

test("C9: wrapper + call-chain wording -> unique winner per frozen contract (R3 > R2)", () => {
  const r = classifyReadTask("分析 lib/plugin-override.js 的调用关系：这个封装模块是否只是 wrapper，真实实现在哪里。不要修改代码。");
  assert.equal(r.task_class, "R3_implementation_chain", "frozen precedence: wrapper/implementation intent outranks generic chain wording");
  assert.equal(r.strategy, "implementation_chain");
});

test("C10: repeated read after file changed -> R4 + primitive refresh (no false suppression)", () => {
  const r = classifyReadTask("再读一次 lib/reply.js，确认与之前相比是否有变化。不要修改代码。");
  assert.equal(r.task_class, "R4_repeat_read");
  const d = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 200]] },
    request: { path: "lib/reply.js", start_line: 1, end_line: 200, content_hash: "ffffeeee000011112222333344445555" },
  });
  assert.equal(d.action, "refresh", "changed content must refresh, never suppress");
});

test("composition: primary strategy + R4 freshness guard (no double content suppression)", () => {
  // First read: R1 extraction delivered for lines 1-200 (hash H recorded).
  // Second identical read: R4 guard suppresses once — the suppression note
  // carries NO code content (double content suppression impossible).
  const first = decideRepeatRead({ previous: null, request: { path: "lib/reply.js", start_line: 1, end_line: 200, content_hash: H } });
  assert.equal(first.action, "deliver");
  const second = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 200]] },
    request: { path: "lib/reply.js", start_line: 1, end_line: 200, content_hash: H },
  });
  assert.equal(second.action, "suppress");
  assert.ok(!/\d+: /m.test(second.note), "suppression note contains no code content");
});
