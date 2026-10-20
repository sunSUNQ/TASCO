"use strict";

// P0-A2 负区 Layer-1 回归（2026-08-31 一次边界修正后）：
// ENUMERATION / STATISTICS / UNKNOWN / LOOKUP 必须 suppressed（不注入任何
// guidance）；DISCOVERY / FILTER 必须正常注入。LOOKUP 并入负区依据：
// Fastify pilot（FP1-3）显示对 lookup 任务注入通用 guidance 会把"少搜"
// 推成"多读"，跨任务经济性不稳定 → lookup_intent_default_native。
// 运行：node --test deploy/hooks/pre_tool/search_guidance.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSearchGuidance } = require("./search_guidance.js");

const NEGATIVE_CORPUS = [
  {
    label: "enum_all_call_sites_en",
    expect: "enumeration",
    prompt:
      "List all call sites of recordEvent in this project (file and line for each). Do not omit any; completeness is required.",
  },
  {
    label: "enum_all_implementations_zh",
    expect: "enumeration",
    prompt: "找出项目中全部实现，并列出所有调用位置，确保没有遗漏。",
  },
  {
    label: "enum_missing_references_zh",
    expect: "enumeration",
    prompt: "检查是否存在遗漏引用：列出所有引用 recordEvent 的文件。",
  },
  {
    label: "enum_every_occurrence_en",
    expect: "enumeration",
    prompt: "Show every occurrence of validateOrder across all files.",
  },
  {
    label: "enum_all_callers_en",
    expect: "enumeration",
    prompt: "List all callers of refreshToken in the codebase, including legacy modules.",
  },
  {
    label: "enum_list_all_zh_bare",
    expect: "enumeration",
    prompt: "列出所有调用位置。",
  },
  {
    label: "stats_per_module_usage_zh",
    expect: "statistics",
    prompt: "统计各模块中的使用次数：orders、payments、inventory、notifications 分别有多少处 audit 调用。",
  },
  {
    label: "stats_distribution_classification_zh",
    expect: "statistics",
    prompt: "比较各目录中的分布：给出所有匹配项的分类计数。",
  },
  {
    label: "stats_per_module_count_en",
    expect: "statistics",
    prompt: "Count how many times each module calls submitOrder and show the distribution per directory.",
  },
  {
    label: "stats_frequency_across_files_en",
    expect: "statistics",
    prompt: "How many audit calls exist per module? Report the frequency across files.",
  },
  {
    label: "stats_classification_count_en",
    expect: "statistics",
    prompt: "Give a classification count of all cache-related matches by category.",
  },
  {
    label: "stats_count_distribution_zh_bare",
    expect: "statistics",
    prompt: "统计数量与分布。",
  },
  {
    label: "lookup_definition_en",
    expect: "lookup",
    prompt: "Find the definition of fooBar and its declaration.",
  },
  {
    label: "lookup_symbol_location_zh",
    expect: "lookup",
    prompt: "找出 validateOrder 的定义位置与声明。",
  },
  {
    label: "lookup_where_is_zh",
    expect: "lookup",
    prompt: "定位 refreshToken 在哪里定义，返回符号所在文件。",
  },
];

const POSITIVE_CORPUS = [
  {
    label: "discovery_sg5",
    expect: "discovery",
    prompt:
      "Explore this project and find out under which conditions cache entries are evicted or expire, where the primary eviction implementation lives, and which code paths call it. Identify the most relevant implementation files and explain the key call relationships. Do not modify any code.",
  },
  {
    label: "discovery_auth",
    expect: "discovery",
    prompt: "Explore the project and find out where authentication is implemented.",
  },
  {
    label: "discovery_ts_incremental_zh",
    expect: "discovery",
    prompt:
      "分析 TypeScript 增量构建过程中，已有构建状态在什么情况下不能继续复用，需要重新处理相关文件。找到最相关的实现位置并说明主要判断流程。不修改代码。",
  },
  {
    label: "filter_sg4",
    expect: "filter",
    prompt:
      "search_lab/g4 contains four similar symbols: reserveInventory, reserveStock, holdStock, lockStock. Determine which one is ACTUALLY imported and called by search_lab/g4/order.js, and which files implement each symbol. Distinguish the real symbol from the unused lookalikes. Do not modify any file.",
  },
];

test("negative corpus: ENUMERATION/STATISTICS/UNKNOWN/LOOKUP must suppress guidance", () => {
  for (const c of NEGATIVE_CORPUS) {
    const r = buildSearchGuidance({ prompt: c.prompt });
    assert.equal(
      r.intent,
      c.expect,
      `${c.label}: intent should be ${c.expect}, got ${r.intent}`
    );
    assert.equal(
      r.suppressed,
      true,
      `${c.label}: must be suppressed (no narrowing guidance)`
    );
    assert.equal(
      r.text,
      "",
      `${c.label}: suppressed guidance must have empty text`
    );
    assert.ok(
      !/narrow|candidate space|focused evidence/i.test(r.text),
      `${c.label}: no narrowing wording allowed`
    );
  }
});

test("positive corpus: DISCOVERY/FILTER must emit guidance", () => {
  for (const c of POSITIVE_CORPUS) {
    const r = buildSearchGuidance({ prompt: c.prompt });
    assert.equal(
      r.intent,
      c.expect,
      `${c.label}: intent should be ${c.expect}, got ${r.intent}`
    );
    assert.equal(r.suppressed, false, `${c.label}: should not be suppressed`);
    assert.ok(r.text.length > 0, `${c.label}: guidance text must be non-empty`);
  }
});
