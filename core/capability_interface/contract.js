// Unified Capability Interface v1 - capability contract.
// No runtime behavior is changed by this module; it only defines the unified
// description/decision schema used by the Shadow Conservative Router.
"use strict";

const STRATEGIES = [
  "diagnostic_semantic",
  "search_selective",
  "read_extractive",
  "structural_relational",
  "native",
];

// Static capability metadata (from SELECTIVE-CONTEXT-OPTIMIZATION-V1.md).
const CAPABILITY_META = {
  diagnostic_semantic: {
    capability_id: "large_diagnostic_compression",
    evidence_type: "semantic",
    quality_guard: "coverage_guard",
    fallback_policy: "native_original",
  },
  search_selective: {
    capability_id: "search_compression",
    evidence_type: "semantic",
    quality_guard: "exact_match_fidelity",
    fallback_policy: "native_original",
  },
  read_extractive: {
    capability_id: "extractive_read",
    evidence_type: "lexical",
    quality_guard: "lexical_fidelity_100",
    fallback_policy: "native_original",
  },
  structural_relational: {
    capability_id: "structural_context",
    evidence_type: "relational",
    quality_guard: "deterministic_map",
    fallback_policy: "native_exploration",
  },
  native: {
    capability_id: "native",
    evidence_type: "n/a",
    quality_guard: "none",
    fallback_policy: "none",
  },
};

function buildContract(decision) {
  const meta = CAPABILITY_META[decision.expected_strategy] || CAPABILITY_META.native;
  return {
    capability_id: meta.capability_id,
    evidence_type: meta.evidence_type,
    eligible: decision.eligible,
    confidence: decision.confidence,
    reason: decision.reason,
    source_tool: decision.source_tool,
    input_size: decision.input_size,
    expected_strategy: decision.expected_strategy,
    quality_guard: meta.quality_guard,
    fallback_policy: meta.fallback_policy,
  };
}

module.exports = { STRATEGIES, CAPABILITY_META, buildContract };
