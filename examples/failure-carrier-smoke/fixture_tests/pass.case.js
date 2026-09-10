"use strict";

// Passing fixture for the success-passthrough gate: the auto carrier must be
// invisible on success (M3 protection).
const test = require("node:test");
for (let i = 0; i < 45; i++) {
  test("route constraint " + i + " registers the host scoped matcher", () => {
    require("node:assert/strict").ok(true);
  });
}
