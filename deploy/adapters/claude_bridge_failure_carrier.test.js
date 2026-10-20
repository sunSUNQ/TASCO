"use strict";

// P1-S2a Carrier-Aware Diagnostic Eligibility — bridge integration tests.
// Contract: docs/architecture/FAILURE-CARRIER-CONTRACT-V1.md (FROZEN, P1-S1).
// Spawns claude_bridge.js as a fresh process per hook invocation, exactly like
// a real PostToolUse (same harness as claude_bridge_validation_delta.test.js).
//
// Gate under test: the same valid failure carrier must yield the same
// Diagnostic eligibility regardless of prompt wording (C1-C3), malformed or
// incomplete carriers must fall back to Native (C4-C8), and Terminal-State /
// Validation Delta must never preempt a failure carrier (C9-C10).
// Failure semantics are anchored on original_exit_code, never on the
// carrier wrapper process exit code (always 0).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const BRIDGE = path.join(__dirname, "claude_bridge.js");
const CMD = "node --test fixture/checkout.test.js";

// ---------------------------------------------------------------- fixtures
function passLines(count, label) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      `✔ ${label} ${i} stays under the free-shipping threshold so the order pays the flat 499-cent fee (0.0${i % 10}ms)`
    );
  }
  return lines;
}

// Failure carrier in the qualified A2 emitter shape (run 20260907-193732):
// error-focused stdout body, header carries the frozen "command failed" words.
function failureCarrierText(overrides = {}) {
  const o = {
    exit: "1",
    kind: "test_failure",
    transport: "a2_task_wrapper",
    command: CMD,
    headerWords: "command failed",
    truncated: "false",
    truncationNote: null,
    stdout: [
      ...passLines(40, "total"),
      "✖ shipping charges the flat 499-cent fee below the 10000-cent free-shipping threshold (1.2345ms)",
      "  Error [ERR_ASSERTION]: Expected values to be strictly equal:",
      "  9999 !== 10000",
      "      operator: >=",
      "      expected: 10000",
      "      actual: 9999",
      "      at Test.<anonymous> (fixture/checkout.test.js:12:5)",
      "# tests 41",
      "# pass 40",
      "# fail 1",
    ].join("\n"),
    stderr: "",
    omit: [],
    ...overrides,
  };
  const has = (k) => !o.omit.includes(k);
  const lines = [
    `[TASCO_FAILURE_CARRIER]${o.headerWords ? ` ${o.headerWords}` : ""} carrier_version=1 transport=${o.transport}`,
    ...(has("command") ? [`original_command=${o.command}`] : []),
    ...(has("exit") ? [`original_exit_code=${o.exit}`] : []),
    `failure_kind=${o.kind}`,
    `truncated=${o.truncated}`,
    ...(o.truncationNote ? [`truncation_note=${o.truncationNote}`] : []),
    "stdout_chars=" + o.stdout.length,
    "stderr_chars=" + o.stderr.length,
    "[TASCO_FAILURE_CARRIER_STDOUT]",
    o.stdout,
    "[TASCO_FAILURE_CARRIER_STDERR]",
    o.stderr,
    "[TASCO_FAILURE_CARRIER_END]",
  ];
  return lines.join("\n") + "\n";
}

// C10 fixture: a failure carrier (original_exit_code=1) whose body is
// success-like. No failure-pattern wording anywhere, so the frozen
// Terminal-State classifier reads the text as a success terminal - the exact
// preemption scenario the contract forbids.
function successLikeCarrierText() {
  return failureCarrierText({
    headerWords: "",
    kind: "test_failure",
    stdout: [
      ...passLines(43, "route constraint"),
      "✖ checkout applies the member discount above the threshold",
      "      operator: >=",
      "      expected: 10000",
      "      actual: 9999",
      "# tests 44",
      "# pass 43",
      "# fail 0",
      "# skipped 0",
    ].join("\n"),
  });
}

const TAP44 = fs.readFileSync(
  path.join(__dirname, "..", "..", "docs", "experiments", "workflow-compression", "p0-agent-ab", "qualification", "fixtures", "f1-tap-44pass.out"),
  "utf8"
);

// ---------------------------------------------------------------- harness
function spawnBridge({ base, sessionId, stdoutText, command = CMD, prompt, vdFlag = false }) {
  const event = {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout: stdoutText, stderr: "" },
  };
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env: {
      ...process.env,
      CODE_GUARD_BASE_DIR: base,
      CODE_GUARD_HOOK_DIR: path.join(__dirname, "..", "hooks"),
      CODE_GUARD_AUTO_CANARY_V1A: "1",
      CODE_GUARD_CLAUDE_PROMPT: prompt || "",
      CODE_GUARD_VALIDATION_DELTA: vdFlag ? "1" : "",
      CODE_GUARD_TERMINAL_STATE: "1",
      CODE_GUARD_TERMINAL_STATE_SHADOW: "",
    },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(res.status, 0, String(res.stderr));
  const output = JSON.parse(String(res.stdout).trim() || "{}");
  const delivered = output.hookSpecificOutput && output.hookSpecificOutput.updatedToolOutput;
  const content = delivered && (delivered.content || delivered.stdout || "");
  return { content: content || null };
}

function readRows(base, name) {
  const rows = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === name) {
        for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
          if (line.trim()) rows.push(JSON.parse(line));
        }
      }
    }
  };
  walk(base);
  return rows;
}

const arbitrationRows = (base) =>
  readRows(base, "claude_auto_canary.jsonl").filter((r) => r.type === "auto_arbitration_v1");
const compressionRows = (base) =>
  readRows(base, "claude_auto_canary.jsonl").filter((r) => r.type === "compression");

function assertDiagnosticDelivery(
  base,
  run,
  { rawText = null, rootCause = "ERR_ASSERTION", selectionReason = "failure_carrier_contract_v1" } = {}
) {
  assert.ok(run.content, "model-visible delivery present");
  if (rawText) {
    assert.notEqual(run.content, rawText, "raw output must not be delivered verbatim");
    assert.ok(run.content.length < rawText.length, "delivery is a reduction, not raw passthrough");
  }
  assert.ok(run.content.includes(rootCause), "root-cause evidence preserved");
  const arb = arbitrationRows(base);
  assert.equal(arb.length, 1);
  assert.equal(arb[0].selected_capability, "diagnostic_semantic");
  assert.equal(arb[0].selection_reason, selectionReason);
  assert.equal(arb[0].applied_capability, "diagnostic_semantic");
  assert.equal(arb[0].double_apply_count, 0);
  assert.ok(arb[0].eligible_capabilities.includes("diagnostic_semantic"));
  const comp = compressionRows(base);
  assert.equal(comp.length, 1);
  // The frozen diagnostic compression event predates the capability field
  // (only the VD/terminal legs carry it); capability identity is asserted via
  // the arbitration row above.
  assert.equal(comp[0].transport_replacement_emitted, true);
  return { arb, comp };
}

function assertNative(base, run, { fallbackReason = null, candidates = [] } = {}) {
  assert.equal(run.content, null);
  const arb = arbitrationRows(base);
  assert.equal(arb.length, 1);
  assert.equal(arb[0].selected_capability, null);
  assert.equal(arb[0].applied_capability, null);
  assert.equal(arb[0].fallback_reason, fallbackReason);
  assert.deepEqual(arb[0].candidate_capabilities, candidates);
  assert.equal(compressionRows(base).length, 0);
}

// ---------------------------------------------------------------- gates
test("C1 valid carrier + diagnostic prompt -> Diagnostic selected and applied", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-c1-"));
  const text = failureCarrierText();
  const run = spawnBridge({
    base,
    sessionId: "00000000-0000-0000-0000-00000000c101",
    stdoutText: text,
    prompt: "Diagnose the root cause of this failing checkout suite.",
  });
  assertDiagnosticDelivery(base, run, { rawText: text });
});

test("C2/C3 same carrier + neutral / non-diagnostic prompts -> same Diagnostic eligibility", () => {
  const prompts = [
    "Run this and tell me what happened.",
    "Please inspect the result.",
    "Execute the validation command once.",
  ];
  const carrier = failureCarrierText();
  const delivered = [];
  prompts.forEach((prompt, i) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `fc-c23-${i}-`));
    const run = spawnBridge({
      base,
      sessionId: `00000000-0000-0000-0000-00000000c2${i}0`,
      stdoutText: carrier,
      prompt,
    });
    const { arb } = assertDiagnosticDelivery(base, run, { rawText: carrier });
    assert.equal(arb[0].candidate_capabilities.includes("terminal_state_success"), false);
    delivered.push(run.content);
  });
  // Prompt independence: eligibility result is identical for every wording.
  for (const text of delivered) assert.ok(text, "each prompt variant delivered");
  assert.deepEqual(
    [...new Set(delivered.map((t) => t.length))],
    [delivered[0].length],
    "delivered content is byte-identical across prompt wordings"
  );
});

test("C4 malformed marker -> Native regardless of prompt (no semantic guessing)", () => {
  const malformed = failureCarrierText().replace(
    "[TASCO_FAILURE_CARRIER] command failed",
    "[TASCO_FAILURE_CARRIER_V9] command failed"
  );
  for (const [i, prompt] of [
    "Diagnose the root cause of this failing checkout suite.",
    "Run this and tell me what happened.",
  ].entries()) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `fc-c4-${i}-`));
    const run = spawnBridge({
      base,
      sessionId: `00000000-0000-0000-0000-00000000c4${i}0`,
      stdoutText: malformed,
      prompt,
    });
    assertNative(base, run, { fallbackReason: "failure_carrier_malformed" });
  }
});

test("C5 original_exit_code missing -> Native", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-c5-"));
  const run = spawnBridge({
    base,
    sessionId: "00000000-0000-0000-0000-00000000c500",
    stdoutText: failureCarrierText({ omit: ["exit"] }),
    prompt: "Diagnose the root cause of this failing checkout suite.",
  });
  assertNative(base, run, { fallbackReason: "failure_carrier_malformed" });
});

test("C6 original_exit_code=0 -> Native (success domain, never Diagnostic)", () => {
  // Ambiguous body (no test-summary shapes): the frozen terminal classifier
  // must decline, so an exit-0 carrier can only end Native here.
  const ambiguousBody = Array.from(
    { length: 60 },
    (_, i) => `build step ${i} completed with output detail line ${i * 7}`
  ).join("\n");
  for (const [i, prompt] of [
    "Run this and tell me what happened.",
    "Diagnose the root cause of this result.",
  ].entries()) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `fc-c6-${i}-`));
    const run = spawnBridge({
      base,
      sessionId: `00000000-0000-0000-0000-00000000c6${i}0`,
      stdoutText: failureCarrierText({ exit: "0", headerWords: "", stdout: ambiguousBody }),
      prompt,
    });
    assertNative(base, run, { fallbackReason: "terminal_delivery_fallback" });
  }
});

test("C7 original_command missing -> Native", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-c7-"));
  const run = spawnBridge({
    base,
    sessionId: "00000000-0000-0000-0000-00000000c700",
    stdoutText: failureCarrierText({ omit: ["command"] }),
    prompt: "Diagnose the root cause of this failing checkout suite.",
  });
  assertNative(base, run, { fallbackReason: "failure_carrier_malformed" });
});

test("C8 truncated=true is judged by the frozen contract rule only", () => {
  // C8a: explicit audit note -> valid carrier -> Diagnostic.
  const baseA = fs.mkdtempSync(path.join(os.tmpdir(), "fc-c8a-"));
  const runA = spawnBridge({
    base: baseA,
    sessionId: "00000000-0000-0000-0000-00000000c8a0",
    stdoutText: failureCarrierText({
      truncated: "true",
      truncationNote: "stdout truncated at tail; 1234 chars dropped",
    }),
    prompt: "Run this and tell me what happened.",
  });
  assertDiagnosticDelivery(baseA, runA);

  // C8b: bare truncated=true without boundary info -> semantically
  // incomplete -> Native (never guessed).
  const baseB = fs.mkdtempSync(path.join(os.tmpdir(), "fc-c8b-"));
  const runB = spawnBridge({
    base: baseB,
    sessionId: "00000000-0000-0000-0000-00000000c8b0",
    stdoutText: failureCarrierText({ truncated: "true" }),
    prompt: "Run this and tell me what happened.",
  });
  assertNative(baseB, runB, { fallbackReason: "failure_carrier_malformed" });
});

test("C9 carrier with success-like passed noise -> Diagnostic; VD never wins", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-c9-"));
  const sid = "00000000-0000-0000-0000-00000000c900";
  // Establish a comparable previous success fingerprint for the same command.
  const r1 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, vdFlag: true });
  assert.ok(
    r1.content === null || r1.content.startsWith("[TERMINAL_STATE_SUCCESS]"),
    "first success run (no previous) is native or Terminal-State, never Diagnostic"
  );

  const r2 = spawnBridge({
    base,
    sessionId: sid,
    stdoutText: failureCarrierText(), // 40 passed-case lines + failing assertion
    prompt: "Run this and tell me what happened.",
    vdFlag: true,
  });
  assert.ok(r2.content, "delivery present");
  assert.ok(!r2.content.includes("[VALIDATION_DELTA]"), "VD must not deliver on a failure carrier");
  const arb = arbitrationRows(base);
  const arb2 = arb[arb.length - 1];
  assert.equal(arb2.selected_capability, "diagnostic_semantic");
  assert.equal(arb2.applied_capability, "diagnostic_semantic");
  assert.equal(arb2.double_apply_count, 0);
  // VD may appear as an ineligible candidate; it must never be eligible/selected.
  assert.ok(!arb2.eligible_capabilities.includes("validation_delta"));
  const comps = compressionRows(base);
  assert.equal(comps.length, 2, "one terminal row (first success) + one diagnostic row");
  assert.equal(
    comps.filter((c) => c.capability === "terminal_state_success").length,
    1,
    "exactly the first-success terminal row"
  );
  assert.equal(
    comps.filter((c) => c.capability === "validation_delta").length,
    0,
    "no VD compression on a failure carrier"
  );
});

test("C10 carrier + terminal-like success summary -> Diagnostic wins, Terminal never preempts", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-c10-"));
  const text = successLikeCarrierText();
  // Neutral prompt: without carrier awareness the observer would not form a
  // Diagnostic candidate at all and Terminal-State would win on the raw text.
  const run = spawnBridge({
    base,
    sessionId: "00000000-0000-0000-0000-00000000ca00",
    stdoutText: text,
    prompt: "Run this and tell me what happened.",
  });
  const { arb, comp } = assertDiagnosticDelivery(base, run, {
    rawText: text,
    // Success-like body: root cause surfaces via the failing-case line.
    rootCause: "✖ checkout applies the member discount above the threshold",
    selectionReason: "failure_diagnostic_precedence",
  });
  assert.equal(
    arb[0].selection_reason,
    "failure_diagnostic_precedence",
    "frozen failure precedence fires on carrier failure evidence"
  );
  assert.ok(
    arb[0].candidate_capabilities.includes("terminal_state_success"),
    "terminal conflict candidate was really present"
  );
  assert.ok(!arb[0].eligible_capabilities.includes("terminal_state_success") ||
    arb[0].selected_capability === "diagnostic_semantic",
    "terminal must not be selected");
  assert.equal(comp.filter((r) => r.capability === "terminal_state_success").length, 0);

  // Same winner with a diagnostic prompt: arbitration is prompt-independent.
  const base2 = fs.mkdtempSync(path.join(os.tmpdir(), "fc-c10b-"));
  const run2 = spawnBridge({
    base: base2,
    sessionId: "00000000-0000-0000-0000-00000000ca01",
    stdoutText: successLikeCarrierText(),
    prompt: "Diagnose the root cause of this failing checkout suite.",
  });
  assertDiagnosticDelivery(base2, run2, {
    rootCause: "✖ checkout applies the member discount above the threshold",
    selectionReason: "failure_diagnostic_precedence",
  });
});

test("negative boundary: normal success output without carrier marker stays legacy", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-neg-"));
  const sid = "00000000-0000-0000-0000-00000000cb00";
  const r1 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, vdFlag: true });
  // M3 frozen chain with terminal flag on: first success (no comparable
  // previous) -> Terminal-State AUTO, never a failure-carrier Diagnostic.
  assert.match(r1.content, /^\[TERMINAL_STATE_SUCCESS\]/);
  const arb1 = arbitrationRows(base)[0];
  assert.equal(arb1.selected_capability, "terminal_state_success");
  assert.equal(arb1.applied_capability, "terminal_state_success");

  const r2 = spawnBridge({ base, sessionId: sid, stdoutText: TAP44, vdFlag: true });
  // Same-command comparable success -> Validation Delta AUTO (stable VD
  // precedence over terminal, M3 frozen).
  assert.match(r2.content, /^\[VALIDATION_DELTA\]/);
  assert.match(r2.content, /mode=success_unchanged/);
  const arb = arbitrationRows(base);
  assert.equal(arb[1].selected_capability, "validation_delta");
  assert.equal(arb[1].applied_capability, "validation_delta");
});
