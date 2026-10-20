"use strict";

// Unit regression for V1-D2 W1 carrier-envelope aware extraction.
// Prereg: evidence/V1/V1-D2-WIRING-EXPOSURE-PLAN-V1.md (frozen).
// Run: node --test deploy/hooks/post_tool/test_build_structured_carrier.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractStructured, extractStructuredFromCarrier } = require("./test_build_structured.js");

function frames(file, n, fromLine = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`    at fn${i} (${file}:${fromLine + i}:${i + 1})`);
  return out;
}

// large failing-test output with repeated structures (P1/P3/P4 shapes)
function bigFailingBody() {
  const lines = ["npm test", "test/tap runner v1.0 with detailed per-case diagnostics enabled for this run"];
  lines.push(...frames("lib/reply.js", 24, 10));
  for (let k = 1; k <= 6; k++) {
    lines.push(`not ok ${k} - case ${k} fails on the cached response streaming branch`);
    lines.push("    AssertionError: expected header to equal cached value but got undefined instead");
    lines.push(...frames("lib/reply.js", 6, 40));
    lines.push(`    at runTest (test/reply-code.test.js:${100 + k}:3)`);
  }
  lines.push("1..6");
  return lines.join("\n");
}

function wrapCarrier(stdoutBody, opts = {}) {
  const stderrBody = opts.stderrBody || "";
  return [
    `[TASCO_FAILURE_CARRIER] carrier_version=1 transport=shell`,
    `original_command=${opts.command || "npm test"}`,
    `original_exit_code=${opts.exitCode != null ? opts.exitCode : 1}`,
    `failure_kind=${opts.failureKind || "test_failure"}`,
    `truncated=false`,
    `[TASCO_FAILURE_CARRIER_STDOUT]`,
    stdoutBody,
    `[TASCO_FAILURE_CARRIER_STDERR]`,
    stderrBody,
    `[TASCO_FAILURE_CARRIER_END]`,
  ].join("\n");
}

test("carrier: eligible fold preserves every envelope line verbatim", () => {
  const body = bigFailingBody();
  const report = wrapCarrier(body);
  const r = extractStructuredFromCarrier(report, "npm test");
  assert.equal(r.eligible, true, "reason=" + r.reason);
  assert.equal(r.wiring_path, "carrier_diagnostic");
  const kept = new Set(r.structuredText.split(/\r?\n/));
  for (const line of report.split(/\r?\n/)) {
    if (line.includes("[TASCO_FAILURE_CARRIER") || line.startsWith("original_command=") || line.startsWith("original_exit_code=") || line.startsWith("failure_kind=") || line.startsWith("truncated=")) {
      assert.ok(kept.has(line), "envelope line lost: " + line);
    }
  }
  assert.equal(r.stats.bodies_folded.includes("stdout"), true);
  assert.ok(r.stats.saving > 0);
});

test("carrier: retention contract holds (not ok lines survive)", () => {
  const r = extractStructuredFromCarrier(wrapCarrier(bigFailingBody()), "npm test");
  assert.equal(r.eligible, true);
  assert.equal(r.retentionCheck.pass, true);
  assert.equal(r.retentionCheck.envelope_preserved, true);
  for (let k = 1; k <= 6; k++) {
    assert.ok(r.structuredText.includes(`not ok ${k} - case ${k} fails`), "not ok " + k + " lost");
  }
});

test("carrier: malformed envelope (missing END) -> fail-open native", () => {
  const body = bigFailingBody();
  const report = wrapCarrier(body).replace(/\n\[TASCO_FAILURE_CARRIER_END\]$/, "");
  const r = extractStructuredFromCarrier(report, "npm test");
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "carrier_malformed");
  assert.equal(r.structuredText, report, "raw report must continue unchanged");
});

test("carrier: invalid version -> fail-open native", () => {
  const report = wrapCarrier(bigFailingBody()).replace("carrier_version=1", "carrier_version=9");
  const r = extractStructuredFromCarrier(report, "npm test");
  assert.equal(r.eligible, false);
  assert.equal(r.carrier.valid, false);
  assert.equal(r.structuredText, report);
});

test("carrier: body without repeat structure -> not eligible, raw continues", () => {
  const lines = ["npm test"];
  for (let i = 0; i < 120; i++) lines.push("unique diagnostic line number " + i + " with distinct content " + (i * 7) + " no repeats here");
  const report = wrapCarrier(lines.join("\n"));
  const r = extractStructuredFromCarrier(report, "npm test");
  assert.equal(r.eligible, false);
  assert.ok(r.reason === "no_repeat_structure" || r.reason === "saving_below_threshold", "reason=" + r.reason);
  assert.equal(r.structuredText, report);
});

test("carrier: small body below MIN_BYTES -> not eligible", () => {
  const report = wrapCarrier("not ok 1 - tiny\n");
  const r = extractStructuredFromCarrier(report, "npm test");
  assert.equal(r.eligible, false);
  assert.ok(["below_min_bytes", "no_repeat_structure", "saving_below_threshold"].includes(r.reason), "reason=" + r.reason);
});

test("carrier: stderr-body patterns fold while stdout preserved untouched", () => {
  // report must clear the frozen MIN_BYTES floor at the report level (~2.3KB)
  const lintBody = ["eslint results", ...Array.from({ length: 40 }, (_, i) => `  ${10 + i}:1  error  'no-unused-vars' is not allowed here #${i}`)].join("\n");
  const plainStdout = "plain stdout line A\nplain stdout line B";
  const report = wrapCarrier(plainStdout, { stderrBody: lintBody });
  const r = extractStructuredFromCarrier(report, "npm run lint");
  assert.equal(r.eligible, true, "reason=" + r.reason);
  assert.ok(r.structuredText.includes("plain stdout line A"), "stdout must be untouched");
  assert.ok(r.structuredText.includes("plain stdout line B"));
  assert.ok(r.stats.bodies_folded.includes("stderr"));
});

test("carrier: envelope original_command drives the test/build gate", () => {
  const report = wrapCarrier(bigFailingBody(), { command: "npm run test:ci" });
  const r = extractStructuredFromCarrier(report, "");
  assert.equal(r.eligible, true, "reason=" + r.reason + " (gate must pass via envelope command)");
});

test("plain path regression: extractStructured unchanged on non-carrier text", () => {
  const r = extractStructured(bigFailingBody(), "npm test");
  assert.equal(r.eligible, true);
  assert.ok(r.stats.saving > 0);
  assert.equal(r.retentionCheck.pass, true);
  assert.equal(r.wiring_path, undefined, "plain path must not claim carrier wiring");
});

test("carrier: morphology families aggregated across bodies", () => {
  const stdoutBody = bigFailingBody();
  const stderrBody = ["eslint stderr", ...Array.from({ length: 8 }, (_, i) => `  ${20 + i}:3  error  'no-unused-vars' triggered again here #${i}`)].join("\n");
  const r = extractStructuredFromCarrier(wrapCarrier(stdoutBody, { stderrBody }), "npm test");
  assert.equal(r.eligible, true);
  assert.ok(r.morphology.length >= 2, "morphology=" + JSON.stringify(r.morphology));
  assert.ok(r.families.length >= 2);
});
