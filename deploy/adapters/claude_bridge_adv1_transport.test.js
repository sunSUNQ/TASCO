"use strict";

// ============================================================================
// claude_bridge_adv1_transport.test.js — V1-D-ADV1 eligibility-prefiltered
// transport guard (prereg evidence/V1/V1-D-ADV1-STANDARD-RUNNER-ADOPTION-
// PREREG.md; implementation contract §1-§9).
//
// Frozen contract under test (v0.10 candidate-default wiring):
//   unset / "1"                     -> ON: exactly ONE new transport decision:
//     run_shell_command AND classifyCommand in {test,build,check} AND
//     chars >= 3000 AND NOT already routed (Zone A rule-6 / Zone B carrier
//     never reach the terminal leg) AND frozen extractStructured prefilter
//     eligible -> consult the EXISTING full policy path (frozen winner logic,
//     shared adoption gate) -> applied OR native.
//   "0" (kill-switch) / other legacy -> OFF: byte-identical v0.9 GA behavior,
//     zero ADV1 telemetry.
//   arbitration: one transform per result, applied = diagnostic_semantic
//     (existing winner, no fifth winner), double_apply_count = 0.
//
// Run: node --test deploy/adapters/claude_bridge_adv1_transport.test.js
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const BRIDGE = path.join(__dirname, "claude_bridge.js");
const HOOK_DIR = path.join(__dirname, "..", "hooks");

// ---------------------------------------------------------------- fixtures
// P5 lint-rule aggregation shape (frozen strong T6 family): >=5 violations per
// rule, >=3000 chars -> extractStructured eligible with saving >= 0.3.
function lintBody() {
  const rules = ["no-undef", "no-unused-vars", "no-redeclare", "eqeqeq"];
  const lines = ["> repo@lint .", "> eslint .", ""];
  let n = 0;
  for (let round = 0; round < 50; round++) {
    for (const rule of rules) {
      n++;
      lines.push(`  ${10 + n}:${1 + (n % 9)}  error  '${rule} violation instance ${n} in src/module${n % 7}.js'  ${rule}`);
    }
  }
  lines.push("");
  lines.push("\u2716 " + n + " problems (" + n + " errors, 0 warnings)");
  return lines.join("\n");
}

// Terminal-declined, non-test/build/check large output (command class gate).
function bigNonTestClassBody() {
  const lines = [];
  for (let i = 0; i < 90; i++) {
    lines.push("d rwxr-xr-x 1 owner group " + (1000 + i) + " Jan 0" + (1 + (i % 9)) + " 10:1" + (i % 10) + " item_" + i + "_distinct_name_" + (i * 13));
  }
  return lines.join("\n");
}

// Test-class output the terminal classifier declines and P1-P5 rejects
// (no repeat structure): unique lines, no "not ok"/summary/error markers.
function bigUniqueTestBody() {
  const lines = ["node --test run started with the verbose reporter enabled"];
  for (let i = 0; i < 80; i++) {
    lines.push("unique diagnostic line number " + i + " with distinct content " + (i * 7) + " no repeats here at all");
  }
  return lines.join("\n");
}

// Zone A (rule 6) prompt: diagnostic-dominant + analysis-only.
const DIAG_PROMPT =
  "Analyze the root cause of this failing lint suite. Do not modify files. Just diagnose.";

function lintEvent(sessionId, prompt) {
  return {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "npx eslint ." },
    tool_response: { stdout: lintBody(), stderr: "" },
    ...(prompt === undefined ? {} : {}),
  };
}

// ---------------------------------------------------------------- harness
function baseEnv(base, prompt, extra = {}) {
  return {
    ...process.env,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    CODE_GUARD_BASE_DIR: base,
    CODE_GUARD_HOOK_DIR: HOOK_DIR,
    CODE_GUARD_AUTO_CANARY_V1A: "1",
    CODE_GUARD_CLAUDE_PROMPT: prompt || "",
    CODE_GUARD_TERMINAL_STATE: "1",
    CODE_GUARD_TERMINAL_STATE_SHADOW: "",
    CODE_GUARD_VALIDATION_DELTA: "",
    CODE_GUARD_FAILURE_CARRIER_AUTO: "1",
    ...extra,
  };
}

function spawnBridge(event, env) {
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env,
    encoding: "utf8",
    timeout: 180000,
  });
  assert.equal(res.status, 0, String(res.stderr).slice(0, 400));
  return JSON.parse(String(res.stdout).trim() || "{}");
}

function deliveredText(out) {
  const u = out && out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput;
  if (!u) return null;
  if (typeof u.content === "string") return u.content;
  if (typeof u.stdout === "string") return u.stdout;
  return null;
}

function readNdjson(base, rel) {
  const p = path.join(base, rel);
  if (!fs.existsSync(p)) return null;
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const canaryRows = (base) => readNdjson(base, path.join("context_budget", "claude_auto_canary.jsonl")) || [];
const adv1Rows = (base) => readNdjson(base, path.join("context_budget", "adv1_transport_guard.ndjson"));
const compressionRows = (base) => canaryRows(base).filter((r) => r.type === "compression");
const arbRows = (base) => canaryRows(base).filter((r) => r.type === "auto_arbitration_v1");
const structuredRows = (base) => {
  const rows = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name === "test_build_structured.ndjson") {
        for (const line of fs.readFileSync(fp, "utf8").split(/\r?\n/)) {
          if (line.trim()) rows.push(JSON.parse(line));
        }
      }
    }
  };
  walk(base);
  return rows;
};

function freshBase(label) {
  return fs.mkdtempSync(path.join(process.env.TMP || os.tmpdir(), `adv1-${label}-`));
}

// ---------------------------------------------------------------------------
// cells
test("ADV1 flag OFF values (kill-switch 0 / legacy other): eligible-shaped event stays native, zero ADV1 telemetry", () => {
  for (const flagValue of ["0", "yes"]) {
    const base = freshBase("off");
    const extra = { CODE_GUARD_ADV1_TRANSPORT: flagValue };
    const out = spawnBridge(lintEvent("adv1off"), baseEnv(base, "", extra));
    assert.equal(deliveredText(out), null, "no delivery under flag value: " + String(flagValue));
    assert.equal(compressionRows(base).length, 0, "no compression row");
    assert.equal(adv1Rows(base), null, "no ADV1 telemetry file");
    const lastArb = arbRows(base)[arbRows(base).length - 1];
    assert.equal(lastArb.fallback_reason, "terminal_delivery_fallback");
    assert.equal(lastArb.applied_capability, null);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("ADV1 flag truth table: unset=ON, 1=ON, 0=OFF, legacy=OFF (candidate default contract)", () => {
  const table = [
    { flag: undefined, expected: "ON" },
    { flag: "1", expected: "ON" },
    { flag: "0", expected: "OFF" },
    { flag: "legacy", expected: "OFF" },
  ];
  for (const { flag, expected } of table) {
    const base = freshBase("tt");
    const extra = flag === undefined ? {} : { CODE_GUARD_ADV1_TRANSPORT: flag };
    const out = spawnBridge(lintEvent("adv1tt"), baseEnv(base, "", extra));
    const delivered = deliveredText(out) !== null;
    const adv1 = adv1Rows(base);
    if (expected === "ON") {
      assert.ok(delivered, "flag " + String(flag) + " must be ON (delivered)");
      assert.equal(compressionRows(base).length, 1);
      assert.equal(compressionRows(base)[0].transport_guard, "adv1");
      assert.ok(Array.isArray(adv1) && adv1.length >= 2, "flag " + String(flag) + " must emit ADV1 telemetry");
    } else {
      assert.equal(delivered, false, "flag " + String(flag) + " must be OFF (native)");
      assert.equal(compressionRows(base).length, 0);
      assert.equal(adv1, null, "flag " + String(flag) + " must emit zero ADV1 telemetry");
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("ADV1 flag ON: eligible event routed -> V1-D applied via existing full policy", () => {
  const base = freshBase("on");
  const out = spawnBridge(lintEvent("adv1on"), baseEnv(base, "", { CODE_GUARD_ADV1_TRANSPORT: "1" }));
  const delivered = deliveredText(out);
  assert.ok(delivered, "compressed diagnostic delivered");
  assert.ok(delivered.length < lintBody().length, "delivered shorter than raw");
  // exactly one transform for this result
  const comps = compressionRows(base);
  assert.equal(comps.length, 1, "single compression row");
  assert.equal(comps[0].capability, "diagnostic_semantic");
  assert.equal(comps[0].transport_guard, "adv1");
  assert.equal(comps[0].transport_replacement_emitted, true);
  assert.equal(comps[0].originalLength, lintBody().length);
  // arbitration: existing winner id, no fifth winner, no double apply
  const arb = arbRows(base).filter((r) => r.applied_capability);
  assert.equal(arb.length, 1);
  assert.equal(arb[0].applied_capability, "diagnostic_semantic");
  assert.equal(arb[0].selection_reason, "adv1_transport_guard_routed");
  assert.equal(arb[0].double_apply_count, 0);
  // policy-side frozen telemetry: structured applied through quick_shell
  const struct = structuredRows(base).filter((r) => r.event === "test_build_structured");
  assert.equal(struct.length, 1);
  assert.equal(struct[0].structured_applied, true);
  assert.equal(struct[0].wiring_path, "quick_shell");
  // ADV1 prefilter telemetry: guard row + delivery row
  const rows = adv1Rows(base);
  assert.ok(Array.isArray(rows) && rows.length === 2, "guard + delivery rows");
  const guard = rows.find((r) => r.event === "adv1_transport_guard");
  assert.equal(guard.routed, true);
  assert.equal(guard.extractor_called, true);
  assert.equal(guard.prefilter_eligible, true);
  assert.equal(guard.kind, "check");
  assert.ok(guard.chars >= 3000);
  assert.ok(guard.extractor_runtime_ms >= 0);
  assert.ok(guard.bytes_inspected > 0);
  const delivery = rows.find((r) => r.event === "adv1_transport_delivery");
  assert.equal(delivery.delivered, "applied");
  assert.equal(delivery.winner, "diagnostic_semantic");
  assert.equal(delivery.double_apply_count, 0);
  fs.rmSync(base, { recursive: true, force: true });
});

test("ADV1 flag ON: ineligible test output keeps native (prefilter rejects)", () => {
  const base = freshBase("inelig");
  const event = {
    hook_event_name: "PostToolUse",
    session_id: "adv1inelig",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "node --test unique.test.js" },
    tool_response: { stdout: bigUniqueTestBody(), stderr: "" },
  };
  const out = spawnBridge(event, baseEnv(base, "", { CODE_GUARD_ADV1_TRANSPORT: "1" }));
  assert.equal(deliveredText(out), null, "native delivery");
  assert.equal(compressionRows(base).length, 0, "no compression row");
  const rows = adv1Rows(base);
  const guard = rows.find((r) => r.event === "adv1_transport_guard");
  assert.equal(guard.extractor_called, true, "prefilter evaluated");
  assert.equal(guard.routed, false, "not routed");
  assert.equal(guard.prefilter_eligible, false);
  assert.equal(guard.prefilter_reason, "no_repeat_structure");
  assert.equal(rows.find((r) => r.event === "adv1_transport_delivery"), undefined, "no delivery row");
  const lastArb = arbRows(base)[arbRows(base).length - 1];
  assert.equal(lastArb.fallback_reason, "terminal_delivery_fallback", "existing native path");
  assert.equal(lastArb.applied_capability, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("ADV1 flag ON: kill-switch CODE_GUARD_TEST_BUILD_STRUCTURED=0 fail-closes the prefilter", () => {
  const base = freshBase("kill");
  const out = spawnBridge(
    lintEvent("adv1kill"),
    baseEnv(base, "", { CODE_GUARD_ADV1_TRANSPORT: "1", CODE_GUARD_TEST_BUILD_STRUCTURED: "0" })
  );
  assert.equal(deliveredText(out), null, "no visible transform");
  assert.equal(compressionRows(base).length, 0, "structured applied = 0");
  const guard = adv1Rows(base).find((r) => r.event === "adv1_transport_guard");
  assert.equal(guard.routed, false);
  assert.equal(guard.extractor_called, false, "prefilter did not run");
  assert.equal(guard.prefilter_reason, "kill_switch_fail_closed");
  assert.equal(guard.gates.kill_switch_active, true);
  fs.rmSync(base, { recursive: true, force: true });
});

test("ADV1 flag ON: cheap gates short-circuit without extractor calls", () => {
  // below size gate
  const baseSmall = freshBase("small");
  const smallEvent = {
    hook_event_name: "PostToolUse",
    session_id: "adv1small",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "npx eslint ." },
    tool_response: { stdout: lintBody().slice(0, 1200), stderr: "" },
  };
  spawnBridge(smallEvent, baseEnv(baseSmall, "", { CODE_GUARD_ADV1_TRANSPORT: "1" }));
  const smallGuard = adv1Rows(baseSmall).find((r) => r.event === "adv1_transport_guard");
  assert.equal(smallGuard.routed, false);
  assert.equal(smallGuard.extractor_called, false);
  assert.equal(smallGuard.prefilter_reason, "below_frozen_size_gate");
  fs.rmSync(baseSmall, { recursive: true, force: true });

  // command class gate (non test/build/check)
  const baseCmd = freshBase("cmdclass");
  const cmdEvent = {
    hook_event_name: "PostToolUse",
    session_id: "adv1cmd",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "ls -laR ." },
    tool_response: { stdout: bigNonTestClassBody(), stderr: "" },
  };
  spawnBridge(cmdEvent, baseEnv(baseCmd, "", { CODE_GUARD_ADV1_TRANSPORT: "1" }));
  const cmdGuard = adv1Rows(baseCmd).find((r) => r.event === "adv1_transport_guard");
  assert.equal(cmdGuard.routed, false);
  assert.equal(cmdGuard.extractor_called, false);
  assert.equal(cmdGuard.prefilter_reason, "command_not_test_build_check");
  fs.rmSync(baseCmd, { recursive: true, force: true });
});

test("ADV1 flag ON: Zone A rule-6 route untouched (byte-identical delivery, zero ADV1 rows)", () => {
  const run = (adv1Flag) => {
    const base = freshBase("zonea");
    const extra = adv1Flag ? { CODE_GUARD_ADV1_TRANSPORT: "1" } : {};
    const out = spawnBridge(
      {
        hook_event_name: "PostToolUse",
        session_id: "adv1zonea",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "npx eslint ." },
        tool_response: { stdout: lintBody(), stderr: "" },
      },
      baseEnv(base, DIAG_PROMPT, extra)
    );
    const result = {
      delivered: JSON.stringify(out),
      comps: compressionRows(base),
      adv1: adv1Rows(base),
    };
    fs.rmSync(base, { recursive: true, force: true });
    return result;
  };
  const off = run(false);
  const on = run(true);
  assert.ok(JSON.parse(off.delivered).hookSpecificOutput, "Zone A delivered under GA");
  assert.equal(on.delivered, off.delivered, "delivery byte-identical with guard ON");
  assert.equal(on.adv1, null, "guard never evaluated for Zone A events");
  assert.equal(on.comps.length, off.comps.length, "telemetry row count unchanged");
});

test("ADV1 flag ON: Zone B failure-carrier route untouched (byte-identical delivery, zero ADV1 rows)", () => {
  const carrier = [
    "[TASCO_FAILURE_CARRIER] carrier_version=1 transport=pre_tool_use_auto",
    "original_command=npx eslint .",
    "original_exit_code=1",
    "failure_kind=command_failure",
    "truncated=false",
    "[TASCO_FAILURE_CARRIER_STDOUT]",
    lintBody(),
    "[TASCO_FAILURE_CARRIER_STDERR]",
    "",
    "[TASCO_FAILURE_CARRIER_END]",
  ].join("\n");
  const run = (adv1Flag) => {
    const base = freshBase("zoneb");
    const extra = adv1Flag ? { CODE_GUARD_ADV1_TRANSPORT: "1" } : {};
    const out = spawnBridge(
      {
        hook_event_name: "PostToolUse",
        session_id: "adv1zoneb",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "npx eslint ." },
        tool_response: { stdout: carrier, stderr: "" },
      },
      baseEnv(base, "", extra)
    );
    const result = {
      delivered: JSON.stringify(out),
      comps: compressionRows(base),
      adv1: adv1Rows(base),
      arb: arbRows(base).filter((r) => r.applied_capability),
    };
    fs.rmSync(base, { recursive: true, force: true });
    return result;
  };
  const off = run(false);
  const on = run(true);
  assert.ok(JSON.parse(off.delivered).hookSpecificOutput, "Zone B delivered under GA");
  assert.equal(on.delivered, off.delivered, "delivery byte-identical with guard ON");
  assert.equal(on.adv1, null, "guard never evaluated for Zone B events");
  assert.equal(on.comps.length, off.comps.length, "telemetry row count unchanged");
  assert.equal(on.arb[0].selection_reason, "failure_carrier_contract_v1", "Zone B winner identity unchanged");
});

test("ADV1 flag ON: terminal-success precedence untouched (terminal wins before the guard)", () => {
  const base = freshBase("term");
  const tapText = fs.readFileSync(
    path.join(__dirname, "..", "..", "docs", "experiments", "workflow-compression", "p0-agent-ab", "qualification", "fixtures", "f1-tap-44pass.out"),
    "utf8"
  );
  const event = {
    hook_event_name: "PostToolUse",
    session_id: "adv1term",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "node --test --test-reporter=tap pass.test.js" },
    tool_response: { stdout: tapText, stderr: "" },
  };
  const run = (adv1Flag) => {
    const b = freshBase("term");
    const extra = adv1Flag ? { CODE_GUARD_ADV1_TRANSPORT: "1" } : {};
    const out = spawnBridge(event, baseEnv(b, "", extra));
    const result = {
      delivered: JSON.stringify(out),
      comps: compressionRows(b),
      adv1: adv1Rows(b),
      arb: arbRows(b).filter((r) => r.applied_capability),
    };
    fs.rmSync(b, { recursive: true, force: true });
    return result;
  };
  const off = run(false);
  const on = run(true);
  assert.ok(JSON.parse(off.delivered).hookSpecificOutput, "terminal delivered under GA");
  assert.equal(on.delivered, off.delivered, "terminal delivery byte-identical with guard ON");
  assert.equal(on.comps[0].capability, "terminal_state_success", "terminal winner identity unchanged");
  assert.equal(on.adv1, null, "guard never evaluated when terminal applied");
  assert.equal(on.arb[0].applied_capability, "terminal_state_success");
});
