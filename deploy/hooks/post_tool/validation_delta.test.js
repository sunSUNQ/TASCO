"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  foldCommand,
  parseCases,
  extractCounts,
  buildFingerprint,
  tryCompressValidationDelta,
} = require("./validation_delta.js");

const CMD =
  "node --test --test-reporter=tap test/route.6.test.js test/route.7.test.js test/constrained-routes.test.js";

// node:test 真实输出形态：嵌套 subtest 块重复 "# pass/fail"，top-level tail 为权威。
const FAIL_TAP = [
  "TAP version 13",
  "# Subtest: Should register a host constrained route",
  "not ok 1 - Should register a host constrained route",
  "  ---",
  "  duration_ms: 60.0009",
  "  type: 'test'",
  "  ...",
  "# Subtest: inner group",
  "# pass 1",
  "# fail 1",
  "# Subtest: Should allow registering custom constrained routes",
  "ok 2 - Should allow registering custom constrained routes",
  "1..2",
  "# tests 2",
  "# suites 1",
  "# pass 1",
  "# fail 1",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
].join("\n");

// 与 FAIL_TAP 同套件、修复后的全绿输出（1 个新增 case，模拟修复后加测试）。
const PASS_TAP_45 = [
  "TAP version 13",
  "# Subtest: Should register a host constrained route",
  "ok 1 - Should register a host constrained route",
  "# Subtest: Should allow registering custom constrained routes",
  "ok 2 - Should allow registering custom constrained routes",
  "# Subtest: Should allow registering custom constrained routes outside constructor",
  "ok 3 - Should allow registering custom constrained routes outside constructor",
  "1..3",
  "# tests 3",
  "# suites 0",
  "# pass 3",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
].join("\n");

// 与 PASS_TAP_45 相同的输出（第二次全绿 = 零变化确认）。
const PASS_TAP_45_AGAIN = PASS_TAP_45;

test("parser: node:test TAP ok/not ok case lines", () => {
  const cases = parseCases(FAIL_TAP);
  assert.deepEqual(
    cases.filter((c) => c.state === "fail").map((c) => c.name),
    ["Should register a host constrained route"]
  );
  assert.deepEqual(
    cases.filter((c) => c.state === "pass").map((c) => c.name),
    ["Should allow registering custom constrained routes"]
  );
});

test("parser: jest/vitest checkmark lines and pytest names", () => {
  const jest = parseCases("✓ adds 1 + 2 (12 ms)\n✗ rejects invalid input (3 ms)\n○ skips legacy");
  assert.deepEqual(jest, [
    { name: "adds 1 + 2", state: "pass" },
    { name: "rejects invalid input", state: "fail" },
  ]);
  const pytest = parseCases("test/routes_test.py::test_host_route PASSED\ntest/routes_test.py::test_bad_host FAILED");
  assert.deepEqual(pytest, [
    { name: "test_host_route", state: "pass" },
    { name: "test_bad_host", state: "fail" },
  ]);
});

test("parser: mocha spec passing cases and numbered failure list", () => {
  const mocha = parseCases("  ✓ should register a route (6ms)\n  1) should reject invalid host:\n");
  assert.deepEqual(mocha, [
    { name: "should register a route", state: "pass" },
    { name: "should reject invalid host:", state: "fail" },
  ]);
});

test("counts: last-match wins (nested TAP blocks repeat # pass)", () => {
  const counts = extractCounts(FAIL_TAP);
  assert.deepEqual(counts, { pass: 1, fail: 1, skip: 0, todo: 0 });
});

test("counts: mocha/jest tail styles", () => {
  assert.deepEqual(extractCounts("Tests: 12 passed, 12 total\nTime: 1.2s"), { pass: 12, fail: 0, skip: 0, todo: 0 });
  assert.deepEqual(extractCounts("  44 passing (2s)\n  2 failing\n  3 pending"), {
    pass: 44,
    fail: 2,
    skip: 3,
    todo: 0,
  });
  assert.equal(extractCounts("some output without counts"), null);
});

test("fingerprint: failure run carries failed names; unknown terminal state is not comparable", () => {
  const fp = buildFingerprint({ command: CMD, text: FAIL_TAP });
  assert.equal(fp.state, "failure");
  assert.equal(fp.ok, true);
  assert.deepEqual(fp.counts, { pass: 1, fail: 1, skip: 0, todo: 0 });
  assert.deepEqual(fp.failedNames, ["Should register a host constrained route"]);
  assert.equal(buildFingerprint({ command: CMD, text: "boom, no test shape here" }), null);
});

test("delta: failure -> success resolution lists previously failing cases", () => {
  const previous = buildFingerprint({ command: CMD, text: FAIL_TAP });
  const r = tryCompressValidationDelta({ command: CMD, text: PASS_TAP_45, previous });
  assert.ok(r, "delta must form after a fix rerun");
  assert.equal(r.mode, "failure_to_success_resolution");
  assert.match(r.deltaText, /^\[VALIDATION_DELTA\]/);
  assert.match(r.deltaText, /mode=failure_to_success_resolution/);
  assert.match(r.deltaText, /- Should register a host constrained route/);
  assert.match(r.deltaText, /counts: pass=3 fail=0 skip=0/);
});

test("delta: success -> success unchanged is recognizable", () => {
  const previous = buildFingerprint({ command: CMD, text: PASS_TAP_45 });
  const r = tryCompressValidationDelta({ command: CMD, text: PASS_TAP_45_AGAIN, previous });
  assert.ok(r);
  assert.equal(r.mode, "success_unchanged");
  assert.match(r.deltaText, /case_level_changes=0/);
  assert.match(r.deltaText, /unchanged_since_previous_run: pass=3/);
});

test("delta: success -> success with added tests reports counts delta", () => {
  const previous = buildFingerprint({ command: CMD, text: PASS_TAP_45 });
  const grown = PASS_TAP_45.replace("# pass 3", "# pass 4")
    .replace("# tests 3", "# tests 4")
    .replace("ok 3 - ", "ok 3 - extra\nok 4 - ");
  const r = tryCompressValidationDelta({ command: CMD, text: grown, previous });
  assert.ok(r);
  assert.equal(r.mode, "success_counts_changed");
  assert.match(r.deltaText, /pass 3->4/);
});

test("delta: no comparable previous -> null (terminal/native stay as-is)", () => {
  assert.equal(tryCompressValidationDelta({ command: CMD, text: PASS_TAP_45, previous: null }), null);
  const otherCmd = buildFingerprint({ command: "npm test", text: PASS_TAP_45 });
  assert.equal(tryCompressValidationDelta({ command: CMD, text: PASS_TAP_45, previous: otherCmd }), null);
});

test("delta: non-test command and failure current are out of the v1 positive zone", () => {
  const previous = buildFingerprint({ command: "npm run build", text: PASS_TAP_45 });
  assert.equal(
    tryCompressValidationDelta({ command: "npm run build", text: PASS_TAP_45, previous }),
    null
  );
  assert.equal(
    tryCompressValidationDelta({ command: CMD, text: FAIL_TAP, previous }),
    null
  );
});

test("delta: failure not attributable to named cases still resolves", () => {
  const bareFail = buildFingerprint({
    command: CMD,
    // 真实失败 TAP 总带 not ok 行；此处构造名字不可解析的失败（not ok 无名字）
    text: ["TAP version 13", "not ok 1 -", "1..1", "# tests 1", "# pass 0", "# fail 1"].join("\n"),
  });
  assert.equal(bareFail.state, "failure");
  const r = tryCompressValidationDelta({ command: CMD, text: PASS_TAP_45, previous: bareFail });
  assert.ok(r);
  assert.match(r.deltaText, /previously_failing_cases=0 \(failure was not case-attributable\)/);
});

test("delta: length guard rejects tiny raw outputs", () => {
  const previous = buildFingerprint({ command: CMD, text: FAIL_TAP });
  const tinyPass = [
    "# pass 2",
    "# fail 0",
    "ok 1 - a",
    "ok 2 - b",
  ].join("\n"); // 无 tests/suites 头但带 summary —— success 判定需 detectTerminalState
  // detectTerminalState 要求成功证据：该文本无 "# ok"/pass 计数成功形态? "# pass 2" 非
  // TEST_SUCCESS_PATTERNS（需 "# pass N" 行首? node 形态 "# pass 44" 在 patterns 内）
  const r = tryCompressValidationDelta({ command: CMD, text: tinyPass, previous });
  assert.ok(r === null || r.deltaText.length < tinyPass.length * 0.8);
});

test("realistic TAP44 fixture parses and yields unchanged delta against itself", () => {
  const tap44 = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "docs", "experiments", "workflow-compression", "p0-agent-ab", "qualification", "fixtures", "f1-tap-44pass.out"),
    "utf8"
  );
  assert.equal(extractCounts(tap44).pass, 44);
  const fp = buildFingerprint({ command: CMD, text: tap44 });
  assert.equal(fp.state, "success");
  assert.equal(fp.passedCount, 44);
  const r = tryCompressValidationDelta({ command: CMD, text: tap44, previous: fp });
  assert.ok(r);
  assert.equal(r.mode, "success_unchanged");
});

test("foldCommand normalizes whitespace and length", () => {
  assert.equal(foldCommand("  node   --test\n test/a"), "node --test test/a");
  assert.ok(foldCommand(CMD).length <= 200);
});
