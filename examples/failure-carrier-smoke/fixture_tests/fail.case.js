"use strict";

// P1 failure-carrier smoke fixture: free-shipping boundary bug (unfixed).
// `node --test --test-reporter=tap fail.test.js` exits 1 with a real
// assertion failure at the 10000-cent threshold.
const test = require("node:test");
const assert = require("node:assert/strict");
const { shippingCents, FREE_SHIPPING_THRESHOLD, FLAT_FEE_CENTS } = require("../fixture_lib/checkout.js");

test("free-shipping threshold is " + FREE_SHIPPING_THRESHOLD + " cents and flat fee is " + FLAT_FEE_CENTS + " cents", () => {
  assert.equal(FREE_SHIPPING_THRESHOLD, 10000);
  assert.equal(FLAT_FEE_CENTS, 499);
});

for (let i = 0; i < 25; i++) {
  const total = i * 250;
  test(`checkout case ${i}: total ${total} cents below the threshold pays the flat 499-cent fee`, () => {
    assert.equal(shippingCents(total), FLAT_FEE_CENTS);
  });
}

test("boundary: total 10000 cents reaches the free-shipping threshold and ships free", () => {
  assert.equal(shippingCents(10000), 0);
});
