"use strict";

const FREE_SHIPPING_THRESHOLD = 10000;
const FLAT_FEE_CENTS = 499;

function shippingCents(totalCents) {
  if (totalCents > FREE_SHIPPING_THRESHOLD) {
    return 0;
  }
  return FLAT_FEE_CENTS;
}

module.exports = { shippingCents, FREE_SHIPPING_THRESHOLD, FLAT_FEE_CENTS };
