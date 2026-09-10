"use strict";

// Unit / component regression for the P1-S2b auto carrier rewrite builder
// (deploy/hooks/pre_tool/failure_carrier_auto.js).
// Eligibility is fail-closed by contract: only simple frozen test/build
// command forms are rewritten; everything else stays native.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isAutoCarrierEligible,
  buildCarrierRewrite,
  parseCarrierWrapper,
} = require("./failure_carrier_auto");

const HOOK_DIR = "C:/some/deploy/hooks";

test("eligible simple test/build commands pass fail-closed eligibility", () => {
  for (const cmd of [
    "npm test",
    "node --test checkout.test.js",
    "npx jest test/route.test.js",
    "pytest tests/",
    "npm run build",
    "npx tsc --noEmit",
    "go test ./...",
    "cargo test",
    // env-prefix assignment replays transparently under bash -c.
    "FOO=1 npm test",
  ]) {
    const d = isAutoCarrierEligible({ toolName: "Bash", command: cmd });
    assert.equal(d.eligible, true, cmd);
    assert.equal(d.reason, "test_or_build_validation_form", cmd);
  }
});

test("ineligible: non-Bash tools, unknown forms, unsafe shell shapes", () => {
  const cases = [
    [{ toolName: "Read", command: "npm test" }, "tool_not_bash"],
    [{ toolName: "Bash", command: "" }, "empty_command"],
    [{ toolName: "Bash", command: "   " }, "empty_command"],
    [{ toolName: "Bash", command: "echo hi" }, "not_test_or_build_form"],
    [{ toolName: "Bash", command: "node scripts/verify.js" }, "not_test_or_build_form"],
    [{ toolName: "Bash", command: "npm test && echo done" }, "unsafe_shell_shape"],
    [{ toolName: "Bash", command: "npm test | tee out.log" }, "unsafe_shell_shape"],
    [{ toolName: "Bash", command: "npm test > out.log" }, "unsafe_shell_shape"],
    [{ toolName: "Bash", command: "npm run test 'case 1'" }, "unsafe_shell_shape"],
    [{ toolName: "Bash", command: "npm run test \"case 1\"" }, "unsafe_shell_shape"],
    [{ toolName: "Bash", command: "node --test C:\\repo\\checkout.test.js" }, "unsafe_shell_shape"],
    [{ toolName: "Bash", command: "node --test test/*.test.js" }, "unsafe_shell_shape"],
    [{ toolName: "Bash", command: "npm test --watch" }, "interactive_or_watch"],
    [{ toolName: "Bash", command: "npx jest --watchAll" }, "interactive_or_watch"],
    [{ toolName: "Bash", command: "node --test a.js # ".padEnd(1100, "x") }, "command_too_long"],
    [{ toolName: "Bash", command: "node \"C:/x/failure_carrier_shim.js\" --orig abc" }, "already_carrier_wrapped"],
  ];
  for (const [input, reason] of cases) {
    const d = isAutoCarrierEligible(input);
    assert.equal(d.eligible, false, JSON.stringify(input));
    assert.equal(d.reason, reason, JSON.stringify(input));
  }
});

test("rewrite is deterministic: same original command -> byte-identical wrapper", () => {
  const cmd = "node --test checkout.test.js";
  const a = buildCarrierRewrite({ command: cmd, hookDir: HOOK_DIR });
  const b = buildCarrierRewrite({ command: cmd, hookDir: HOOK_DIR });
  assert.equal(a.rewrittenCommand, b.rewrittenCommand);
  assert.equal(a.token, b.token);
  assert.equal(a.shimPath, `${HOOK_DIR}/carrier/failure_carrier_shim.js`);
  assert.match(a.rewrittenCommand, /^node "C:\/some\/deploy\/hooks\/carrier\/failure_carrier_shim\.js" --orig "[A-Za-z0-9_-]+"$/);
});

test("parseCarrierWrapper restores the original command in-band (round trip)", () => {
  for (const cmd of [
    "node --test checkout.test.js",
    "npm test",
    "npm run build -- --mode production",
    "node --test C:/Users/迁移/fixture/checkout.test.js",
  ]) {
    const { rewrittenCommand } = buildCarrierRewrite({ command: cmd, hookDir: HOOK_DIR });
    const parsed = parseCarrierWrapper(rewrittenCommand);
    assert.ok(parsed, cmd);
    assert.equal(parsed.originalCommand, cmd, cmd);
    assert.equal(parsed.shimPath, `${HOOK_DIR}/carrier/failure_carrier_shim.js`);
  }
});

test("parseCarrierWrapper returns null for legacy commands (no false positive)", () => {
  for (const cmd of [
    "npm test",
    "node --test checkout.test.js",
    "node C:/x/failure_carrier_shim.js --orig not-base64!!",
    'node "C:/x/other.js" --orig abc',
    "",
  ]) {
    assert.equal(parseCarrierWrapper(cmd), null, JSON.stringify(cmd));
  }
});

test("different original commands produce different wrappers (identity separation)", () => {
  const a = buildCarrierRewrite({ command: "node --test a.test.js", hookDir: HOOK_DIR });
  const b = buildCarrierRewrite({ command: "node --test b.test.js", hookDir: HOOK_DIR });
  assert.notEqual(a.rewrittenCommand, b.rewrittenCommand);
  assert.notEqual(parseCarrierWrapper(a.rewrittenCommand).originalCommand,
    parseCarrierWrapper(b.rewrittenCommand).originalCommand);
});
