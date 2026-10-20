"use strict";

// Unit / component regression for the P1-S2a carrier parser
// (deploy/hooks/post_tool/failure_carrier.js).
// Contract source: docs/architecture/FAILURE-CARRIER-CONTRACT-V1.md (FROZEN).
// Every invalid reason maps 1:1 to a contract consumption rule; all cases are
// deterministic (no prompt, no model, no I/O).

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseFailureCarrier,
  isDiagnosticEligibleFailureCarrier,
} = require("./failure_carrier");

const STDOUT_BODY = [
  "not ok 1 - shipping charges the flat fee below the threshold",
  "  operator: >=",
  "  expected: 10000",
  "  actual: 9999",
  "# tests 2",
  "# pass 1",
  "# fail 1",
].join("\n");
const STDERR_BODY = "node:internal assert chunk";

function carrierText(overrides = {}) {
  const o = {
    version: "1",
    command: "node --test fixture/checkout.test.js",
    exit: "1",
    kind: "test_failure",
    truncated: "false",
    truncationNote: null,
    transport: "a2_task_wrapper",
    stdout: STDOUT_BODY,
    stderr: STDERR_BODY,
    header: "[TASCO_FAILURE_CARRIER]",
    headerExtra: "",
    omit: [],
    ...overrides,
  };
  const has = (k) => !o.omit.includes(k);
  const lines = [
    o.header +
      (o.headerExtra ? ` ${o.headerExtra}` : "") +
      (has("version") && o.headerExtra === "" ? ` carrier_version=${o.version}` : "") +
      (has("transport") && o.headerExtra === "" ? ` transport=${o.transport}` : ""),
  ];
  if (o.headerExtra && has("version")) lines.push(`carrier_version=${o.version}`);
  if (o.headerExtra && has("transport")) lines.push(`transport=${o.transport}`);
  if (has("command")) lines.push(`original_command=${o.command}`);
  if (has("exit")) lines.push(`original_exit_code=${o.exit}`);
  if (has("kind")) lines.push(`failure_kind=${o.kind}`);
  if (has("truncated")) lines.push(`truncated=${o.truncated}`);
  if (o.truncationNote) lines.push(`truncation_note=${o.truncationNote}`);
  lines.push("[TASCO_FAILURE_CARRIER_STDOUT]");
  lines.push(o.stdout);
  lines.push("[TASCO_FAILURE_CARRIER_STDERR]");
  lines.push(o.stderr);
  lines.push("[TASCO_FAILURE_CARRIER_END]");
  return lines.join("\n") + "\n";
}

test("valid carrier parses all contract fields and is a Diagnostic-eligible failure carrier", () => {
  const text = carrierText({ headerExtra: "command failed" });
  const parsed = parseFailureCarrier(text);
  assert.equal(parsed.present, true);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.reason, null);
  assert.equal(parsed.fields.carrier_version, "1");
  assert.equal(parsed.fields.original_command, "node --test fixture/checkout.test.js");
  assert.equal(parsed.original_exit_code, 1);
  assert.equal(parsed.fields.failure_kind, "test_failure");
  assert.equal(parsed.fields.truncated, "false");
  assert.equal(parsed.fields.transport, "a2_task_wrapper");
  assert.equal(parsed.stdout, STDOUT_BODY);
  assert.equal(parsed.stderr, STDERR_BODY);
  assert.equal(isDiagnosticEligibleFailureCarrier(parsed), true);
});

test("plain output without carrier namespace is not present (legacy path untouched)", () => {
  const parsed = parseFailureCarrier("npm test\n44 passing\nsome build log\n");
  assert.deepEqual(parsed, {
    present: false,
    valid: false,
    reason: null,
    fields: {},
    stdout: null,
    stderr: null,
  });
  assert.equal(isDiagnosticEligibleFailureCarrier(parsed), false);
});

test("C4 malformed marker line -> invalid (malformed_marker)", () => {
  // Header misspelled: no exact [TASCO_FAILURE_CARRIER] line.
  const parsed = parseFailureCarrier(carrierText({ header: "[TASCO_FAILURE_CARRIER_V2]" }));
  assert.equal(parsed.present, true);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "malformed_marker");
  assert.equal(isDiagnosticEligibleFailureCarrier(parsed), false);
});

test("unsupported carrier_version -> invalid (version_unsupported)", () => {
  const parsed = parseFailureCarrier(carrierText({ version: "2" }));
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "version_unsupported");
});

test("C5 original_exit_code missing -> invalid (exit_code_missing_or_unparseable)", () => {
  const parsed = parseFailureCarrier(carrierText({ omit: ["exit"] }));
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "exit_code_missing_or_unparseable");
});

test("non-numeric original_exit_code -> invalid", () => {
  const parsed = parseFailureCarrier(carrierText({ exit: "nonzero" }));
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "exit_code_missing_or_unparseable");
});

test("C6 original_exit_code=0 is a valid carrier but NOT a Diagnostic-eligible failure", () => {
  const parsed = parseFailureCarrier(carrierText({ exit: "0", kind: "command_failure" }));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.original_exit_code, 0);
  assert.equal(isDiagnosticEligibleFailureCarrier(parsed), false);
});

test("negative original_exit_code stays failure-eligible", () => {
  const parsed = parseFailureCarrier(carrierText({ exit: "-1", kind: "command_failure" }));
  assert.equal(parsed.valid, true);
  assert.equal(isDiagnosticEligibleFailureCarrier(parsed), true);
});

test("C7 original_command missing -> invalid (command_missing)", () => {
  const parsed = parseFailureCarrier(carrierText({ omit: ["command"] }));
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "command_missing");
});

test("empty original_command -> invalid (command_missing)", () => {
  const parsed = parseFailureCarrier(carrierText({ command: "" }));
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "command_missing");
});

test("C8a truncated=true with explicit audit note is valid and failure-eligible", () => {
  const parsed = parseFailureCarrier(
    carrierText({ truncated: "true", truncationNote: "stdout truncated at tail; 1234 chars dropped" })
  );
  assert.equal(parsed.valid, true);
  assert.equal(parsed.reason, null);
  assert.equal(isDiagnosticEligibleFailureCarrier(parsed), true);
});

test("C8b truncated=true without audit note -> invalid (truncation_not_auditable, no guessing)", () => {
  const parsed = parseFailureCarrier(carrierText({ truncated: "true" }));
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "truncation_not_auditable");
});

test("truncated state not explicit -> invalid (truncated_not_explicit)", () => {
  for (const bad of ["maybe", "", "TRUE"]) {
    const parsed = parseFailureCarrier(carrierText({ truncated: bad }));
    assert.equal(parsed.valid, false, `truncated=${JSON.stringify(bad)}`);
    assert.equal(parsed.reason, "truncated_not_explicit");
  }
  const missing = parseFailureCarrier(carrierText({ omit: ["truncated"] }));
  assert.equal(missing.valid, false);
  assert.equal(missing.reason, "truncated_not_explicit");
});

test("non-enum failure_kind -> invalid; explicit unknown is accepted", () => {
  const bad = parseFailureCarrier(carrierText({ kind: "catastrophic" }));
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, "failure_kind_invalid");
  const ok = parseFailureCarrier(carrierText({ kind: "unknown" }));
  assert.equal(ok.valid, true);
  assert.equal(isDiagnosticEligibleFailureCarrier(ok), true);
});

test("transport missing -> invalid (transport_missing)", () => {
  const parsed = parseFailureCarrier(carrierText({ omit: ["transport"] }));
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "transport_missing");
});

test("missing stdout/stderr/end blocks -> invalid (blocks_missing)", () => {
  const noStderr = carrierText({}).replace("[TASCO_FAILURE_CARRIER_STDERR]\n", "");
  const parsed = parseFailureCarrier(noStderr);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "blocks_missing");

  const noEnd = carrierText({}).replace("\n[TASCO_FAILURE_CARRIER_END]", "");
  const parsed2 = parseFailureCarrier(noEnd);
  assert.equal(parsed2.valid, false);
  assert.equal(parsed2.reason, "blocks_missing");
});

test("duplicated block marker -> invalid (blocks_duplicated)", () => {
  const text = carrierText({}).replace(
    "[TASCO_FAILURE_CARRIER_END]",
    "[TASCO_FAILURE_CARRIER_STDOUT]\n[TASCO_FAILURE_CARRIER_END]"
  );
  const parsed = parseFailureCarrier(text);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "blocks_duplicated");
});

test("original_command with spaces and '=' survives verbatim", () => {
  const cmd = "node --test --test-name-pattern='a=b' fixture/checkout.test.js";
  const parsed = parseFailureCarrier(carrierText({ command: cmd }));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.fields.original_command, cmd);
});

test("frozen A2 E2E emitter shape parses (qualified run 20260907-193732 form)", () => {
  const emitterReport = [
    "[TASCO_FAILURE_CARRIER] command failed carrier_version=1 transport=a2_task_wrapper",
    "original_command=node --test fixture/checkout.test.js",
    "original_exit_code=1",
    "failure_kind=test_failure",
    "truncated=false",
    "stdout_chars=7237",
    "stderr_chars=0",
    "[TASCO_FAILURE_CARRIER_STDOUT]",
    STDOUT_BODY,
    "[TASCO_FAILURE_CARRIER_STDERR]",
    "",
    "[TASCO_FAILURE_CARRIER_END]",
  ].join("\n");
  const parsed = parseFailureCarrier(emitterReport);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.original_exit_code, 1);
  assert.equal(parsed.fields.stdout_chars, "7237");
  assert.equal(parsed.fields.stderr_chars, "0");
  assert.equal(isDiagnosticEligibleFailureCarrier(parsed), true);
});
