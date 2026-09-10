"use strict";

// AUTO Arbitration Runtime v1 (A1 skeleton).
// This module owns winner selection only. Capability detection and delivery
// remain in their existing modules; Validation Delta is contract-only here.

const ARBITRATION_VERSION = "AUTO-ARBITRATION-V1";
const NATIVE = "native";
// M4 amendment (line-6 Read Runtime Integration, 2026-09-09): read events
// (read_file) form at most one read_task_compression candidate and never
// co-occur with shell-domain candidates (diagnostic/VD/terminal), so the
// frozen shell precedence is untouched; an impossible read+shell competition
// still falls through to ambiguous_or_unsafe -> native (fail-safe).
const CONTENT_CAPABILITIES = new Set([
  "diagnostic_semantic",
  "validation_delta",
  "terminal_state_success",
  "read_task_compression",
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeCandidate(candidate) {
  const id = String(candidate && candidate.id ? candidate.id : "");
  if (!CONTENT_CAPABILITIES.has(id)) throw new Error(`unknown arbitration capability: ${id}`);
  return {
    id,
    eligible: Boolean(candidate.eligible),
    reason: String(candidate.reason || ""),
    evidence: candidate.evidence && typeof candidate.evidence === "object" ? candidate.evidence : {},
  };
}

function nativeDecision({ candidates, eligible, reason }) {
  return {
    arbitration_version: ARBITRATION_VERSION,
    candidate_capabilities: unique(candidates.map((c) => c.id)),
    eligible_capabilities: unique(eligible.map((c) => c.id)),
    selected_capability: null,
    selection_reason: reason,
    applied_capability: null,
    fallback_reason: reason,
    double_apply_count: 0,
  };
}

function arbitrate(input = {}) {
  const raw = Array.isArray(input.candidates) ? input.candidates : [];
  const candidates = raw.map(normalizeCandidate);
  const eligible = candidates.filter((c) => c.eligible);
  if (eligible.length === 0) {
    return nativeDecision({ candidates, eligible, reason: input.fallbackReason || "no_eligible_capability" });
  }
  if (eligible.length === 1) {
    const winner = eligible[0];
    return {
      arbitration_version: ARBITRATION_VERSION,
      candidate_capabilities: unique(candidates.map((c) => c.id)),
      eligible_capabilities: unique(eligible.map((c) => c.id)),
      selected_capability: winner.id,
      selection_reason: winner.reason || "single_eligible_capability",
      applied_capability: null,
      fallback_reason: null,
      double_apply_count: 0,
    };
  }

  const ids = new Set(eligible.map((c) => c.id));
  const diagnostic = eligible.find((c) => c.id === "diagnostic_semantic");
  const validation = eligible.find((c) => c.id === "validation_delta");
  const terminal = eligible.find((c) => c.id === "terminal_state_success");

  // A0 precedence mirrored: failure diagnostic > eligible validation delta >
  // eligible terminal success > native. An eligible-but-weak validation delta
  // (stableDelta not asserted) never auto-delegates to a noisier winner:
  // three-way unresolved competition stays native (conflict fixture C10).
  if (diagnostic && diagnostic.evidence.failure === true) {
    return select(diagnostic, candidates, eligible, "failure_diagnostic_precedence");
  }
  if (validation) {
    if (validation.evidence.stableDelta === true) {
      return select(validation, candidates, eligible, "stable_validation_delta_precedence");
    }
    return nativeDecision({ candidates, eligible, reason: "ambiguous_or_unsafe" });
  }
  if (diagnostic && terminal && terminal.evidence.success === true) {
    return select(terminal, candidates, eligible, "terminal_success_over_diagnostic_candidate");
  }
  if (terminal && !diagnostic) {
    return nativeDecision({ candidates, eligible, reason: "terminal_evidence_incomplete" });
  }

  // Unresolved competition is unsafe until a future contract revision
  // provides stronger evidence.
  return nativeDecision({ candidates, eligible, reason: "ambiguous_or_unsafe" });
}

function select(winner, candidates, eligible, reason) {
  return {
    arbitration_version: ARBITRATION_VERSION,
    candidate_capabilities: unique(candidates.map((c) => c.id)),
    eligible_capabilities: unique(eligible.map((c) => c.id)),
    selected_capability: winner.id,
    selection_reason: reason,
    applied_capability: null,
    fallback_reason: null,
    double_apply_count: 0,
  };
}

function markApplied(decision, appliedCapability) {
  const applied = appliedCapability ? String(appliedCapability) : null;
  if (!applied) return { ...decision, applied_capability: null, double_apply_count: 0 };
  if (decision.selected_capability !== applied) {
    return {
      ...decision,
      applied_capability: null,
      fallback_reason: "delivery_winner_mismatch",
      double_apply_count: 0,
    };
  }
  // This field counts duplicate applications, not successful applications.
  // A single delivery therefore remains at zero.
  return { ...decision, applied_capability: applied, double_apply_count: 0 };
}

module.exports = { ARBITRATION_VERSION, arbitrate, markApplied };
