// ============================================================================
// diagnostic_fidelity.js — Model-visible diagnostic fidelity gate (P0 repair)
// ============================================================================
// Guards the "quick_shell" delivery path (error-focused shell summaries). A
// compressed diagnostic summary may only replace the raw tool output when the
// critical diagnostic facts it must preserve are mechanically verifiable in the
// delivered text. Otherwise the caller MUST fall back to native (full original).
//
// Principle: diagnostic fidelity > token savings. Fail-closed on doubt.
//
// Critical facts (high-confidence, auditable source location = 1-based source
// line index + anchor substring):
//   root_cause    — lines matching /root[- ]cause/i            (all)
//   fatal         — lines matching /\bfatal\b/i                (all)
//   failure_count — "# fail N" / "N/N … failed" / "N error(s)" (all)
//   not_ok        — first TAP "not ok N - …" assertion          (representative)
//   stack         — first "at <fn> (<file>:<line>:<col>)" frame (representative)
//
// Retention is verified by normalized-substring containment of the anchor in
// the compressed text — no side-store access required. This module is pure and
// side-effect free; callers decide delivery and telemetry.
// ============================================================================

"use strict";

const FACT_TYPES = ["root_cause", "fatal", "failure_count", "not_ok", "stack"];

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Extract the critical diagnostic facts from a raw tool output. Returns an
 * array of { type, line, anchor } where `line` is the 1-based source line and
 * `anchor` is the normalized substring that must survive compression.
 */
function extractCriticalDiagnosticFacts(text) {
  const lines = String(text || "").split(/\r?\n/);
  const facts = [];
  let notOkSeen = false;
  let stackSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;
    const idx = i + 1;

    // 1) Root-cause summary line.
    if (/root[- ]cause/i.test(t)) {
      const m = t.match(/root[- ]cause[^\n]*/i);
      facts.push({ type: "root_cause", line: idx, anchor: (m ? m[0] : t).slice(0, 60) });
      continue;
    }
    // 2) Fatal line.
    if (/\bfatal\b/i.test(t)) {
      const m = t.match(/fatal[^\n]*/i);
      facts.push({ type: "fatal", line: idx, anchor: (m ? m[0] : t).slice(0, 60) });
      continue;
    }
    // 3) Failure-count summary (aggregate, not per-case).
    const countMatch = t.match(
      /#\s*(?:fail|failed)\s*\d+|\b\d+\s*\/\s*\d+\s+\w+\s+failed\b|\b\d+\s+(?:error|errors|failure|failures|failed)\b/i
    );
    if (countMatch) {
      facts.push({ type: "failure_count", line: idx, anchor: countMatch[0].slice(0, 60) });
      continue;
    }
    // 4) TAP assertion line — representative (first) only.
    if (!notOkSeen && /^not ok\s+\d+\b/i.test(t)) {
      const m = t.match(/not ok\s+\d+[^\n]*/i);
      facts.push({ type: "not_ok", line: idx, anchor: (m ? m[0] : t).slice(0, 60) });
      notOkSeen = true;
      continue;
    }
    // 5) Stack frame with file:line — representative (first) only.
    if (!stackSeen && /\bat\s+[^\s]+ \([-\\\w./]+\.\w+:\d+:\d+\)/.test(t)) {
      const m = t.match(/\bat\s+[^\s]+ \([-\\\w./]+\.\w+:\d+:\d+\)/);
      facts.push({ type: "stack", line: idx, anchor: (m ? m[0] : t).slice(0, 80) });
      stackSeen = true;
    }
  }
  return facts;
}

/**
 * Verify that every critical diagnostic fact in `rawText` survives in
 * `compressedText`. Returns:
 *   { gate: "not_applicable" | "pass" | "fail", facts, missing }
 * where `missing` is the subset of `facts` whose anchor is absent from the
 * (normalized) compressed text. `not_applicable` means no critical facts were
 * present in the source — the caller may proceed unchanged.
 */
function verifyDiagnosticFidelity(rawText, compressedText) {
  const facts = extractCriticalDiagnosticFacts(rawText);
  if (facts.length === 0) {
    return { gate: "not_applicable", facts: [], missing: [] };
  }
  const comp = normalizeText(compressedText);
  const missing = [];
  for (const f of facts) {
    let probe = normalizeText(f.anchor);
    if (probe.length > 50) probe = probe.slice(0, 50);
    if (!probe || !comp.includes(probe)) {
      missing.push(f);
    }
  }
  return { gate: missing.length === 0 ? "pass" : "fail", facts, missing };
}

module.exports = {
  FACT_TYPES,
  extractCriticalDiagnosticFacts,
  verifyDiagnosticFidelity,
};