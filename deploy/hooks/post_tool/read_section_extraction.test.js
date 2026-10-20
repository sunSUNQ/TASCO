"use strict";

// Line-6 R5 Section Extraction primitive tests (deterministic, no I/O).
// Gates (task book §八): relevant section recall, irrelevant reduction,
// required constraint preserved verbatim, cross-section dependency preserved,
// no-hits -> null (Native), bounded delivery.
// 运行：node --test deploy/hooks/post_tool/read_section_extraction.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { extractRelevantSections } = require("./read_section_extraction.js");

// Synthetic multi-section doc: only Authentication and Rate limits matter for
// the test task; Setup/Changelog/License are irrelevant filler.
const DOC = [
  "# Service Manual",
  "",
  "## Setup",
  ...Array.from({ length: 20 }, (_, i) => `Setup step ${i}: install dependency ${i} and configure the runtime.`),
  "",
  "## Authentication",
  "All admin endpoints require the header `X-Admin-Token`.",
  "Tokens are scoped per environment and expire after 24 hours.",
  "See Rate limits for the per-token request budget.",
  "",
  "## Rate limits",
  "Admin tokens are limited to 100 requests per minute.",
  "Exceeding the budget returns HTTP 429 with a Retry-After header.",
  "",
  "## Changelog",
  ...Array.from({ length: 20 }, (_, i) => `- 1.${i}: internal refactor ${i}, no user-visible change.`),
  "",
  "## License",
  "Internal use only.",
].join("\n");

test("R5: relevant sections recalled with verbatim constraint lines", () => {
  const r = extractRelevantSections({ text: DOC, task_terms: ["X-Admin-Token", "requests per minute"] });
  assert.ok(r, "task-relevant extraction present");
  const titles = r.sections.map((s) => s.title);
  assert.ok(titles.includes("Authentication"), "Authentication section selected");
  assert.ok(titles.includes("Rate limits"), "Rate limits section selected (direct hit + cross-ref)");
  // required constraints preserved verbatim
  assert.match(r.text, /X-Admin-Token/);
  assert.match(r.text, /100 requests per minute/);
  assert.match(r.text, /Retry-After/);
});

test("R5: irrelevant sections reduced", () => {
  const r = extractRelevantSections({ text: DOC, task_terms: ["X-Admin-Token", "requests per minute"] });
  assert.ok(!r.text.includes("Setup step 0"), "Setup filler excluded");
  assert.ok(!r.text.includes("internal refactor 0"), "Changelog filler excluded");
  assert.ok(r.delivered_chars < r.raw_chars, `reduction: ${r.delivered_chars} < ${r.raw_chars}`);
});

test("R5: cross-section dependency not lost (See Rate limits pulls the section in)", () => {
  // Task term only hits Authentication; the "See Rate limits" reference must
  // still pull the Rate limits section in (one expansion round).
  const r = extractRelevantSections({ text: DOC, task_terms: ["X-Admin-Token"] });
  assert.ok(r);
  const titles = r.sections.map((s) => s.title);
  assert.ok(titles.includes("Authentication"));
  assert.ok(titles.includes("Rate limits"), "cross-referenced section included");
});

test("R5: no hits -> null (Native, no full-doc summary guessing)", () => {
  assert.equal(extractRelevantSections({ text: DOC, task_terms: ["kubernetes"] }), null);
  assert.equal(extractRelevantSections({ text: DOC, task_terms: [] }), null);
  assert.equal(extractRelevantSections({ text: "", task_terms: ["x"] }), null);
});

test("R5: bounded delivery and determinism", () => {
  const bigDoc = DOC + "\n" + Array.from({ length: 300 }, (_, i) => `filler ${i}`).join("\n");
  const r = extractRelevantSections({ text: bigDoc, task_terms: ["X-Admin-Token"], max_chars: 1200 });
  assert.ok(r);
  assert.ok(r.text.length <= 1400, `capped delivery: ${r.text.length}`);
  const a = extractRelevantSections({ text: DOC, task_terms: ["X-Admin-Token"] });
  const b = extractRelevantSections({ text: DOC, task_terms: ["X-Admin-Token"] });
  assert.equal(a.text, b.text);
});

test("R5 corpus recall: real committed docs answer their corpus questions", () => {
  const ROOT = path.resolve(__dirname, "..", "..", "..");
  // rt-r5-1: api_v2.md — required header + v1 removal
  const apiV2 = fs.readFileSync(path.join(ROOT, "hook_ab_test", "enterprise_test_repo", "docs", "api_v2.md"), "utf8");
  const r1 = extractRelevantSections({ text: apiV2, task_terms: ["idempotency-key", "v1"] });
  assert.ok(r1, "api_v2.md extraction present");
  assert.match(r1.text, /Idempotency-Key/);
  assert.match(r1.text, /removed next quarter/);
  // rt-r5-2: legacy-migration.md — replacement + real code call site
  const legacy = fs.readFileSync(path.join(ROOT, "hook_ab_test", "fixtures", "sg4_lookalike_repo", "docs", "legacy-migration.md"), "utf8");
  const r2 = extractRelevantSections({ text: legacy, task_terms: ["completepayment", "paymentservice.charge"] });
  assert.ok(r2, "legacy-migration extraction present");
  assert.match(r2.text, /completePayment/);
  assert.match(r2.text, /PaymentService\.charge/);
});
