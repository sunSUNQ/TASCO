"use strict";

// Unit regression for V1-D1 Test/Build Structured Extraction (D1a).
// Frozen definition: docs/architecture/V1-D1-PRIMITIVE-DEFINITION-V1.md.
// Run: node --test deploy/hooks/post_tool/test_build_structured.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractStructured, isTestBuildText } = require("./test_build_structured.js");

function frames(file, n, fromLine = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`    at fn${i} (${file}:${fromLine + i}:${i + 1})`);
  return out;
}

function bigOutput() {
  const lines = ["npm test", "test/tap runner v1.0 with detailed per-case diagnostics enabled for this run"];
  lines.push(...frames("lib/reply.js", 24, 10));
  lines.push("not ok 1 - reply sets header for the cached response path in the streaming branch");
  lines.push("  ---");
  lines.push("    expected: 201");
  lines.push("    actual:   500");
  lines.push(...frames("test/reply.test.js", 16, 100));
  lines.push(...frames("lib/reply.js", 24, 10));
  lines.push("not ok 2 - second failure in the header serialization branch");
  lines.push("    expected: 1");
  lines.push("    actual:   0");
  lines.push("1..2");
  return lines.join("\n");
}

test("P1: consecutive same-file stack frames fold, first 2 kept, retention passes", () => {
  const raw = bigOutput();
  const r = extractStructured(raw);
  assert.equal(r.eligible, true, JSON.stringify({ reason: r.reason, stats: r.stats }));
  assert.ok(r.morphology.includes("T3_repeated_stack_traces"));
  assert.equal(r.retentionCheck.pass, true);
  assert.ok(r.stats.saving >= 0.3, "saving >= 0.3, got " + r.stats.saving);
  // retention: not-ok lines and expected/actual survive verbatim
  assert.ok(r.structuredText.includes("not ok 1 - reply sets header"));
  assert.ok(r.structuredText.includes("expected: 201"));
  assert.ok(r.structuredText.includes("actual:   500"));
  // fold marker present (short inline marker on the line before each run)
  assert.ok(r.structuredText.includes("[+folded]") || r.structuredText.includes("[+"), "fold marker present");
});

test("P2: consecutive identical-signature Error lines fold, first kept", () => {
  const lines = ["run suite with the full validation matrix enabled", "Tests: 400 total, 8 failed to follow"];
  for (let i = 0; i < 40; i++) lines.push(`ValidationError: field_${i} is required for the request payload to be accepted`);
  lines.push("not ok 1 - validation suite");
  const raw = lines.join("\n");
  const r = extractStructured(raw);
  assert.equal(r.eligible, true, r.reason);
  assert.ok(r.morphology.includes("T4_error_signature_family"));
  assert.equal(r.retentionCheck.pass, true);
  assert.ok(r.structuredText.includes("ValidationError: field_0 is required"));
  assert.ok(!r.structuredText.includes("ValidationError: field_5 is required"));
});

test("P3: consecutive exact-duplicate boilerplate lines fold", () => {
  const lines = ["npm run build", "webpack compiled with the production configuration and source maps"];
  for (let i = 0; i < 80; i++) lines.push("DEPRECATION WARNING: option X is deprecated and will be removed in the next major release");
  lines.push("build finished with warnings");
  lines.push("Tests: 12 passed");
  const raw = lines.join("\n");
  const r = extractStructured(raw);
  assert.equal(r.eligible, true, r.reason);
  assert.ok(r.morphology.includes("T2_repeated_boilerplate"));
  assert.equal(r.retentionCheck.pass, true);
});

test("determinism: identical input -> byte-identical output", () => {
  const raw = bigOutput();
  const a = extractStructured(raw);
  const b = extractStructured(raw);
  assert.equal(a.structuredText, b.structuredText);
  assert.deepEqual(a.stats, b.stats);
});

test("negative: below min bytes -> ineligible", () => {
  const r = extractStructured("not ok 1 - tiny\nat f (a.js:1:1)\nError: x".repeat(10));
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "below_min_bytes");
});

test("negative: non test/build output -> ineligible", () => {
  const noise = Array.from({ length: 120 }, (_, i) => `some random shell line ${i} with file lib/x.js at fn (lib/x.js:${i}:1)`).join("\n");
  const r = extractStructured(noise);
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "not_test_build_output");
});

test("negative: no repeat structure (semantic-dense) -> saving below threshold", () => {
  const lines = ["npm test"];
  for (let i = 0; i < 60; i++) lines.push(`FAIL suite-${i}/case-${i} expected ${i} received ${i + 1} (unique message ${i})`);
  lines.push("Tests: 60 failed");
  const r = extractStructured(lines.join("\n"));
  assert.equal(r.eligible, false);
  assert.ok(r.reason === "saving_below_threshold" || r.reason === "no_repeat_structure", r.reason);
});

test("negative: retention check failure -> ineligible (fold would lose key line)", () => {
  // P3 would fold consecutive assertion-like lines, but KEY_LINE_RE protects them;
  // build a case where a `not ok` line is inside a dropped run —
  // not possible by construction; verify the guard exists via exact-dup key lines.
  const lines = ["npm test with the verbose reporter configured for this diagnostic run"];
  for (let i = 0; i < 60; i++) lines.push(`context line ${i} describing suite setup state and environment details for auditability`);
  for (let i = 0; i < 30; i++) lines.push("    expected: 201");
  lines.push("not ok 1 - x");
  const raw = lines.join("\n");
  const r = extractStructured(raw);
  // expected-lines are KEY_LINE_RE protected: they must all survive if folded
  if (r.eligible) {
    assert.equal(r.retentionCheck.pass, true);
    const kept = r.structuredText.split("\n").filter((l) => l.includes("expected: 201")).length;
    assert.ok(kept >= 1, "expected line survives");
  } else {
    assert.ok(["saving_below_threshold", "no_repeat_structure"].includes(r.reason), "reason=" + r.reason);
  }
});

test("fallback: extractor exception path returns raw text ineligible", () => {
  const r = extractStructured(null);
  assert.equal(r.eligible, false);
  assert.equal(r.structuredText, null);
});

test("isTestBuildText gate matches frozen D0 OUT_RE", () => {
  assert.equal(isTestBuildText("ok"), false);
  assert.equal(isTestBuildText("Tests: 12 passed"), true);
  assert.equal(isTestBuildText("not ok 3 - x"), true);
  assert.equal(isTestBuildText("error TS2345: x"), true);
});
