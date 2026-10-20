"use strict";

// Search Compression v1 — structured extractive grep summarizer 冻结回归
// （确定性、无模型）。契约：docs/experiments/search/SEARCH-COMPRESSION-V1.md
// 正区 = 筛选型 search（相似命中去重筛选，exact match 保留）；负区 = 分布/
// 全量统计型 search（压缩 omissions 会破坏计数 — 冻结边界，部署默认 off，
// env 逐 operator 启用）。
// 运行：node --test deploy/hooks/post_tool/search_compression.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSummaries } = require("./summaries.js");

process.env.CODE_GUARD_STRUCTURED_SEARCH = "1";
const { quickGrepSummary } = createSummaries({});

const RG_OUTPUT = [
  "lib/reply.js:120:  reply.send(payload)",
  "lib/reply.js:121:  return reply.send(payload)",
  "test/reply.test.js:14:  t.equal(reply.send.length, 1)",
  "test/reply.test.js:15:  reply.send(null)",
  "docs/guide.md:33:reply.send is the primary sender",
  "lib/hooks.js:88:    if (reply.send) reply.send(null)",
].join("\n");

test("structured schema: header, domain counts, production matches kept, omitted metadata", () => {
  const out = quickGrepSummary("grep_search", RG_OUTPUT);
  assert.match(out, /\[SEARCH STRUCTURED v1\]/);
  assert.match(out, /raw_chars=\d+/);
  assert.match(out, /unique_matches=6/);
  assert.match(out, /production=3 \| test=2 \| docs=1/);
  assert.match(out, /rule=cluster by file; keep exact match; dedupe; omit low-value hits/);
  assert.match(out, /lib\/reply\.js:L120 reply\.send\(payload\)/);
  assert.match(out, /lib\/hooks\.js:L88/);
  assert.match(out, /omitted: test=2 docs=1/);
  // test/docs exact lines are omitted from the body
  assert.ok(!out.includes("t.equal(reply.send.length"));
  assert.ok(!out.includes("docs/guide.md:L33"));
  // savings: delivered < raw for repetitive shapes
  assert.ok(out.length < RG_OUTPUT.length + 200, "summary should not balloon vs raw");
});

test("exact match fidelity: every production match line survives verbatim (file:line:content)", () => {
  const out = quickGrepSummary("grep_search", RG_OUTPUT);
  for (const line of [
    "lib/reply.js:120:  reply.send(payload)",
    "lib/reply.js:121:  return reply.send(payload)",
    "lib/hooks.js:88:    if (reply.send) reply.send(null)",
  ]) {
    const firstColon = line.indexOf(":");
    const secondColon = line.indexOf(":", firstColon + 1);
    const f = line.slice(0, firstColon);
    const l = line.slice(firstColon + 1, secondColon);
    const rest = line.slice(secondColon + 1).replace(/^\s+/, "");
    const expected = `- ${f}:L${l} ${rest}`;
    assert.ok(out.includes(expected), `missing exact match rendering: ${expected}`);
  }
});

test("dedupe: repeated identical hits collapse (unique_matches counts once)", () => {
  const dup = ["lib/a.js:1:foo()", "lib/a.js:1:foo()", "lib/b.js:2:bar()"].join("\n");
  const out = quickGrepSummary("grep_search", dup);
  assert.match(out, /unique_matches=2/);
  assert.match(out, /production=2 \| test=0 \| docs=0/);
});

test("no-hit fallback: unparseable input reports zero structured matches, no crash", () => {
  const out = quickGrepSummary("grep_search", "some free-form text\nwithout line structure\n");
  assert.match(out, /\[SEARCH STRUCTURED v1\]/);
  assert.match(out, /unique_matches=0/);
  assert.match(out, /production matches:\s*none/);
});

test("negative shape documentation: distribution-style output gets compressed with omissions", () => {
  // 分布型查询的输出交给 summarizer 会丢 test/docs 行 → 计数不可从压缩视图恢复。
  // 这是冻结负区的机制依据（S-G2/S-G3 LCR 1.29-2.62 先例）；部署默认 off。
  const distribution = [];
  for (let i = 1; i <= 40; i++) distribution.push(`test/case_${i}.js:${i}: usage_${i}()`);
  const out = quickGrepSummary("grep_search", distribution.join("\n"));
  assert.match(out, /test=40/);
  assert.ok(!out.includes("usage_40()"), "omitted line must not survive in delivery");
  assert.match(out, /re-grep only if a specific production match is missing/);
});

test("env off: without CODE_GUARD_STRUCTURED_SEARCH the legacy grep path is used (no structured header)", () => {
  delete process.env.CODE_GUARD_STRUCTURED_SEARCH;
  const fresh = createSummaries({});
  const out = fresh.quickGrepSummary("grep_search", RG_OUTPUT);
  assert.ok(!out.includes("[SEARCH STRUCTURED v1]"));
  assert.match(out, /\[grep_search summarized\]/);
  process.env.CODE_GUARD_STRUCTURED_SEARCH = "1";
});
