"use strict";
// 确定性 fixture：微型 node:test 套件，产出 TAP tap-reporter 成功终态输出。
// 刻意包含 1 个 skipped case（验证 skipped 保留语义）与多 case 行（验证省略+记账）。
const test = require("node:test");
const assert = require("node:assert/strict");

const add = (a, b) => a + b;

test("adds positive integers", () => assert.equal(add(1, 2), 3));
test("adds negative integers", () => assert.equal(add(-1, -2), -3));
test("adds zero", () => assert.equal(add(0, 5), 5));
test("is commutative", () => assert.equal(add(2, 3), add(3, 2)));
test("handles large numbers", () => assert.equal(add(100000, 200000), 300000));
test("returns number type", () => assert.equal(typeof add(1, 1), "number"));
test("identity element", () => assert.equal(add(7, 0), 7));
test("decimal addition", () => assert.equal(add(0.1, 0.2), 0.30000000000000004));
test("string coercion avoided", () => assert.ok(!Number.isNaN(add(1, "2"))));
test("bigint support", () => assert.equal(add(10n, 20n), 30n));
test("nested calls", () => assert.equal(add(add(1, 1), add(1, 1)), 4));
test("max safe integer stays exact", () => assert.equal(add(Number.MAX_SAFE_INTEGER, 0), Number.MAX_SAFE_INTEGER));
test("negative result", () => assert.equal(add(-5, 2), -3));
test("repeated invocation is stable", () => { for (let i = 0; i < 10; i++) assert.equal(add(i, i), i * 2); });
// 体量放大：真实 hook 对 <2,000-char 输出走 short_output native（平台/策略门槛），
// 冒烟需产出足够大的成功终态输出以进入 terminal 判定区（见 README）。
for (let i = 0; i < 30; i++) {
  test(`parameterized property #${i}: addition is consistent for operand pair (${i}, ${i + 1}) and remains deterministic across repeated calls`, () =>
    assert.equal(add(i, i + 1), 2 * i + 1));
}
test("skipped demonstration case", { skip: "natural skip example" }, () => assert.fail("never runs"));
