"use strict";

// Line-5 精准代码搜索 — S1 历史正区复核 + S3 负区/冲突 Gate（确定性、无模型）。
// Corpus 全部来自历史已标注 manifest（pilot_manifests/，只读、仅测试引用）：
//   正区（历史 emission=1）：fd1-3（DISCOVERY v2 pilot）+ sd1a-6b（applicable pos）
//   负区（历史 emission=0）：fp1-3（LOOKUP 类，2026-08-31 边界修正）+ sn1-3 +
//                           英文枚举/统计/lookup 变体 + 跨能力干扰 prompt
// Gate：positive-zone recall = 100%（已知标注集）、negative FP = 0、
//       wrong_intent = 0、suppressed 输出零注入。
// 运行：node --test deploy/hooks/pre_tool/search_guidance_line5.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { buildSearchGuidance } = require("./search_guidance.js");

const PM = path.join(__dirname, "..", "..", "..", "pilot_manifests");

function loadTasks(file) {
  return JSON.parse(fs.readFileSync(path.join(PM, file), "utf8")).tasks.map((t) => ({
    id: t.id,
    prompt: t.prompt,
  }));
}

const POSITIVE_CORPUS = [
  ...loadTasks("search_fastify_pilot_discovery_v2.json"),
  ...loadTasks("search_fastify_applicable_pos.json"),
];

const NEGATIVE_CORPUS = [
  ...loadTasks("search_fastify_pilot_discovery_g0.json"),
  ...loadTasks("search_fastify_applicable_neg.json"),
  // 英文负区变体（枚举/统计/lookup）
  { id: "en-enum-all-callers", prompt: "List all callers of refreshToken in the codebase, complete list, do not omit any reference." },
  { id: "en-enum-all-usages", prompt: "Show every usage of validateOrder across all files with file and line for each." },
  { id: "en-stat-per-module", prompt: "Count how many times each module calls submitOrder and show the distribution per directory." },
  { id: "en-lookup-definition", prompt: "Find the definition of fooBar and locate its exact declaration." },
  // 跨能力干扰（非搜索任务不得触发 guidance）
  { id: "xcap-diagnostic", prompt: "Diagnose the root cause of this failing checkout suite." },
  { id: "xcap-validation", prompt: "Run the validation suite and report pass/fail counts." },
  { id: "xcap-edit", prompt: "Fix the boundary bug in lib/checkout.js and modify the code." },
];

test("S1: historical positive corpus (fd1-3 + sd1a-6b) all emit guidance", () => {
  assert.equal(POSITIVE_CORPUS.length, 15, "corpus size guard");
  for (const { id, prompt } of POSITIVE_CORPUS) {
    const g = buildSearchGuidance({ prompt });
    assert.equal(g.suppressed, false, `${id}: historical positive must still emit`);
    assert.ok(g.text.length > 0, `${id}: guidance text non-empty`);
    assert.match(g.text, /Search guidance:/, `${id}: frozen template header`);
    assert.match(g.text, /Task intent: discovery\./, `${id}: intent line (historical class = discovery)`);
    assert.equal(g.intent, "discovery", `${id}: intent unchanged from historical class`);
  }
});

test("S1: positive corpus includes the proven stable-economy anchors (fd2, sd5b)", () => {
  const ids = POSITIVE_CORPUS.map((c) => c.id);
  for (const anchor of ["fd2", "sd5b"]) {
    assert.ok(ids.includes(anchor), `stable anchor ${anchor} present`);
  }
});

test("S3: historical negative corpus (fp1-3 + sn1-3) must suppress (FP=0)", () => {
  for (const { id, prompt } of NEGATIVE_CORPUS) {
    const g = buildSearchGuidance({ prompt });
    assert.equal(g.suppressed, true, `${id}: negative/cross-capability prompt must suppress`);
    assert.equal(g.text, "", `${id}: zero injection on suppressed intent`);
    assert.ok(
      !/narrow|candidate space|focused evidence/i.test(g.text),
      `${id}: no narrowing wording`
    );
  }
});

test("S3: wrong_intent=0 on labeled negatives (lookup/enumeration/statistics classification)", () => {
  const expectations = {
    fp1: "lookup",
    fp2: "lookup",
    fp3: "lookup",
    sn1: "lookup",
    sn2: "enumeration",
    sn3: "statistics",
    "en-enum-all-callers": "enumeration",
    "en-enum-all-usages": "enumeration",
    "en-stat-per-module": "statistics",
    "en-lookup-definition": "lookup",
  };
  for (const { id, prompt } of NEGATIVE_CORPUS) {
    if (!(id in expectations)) continue;
    const g = buildSearchGuidance({ prompt });
    assert.equal(g.intent, expectations[id], `${id}: intent classification unchanged`);
  }
});

test("Line-5 positive zone additions: symbol disambiguation (FILTER) and dependency entry emit", () => {
  const cases = [
    // ⑤ 同名 symbol 消歧（FILTER）
    {
      intent: "filter",
      prompt:
        "search_lab/g4 contains four similar symbols: reserveInventory, reserveStock, holdStock, lockStock. Determine which one is ACTUALLY imported and called by order.js. Distinguish the real symbol from the unused lookalikes. Do not modify any file.",
    },
    // ⑥ 依赖入口定位（DISCOVERY）
    {
      intent: "discovery",
      prompt:
        "分析这个仓库的请求校验依赖入口：校验逻辑由哪些模块提供、插件如何把校验能力注入实例。梳理依赖关系与主要入口。不要修改代码。",
    },
    // ④ wrapper → real implementation（DISCOVERY）
    {
      intent: "discovery",
      prompt:
        "分析这个仓库中兼容层 wrapper 与真实实现的关系：哪些 wrapper 只是转发，真正实现由什么机制驱动。梳理关键调用链。不要修改代码。",
    },
  ];
  for (const c of cases) {
    const g = buildSearchGuidance({ prompt: c.prompt });
    assert.equal(g.suppressed, false, `${c.prompt.slice(0, 30)}...: line-5 positive zone must emit`);
    assert.equal(g.intent, c.intent, `${c.prompt.slice(0, 30)}...: intent`);
  }
});

test("determinism: same prompt -> byte-identical guidance across invocations", () => {
  const { prompt } = POSITIVE_CORPUS[0];
  const a = buildSearchGuidance({ prompt });
  const b = buildSearchGuidance({ prompt });
  assert.equal(a.text, b.text);
  assert.deepEqual(a.symbols, b.symbols);
  assert.deepEqual(a.scopes, b.scopes);
});
