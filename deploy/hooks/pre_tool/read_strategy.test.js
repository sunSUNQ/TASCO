"use strict";

// Line-6 任务驱动 Read — R1-R5 映射冻结回归（确定性、无模型）。
// Corpus: pilot_manifests/read_task_driven_corpus_v1.json（5 类 × 真实 fixture ×
// 可验证结论）。Gate：corpus 分类 100% 命中预期类、R0 兜底 Native、确定性。
// 运行：node --test deploy/hooks/pre_tool/read_strategy.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { classifyReadTask, STRATEGIES } = require("./read_strategy.js");

const corpus = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "..", "pilot_manifests", "read_task_driven_corpus_v1.json"), "utf8")
);

test("corpus sanity: 5 classes present with >=2 tasks each", () => {
  const byClass = {};
  for (const t of corpus.tasks) byClass[t.class] = (byClass[t.class] || 0) + 1;
  for (const cls of ["R1", "R2", "R3", "R4", "R5"]) {
    assert.ok(byClass[cls] >= 2, `${cls} needs >=2 tasks, got ${byClass[cls] || 0}`);
  }
  assert.equal(corpus.tasks.length, 16);
});

const EXPECTED_CLASS = {
  R1: "R1_local_target",
  R2: "R2_call_relation",
  R3: "R3_implementation_chain",
  R4: "R4_repeat_read",
  R5: "R5_section_read",
};

test("mapping freeze: every corpus task classifies to its expected class/strategy", () => {
  for (const t of corpus.tasks) {
    const r = classifyReadTask(t.prompt);
    assert.equal(r.task_class, EXPECTED_CLASS[t.class], `${t.id}: class mismatch (${r.task_class})`);
    assert.equal(r.strategy, t.expected_strategy, `${t.id}: strategy mismatch (${r.strategy})`);
    assert.equal(r.suppressed, false, `${t.id}: corpus tasks must classify, not fall back`);
  }
});

test("R0 fallback: non-read / unclassifiable tasks stay native", () => {
  for (const prompt of [
    "Run the validation suite and report pass/fail counts.",
    "",
    "Summarize today's weather and write a haiku.",
  ]) {
    const r = classifyReadTask(prompt);
    assert.equal(r.strategy, STRATEGIES.R0);
    assert.equal(r.suppressed, true, "unclassified must be suppressed (native)");
  }
});

test("priority order: repeat-read wins over chain/doc signals; chain wins over doc", () => {
  // R4 优先于 R5：同一个 prompt 同时含 re-read 与 .md 文档。
  const r45 = classifyReadTask("Re-read docs/api_v2.md again and confirm whether the file has changed since I last read it.");
  assert.equal(r45.task_class, "R4_repeat_read");
  // R3 优先于 R2：wrapper/实现链信号压过通用调用链词。
  const r32 = classifyReadTask("Trace the call chain from this wrapper module to the actual implementation it delegates to. Do not modify code.");
  assert.equal(r32.task_class, "R3_implementation_chain");
  // R2 优先于 R5：调用链任务里提到 docs/ 不改变分类。
  const r25 = classifyReadTask("Trace the caller/callee relationship described in docs/legacy-migration.md. Do not modify code.");
  assert.equal(r25.task_class, "R2_call_relation");
});

test("determinism: identical prompt -> identical classification", () => {
  const t = corpus.tasks[0];
  const a = classifyReadTask(t.prompt);
  const b = classifyReadTask(t.prompt);
  assert.deepEqual(a, b);
});
