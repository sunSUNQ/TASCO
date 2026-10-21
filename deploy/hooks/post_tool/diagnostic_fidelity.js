// ============================================================================
// diagnostic_fidelity.js — Model-visible diagnostic fidelity gate (P0 R2)
// ============================================================================
// Three-state diagnostic-risk classification. Guards the "quick_shell" delivery
// path (error-focused shell summaries). Principle: diagnostic fidelity > token
// savings. Fail-closed on doubt.
//
//   NO_DIAGNOSTIC_RISK      — no failure signal, or only benign mentions
//                             ("0 errors", "no error", "error handling",
//                             successful build). Normal compression may run.
//   DIAGNOSTIC_FACTS_IDENTIFIED — critical facts were mechanically extracted;
//                             every fact's anchor MUST survive compression,
//                             else reject.
//   DIAGNOSTIC_UNCERTAIN    — a failure signal exists but key facts cannot be
//                             fully/reliably parsed → MUST fall back to native.
//
// "No specific fact recognized" is NOT equivalent to NO_DIAGNOSTIC_RISK.
// ============================================================================

"use strict";

const STATE = Object.freeze({
  NO_DIAGNOSTIC_RISK: "no_risk",
  DIAGNOSTIC_FACTS_IDENTIFIED: "facts_identified",
  DIAGNOSTIC_UNCERTAIN: "uncertain",
});

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Strong failure signals (high precision: real diagnostics, not prose).
// Count patterns deliberately exclude zero so "0 failed"/"0 errors" success
// summaries never count as a failure signal.
// ---------------------------------------------------------------------------
const STRONG_FAILURE_SIGNALS = [
  /---\s*FAIL\b/i, // go test failure headline
  /(?:^|\n)\s*FAIL\s*(?:\n|$)/i, // go/java/cargo bare "FAIL" summary
  /\bFAILED\b/, // cargo/pytest "FAILED" (case-sensitive: NOT "N failed" counts)
  /Exception in thread/i, // java
  /\bCaused by\b/i, // java cause chain
  /panicked at/i, // rust panic
  /^\s*Traceback\b/m, // python traceback
  /\bAssertionError\b/i, // assertion failure
  /^not ok\s+\d+\b/m, // TAP assertion
  /^#\s*(?:fail|failed)\s*[1-9]\d*\b/m, // TAP "# fail N" (non-zero)
  /\b[1-9]\d*\s+(?:fail(?:ed|ures?)?|errors?)\b/i, // "26 failed" / "1 error"
  /\b[1-9]\d*\s*\/\s*\d+\s+(?:\w+\s+)?failed\b/i, // "30/30 requests failed"
  /root[- ]cause/i,
  /\bfatal\b/i,
  /(?:Exception|Error)\s*[:：]\s*\S/i, // "Exception: …" / "Error: …"
];

// Broad failure-ish word (lower precision; used only to distinguish benign
// mention from real failure once no strong signal matched).
const FAILURE_WORD = /\b(?:error|errors|fail\w*|exception(?:s)?|panic\w*|fatal|traceback|assertion\w*)\b/i;

// Benign failure-word contexts (NOT a real diagnostic).
const BENIGN_FAILURE_CONTEXT = [
  /\b(?:0|zero|no|none|without)\s+(?:errors?|failures?|failed|exceptions?)\b/i,
  /\b(?:error|exception)\s+(?:handling|code|type|class|messages?|templates?|cases?|paths?|propagation|boundary|rate)\b/i,
];

// ---------------------------------------------------------------------------
// Source-location extraction (path/line). Returns basename:line anchors so an
// absolute-vs-relative path rewrite in the summary does not cause a false miss.
// ---------------------------------------------------------------------------
function extractLocations(text) {
  const locs = [];
  const seen = new Set();
  const core = /([^\s:()]+)\.(\w{1,6}):(\d+)(?::\d+)?/g;
  let m;
  while ((m = core.exec(text)) !== null) {
    const file = m[1] + "." + m[2];
    const line = m[3];
    const basename = String(file).split(/[\\/]/).pop() || file;
    const anchor = `${basename}:${line}`;
    const key = anchor.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      locs.push({ type: "location", anchor, line: Number(line), full: m[0].trim() });
    }
  }
  // Python: File "x.py", line N
  const py = /File\s+["']([^"']+)["']\s*,\s*line\s+(\d+)/gi;
  while ((m = py.exec(text)) !== null) {
    const basename = String(m[1]).split(/[\\/]/).pop() || m[1];
    const anchor = `${basename}:${m[2]}`;
    const key = anchor.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      locs.push({ type: "location", anchor, line: Number(m[2]), full: m[0].trim() });
    }
  }
  return locs;
}

function extractCriticalDiagnosticFacts(text) {
  const lines = String(text || "").split(/\r?\n/);
  const facts = [];
  let notOkSeen = false;

  const countRe = [
    /#\s*(?:fail|failed)\s*(\d+)/i,
    /\b(\d+)\s*\/\s*(\d+)\s+(?:\w+\s+)?failed\b/i,
    /\b(\d+)\s+(?:fail(?:ed|ures?)?|errors?)\b/i,
  ];
  const markerRe = [
    /---\s*FAIL:\s*([^\n]*)/i,
    /Exception in thread[^\n]*/i,
    /Caused by:\s*([^\n]*)/i,
    /panicked at[^\n]*/i,
    /\bAssertionError[^\n]*/i,
    /^\s*Traceback\b[^\n]*/i,
    /\bFAILED\b[^\n]*/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;
    const idx = i + 1;

    if (/root[- ]cause/i.test(t)) {
      const m = t.match(/root[- ]cause[^\n]*/i);
      facts.push({ type: "root_cause", line: idx, anchor: (m ? m[0] : t).slice(0, 60) });
      continue;
    }
    if (/\bfatal\b/i.test(t)) {
      const m = t.match(/fatal[^\n]*/i);
      facts.push({ type: "fatal", line: idx, anchor: (m ? m[0] : t).slice(0, 60) });
      continue;
    }
    let counted = false;
    for (const re of countRe) {
      const m = t.match(re);
      if (m) {
        facts.push({ type: "failure_count", line: idx, anchor: m[0].slice(0, 60) });
        counted = true;
        break;
      }
    }
    if (counted) continue;
    for (const re of markerRe) {
      const m = t.match(re);
      if (m) {
        facts.push({ type: "failure_marker", line: idx, anchor: m[0].slice(0, 60) });
        counted = true;
        break;
      }
    }
    if (counted) continue;
    if (!notOkSeen && /^not ok\s+\d+\b/i.test(t)) {
      const m = t.match(/not ok\s+\d+[^\n]*/i);
      facts.push({ type: "not_ok", line: idx, anchor: (m ? m[0] : t).slice(0, 60) });
      notOkSeen = true;
    }
  }

  // Location facts: first N distinct basename:line anchors (representative set;
  // every one must survive compression).
  for (const loc of extractLocations(text).slice(0, 4)) {
    facts.push(loc);
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Classification + verification
// ---------------------------------------------------------------------------
function isBenignFailure(text) {
  const lines = String(text || "").split(/\r?\n/);
  let failureLines = 0;
  let benignLines = 0;
  for (const line of lines) {
    if (!FAILURE_WORD.test(line)) continue;
    failureLines += 1;
    if (BENIGN_FAILURE_CONTEXT.some((re) => re.test(line))) benignLines += 1;
  }
  return failureLines > 0 && benignLines === failureLines;
}

function classifyDiagnostic(text) {
  const t = String(text || "");
  if (STRONG_FAILURE_SIGNALS.some((re) => re.test(t))) {
    const facts = extractCriticalDiagnosticFacts(t);
    return facts.length > 0
      ? { state: STATE.DIAGNOSTIC_FACTS_IDENTIFIED, facts }
      : { state: STATE.DIAGNOSTIC_UNCERTAIN, facts: [] };
  }
  if (!FAILURE_WORD.test(t)) return { state: STATE.NO_DIAGNOSTIC_RISK, facts: [] };
  if (isBenignFailure(t)) return { state: STATE.NO_DIAGNOSTIC_RISK, facts: [] };
  return { state: STATE.DIAGNOSTIC_UNCERTAIN, facts: [] };
}

function verifyDiagnosticFidelity(rawText, compressedText) {
  const cls = classifyDiagnostic(rawText);
  if (cls.state === STATE.NO_DIAGNOSTIC_RISK) {
    return { state: cls.state, gate: "no_risk", verdict: "no_risk", facts: [], missing: [] };
  }
  if (cls.state === STATE.DIAGNOSTIC_UNCERTAIN) {
    return { state: cls.state, gate: "fail", verdict: "uncertain", facts: [], missing: [] };
  }
  const comp = normalizeText(compressedText);
  const missing = [];
  for (const f of cls.facts) {
    let probe = normalizeText(f.anchor);
    if (probe.length > 50) probe = probe.slice(0, 50);
    if (!probe || !comp.includes(probe)) missing.push(f);
  }
  const gate = missing.length === 0 ? "pass" : "fail";
  return { state: cls.state, gate, verdict: missing.length === 0 ? "pass" : "facts_missing", facts: cls.facts, missing };
}

module.exports = {
  STATE,
  normalizeText,
  extractLocations,
  extractCriticalDiagnosticFacts,
  classifyDiagnostic,
  verifyDiagnosticFidelity,
  STRONG_FAILURE_SIGNALS,
  FAILURE_WORD,
  BENIGN_FAILURE_CONTEXT,
};