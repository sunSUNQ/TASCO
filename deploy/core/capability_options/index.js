"use strict";

// Capability Options V1 — public entry (Phase 1: infrastructure only).

const schema = require("./schema.js");
const config = require("./config.js");
const gate = require("./gate.js");

module.exports = {
  ...schema,
  ...config,
  ...gate,
};
