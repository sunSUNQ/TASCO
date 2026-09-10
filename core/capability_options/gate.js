"use strict";

// Capability Options V1 — capability gate (Phase 2A).
//
// Thin pure function: decides whether a capability may execute, based ONLY on
// the resolved capability options (single control surface). No routing logic
// here. Phase 2A wires exactly one capability into the runtime:
//   diagnostic.semantic_compression (default auto -> enabled).
// The other 12 registered capabilities stay off and must never intervene just
// because wiring exists.

const { STATUS, DEFAULT_CAPABILITY_STATES } = require("./schema.js");
const { resolveCapabilityOptions } = require("./config.js");

// strategy (shadow_router expected_strategy) -> capability id (telemetry + gate).
const STRATEGY_TO_CAPABILITY = Object.freeze({
  diagnostic_semantic: "diagnostic.semantic_compression",
  search_selective: "search.result_selective_compression",
  read_extractive: "read.result_compression",
  structural_relational: "repo_navigation.repo_map_first",
});

function capabilityForStrategy(strategy) {
  return STRATEGY_TO_CAPABILITY[strategy] || null;
}

/**
 * Returns the unified capability decision:
 *   { capability_id, configured_status, effective_status, enabled, reason }
 */
function resolveCapabilityDecision({ capabilityId, resolvedOptions, context }) {
  const opts = resolvedOptions || resolveCapabilityOptions({});
  const configured = opts.capabilities[capabilityId];
  const effective = configured; // Phase 2A: no dynamic overrides
  const enabled = effective === STATUS.AUTO || effective === STATUS.CANARY;
  let reason;
  if (effective === STATUS.AUTO) {
    reason =
      DEFAULT_CAPABILITY_STATES[capabilityId] === effective
        ? "formal_release_default"
        : "explicit_auto";
  } else {
    reason = `capability_${effective}`;
  }
  return {
    capability_id: capabilityId,
    configured_status: configured,
    effective_status: effective,
    enabled,
    reason,
  };
}

module.exports = {
  STRATEGY_TO_CAPABILITY,
  capabilityForStrategy,
  resolveCapabilityDecision,
};
