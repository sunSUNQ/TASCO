"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ARBITRATION_VERSION, arbitrate, markApplied } = require("./arbitration_runtime.js");

test("A1 single terminal candidate selects one winner and starts unapplied", () => {
  const d = arbitrate({
    candidates: [{ id: "terminal_state_success", eligible: true, reason: "success summary", evidence: { success: true } }],
  });
  assert.equal(d.arbitration_version, ARBITRATION_VERSION);
  assert.equal(d.selected_capability, "terminal_state_success");
  assert.equal(d.applied_capability, null);
  assert.equal(d.double_apply_count, 0);
  assert.deepEqual(d.eligible_capabilities, ["terminal_state_success"]);
});

test("A1 successful terminal wins over a broad diagnostic candidate", () => {
  const d = arbitrate({
    candidates: [
      { id: "diagnostic_semantic", eligible: true, reason: "broad diagnostic candidate", evidence: { failure: false } },
      { id: "terminal_state_success", eligible: true, reason: "success summary", evidence: { success: true } },
    ],
  });
  assert.equal(d.selected_capability, "terminal_state_success");
  assert.equal(d.selection_reason, "terminal_success_over_diagnostic_candidate");
  assert.equal(markApplied(d, "terminal_state_success").double_apply_count, 0);
});

test("A1 failure diagnostic wins over success-like noise", () => {
  const d = arbitrate({
    candidates: [
      { id: "diagnostic_semantic", eligible: true, evidence: { failure: true } },
      { id: "terminal_state_success", eligible: true, evidence: { success: true } },
    ],
  });
  assert.equal(d.selected_capability, "diagnostic_semantic");
});

test("A1 stable delta wins over terminal, but ambiguous three-way falls back", () => {
  const delta = arbitrate({
    candidates: [
      { id: "validation_delta", eligible: true, evidence: { stableDelta: true } },
      { id: "terminal_state_success", eligible: true, evidence: { success: true } },
    ],
  });
  assert.equal(delta.selected_capability, "validation_delta");
  const ambiguous = arbitrate({
    candidates: [
      { id: "diagnostic_semantic", eligible: true },
      { id: "validation_delta", eligible: true },
      { id: "terminal_state_success", eligible: true },
    ],
  });
  assert.equal(ambiguous.selected_capability, null);
  assert.equal(ambiguous.fallback_reason, "ambiguous_or_unsafe");
});

test("A1 stable delta wins a three-way with a non-failure diagnostic candidate", () => {
  const d = arbitrate({
    candidates: [
      { id: "diagnostic_semantic", eligible: true, reason: "broad diagnostic candidate", evidence: { failure: false } },
      { id: "validation_delta", eligible: true, reason: "comparable previous run", evidence: { stableDelta: true } },
      { id: "terminal_state_success", eligible: true, reason: "success summary", evidence: { success: true } },
    ],
  });
  assert.equal(d.selected_capability, "validation_delta");
  assert.equal(d.selection_reason, "stable_validation_delta_precedence");
});

test("A1 failure diagnostic still beats a stable delta when both are eligible", () => {
  const d = arbitrate({
    candidates: [
      { id: "diagnostic_semantic", eligible: true, evidence: { failure: true } },
      { id: "validation_delta", eligible: true, evidence: { stableDelta: true } },
      { id: "terminal_state_success", eligible: true, evidence: { success: true } },
    ],
  });
  assert.equal(d.selected_capability, "diagnostic_semantic");
});

test("A1 never permits double apply or winner mismatch", () => {
  const d = arbitrate({ candidates: [{ id: "terminal_state_success", eligible: true }] });
  assert.equal(markApplied(d, "terminal_state_success").double_apply_count, 0);
  const mismatch = markApplied(d, "diagnostic_semantic");
  assert.equal(mismatch.applied_capability, null);
  assert.equal(mismatch.double_apply_count, 0);
  assert.equal(mismatch.fallback_reason, "delivery_winner_mismatch");
});
