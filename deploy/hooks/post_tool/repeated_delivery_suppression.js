#!/usr/bin/env node
"use strict";
/*
 * V0.11-D3-E5 — Repeated Delivery Suppression (RDS) online primitive.
 * Contract: docs/architecture/V0.11-D3-E4-RDS-PROTOTYPE-PREREG-V1.md (FROZEN) +
 *           docs/architecture/V0.11-D3-E5-RDS-ONLINE-AB-PREREG-V1.md (FROZEN)
 * anchor-first / exact-only contiguous-segment folding / auditable recovery marker /
 * fail-closed on any inconsistency / per-session state via guard_core sessionPath.
 * Purely mechanical: no semantic summarization, no model calls, no dataset-specific rules.
 */
const fs = require("fs");
const path = require("path");
const { sessionPath } = require("../guard_core/runtime_paths");

const MIN_SEG_LINES = 2;
const STATE_FILE = "rds_state.json";
const LEDGER_FILE = "rds_ledger.ndjson";
const MARKER = (k, a, b, n, m) =>
  `[TASCO-RDS omitted: observation #${k} lines ${a}..${b} (${n} chars); new: ${m} chars]`;

function loadState() {
  try {
    const p = sessionPath(STATE_FILE);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_e) { /* fail-closed: fresh state */ }
  return { delivered_index: {}, obs_count: 0 };
}

function saveState(state) {
  try {
    const p = sessionPath(STATE_FILE);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state));
  } catch (_e) { /* fail-closed */ }
}

function appendLedger(row) {
  try {
    const p = sessionPath(LEDGER_FILE);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + "\n");
  } catch (_e) { /* fail-closed */ }
}

function normalize(t) { return (typeof t === "string" ? t : "").replace(/\r\n/g, "\n"); }

/**
 * Process one observation in trajectory order.
 * Returns {compressed, text, matched_chars, new_chars, anchor_seq, reason}
 * Always registers the observation lines as future anchors (even when native).
 * Fail-closed: any parse/accounting inconsistency -> native passthrough text.
 */
function process(obsRaw) {
  const state = loadState();
  const seq = state.obs_count + 1; // 1-based observation number
  const res = { compressed: false, text: obsRaw, matched_chars: 0, new_chars: 0, anchor_seq: 0, reason: "native", eligible: false };
  if (typeof obsRaw !== "string" || obsRaw.length === 0) {
    res.reason = "malformed_payload";
    appendLedger({ seq, eligible: false, compressed: false, reason: res.reason });
    state.obs_count = seq; saveState(state);
    return res;
  }
  const text = normalize(obsRaw);
  const lines = text.split("\n");
  const idx = state.delivered_index || {};
  const segments = []; // {type:'orig',i,j} | {type:'omit',src,a,b,i,j,chars}
  let i = 0, matched = 0, anchorSeq = 0;
  while (i < lines.length) {
    const hit = idx[lines[i]];
    if (!hit) {
      let j = i;
      while (j < lines.length && !idx[lines[j]]) j += 1;
      segments.push({ type: "orig", i, j });
      i = j;
      continue;
    }
    const srcSeq = hit[0], srcIdx = hit[1];
    let j = i;
    while (j < lines.length) {
      const h2 = idx[lines[j]];
      if (!h2 || h2[0] !== srcSeq || h2[1] !== srcIdx + (j - i)) break;
      j += 1;
    }
    if (j - i >= MIN_SEG_LINES && srcSeq < seq) {
      let chars = 0;
      for (let t = i; t < j; t++) chars += lines[t].length + 1;
      if (t_lastNoNewline(j - i, i, j, lines)) chars -= 1;
      segments.push({ type: "omit", src: srcSeq, a: srcIdx, b: srcIdx + (j - i) - 1, i, j, chars });
      matched += chars;
      if (!anchorSeq) anchorSeq = srcSeq;
      i = j;
    } else {
      let j2 = i + 1;
      segments.push({ type: "orig", i, j: j2 });
      i = j2;
    }
  }
  res.eligible = matched > 0;
  if (!res.eligible) {
    res.reason = "no_exact_overlap";
    register(state, seq, lines);
    appendLedger({ seq, eligible: false, compressed: false, reason: res.reason });
    saveState(state);
    return res;
  }
  const newChars = text.length - matched;
  if (matched + newChars !== text.length) {
    res.reason = "accounting_inconsistent";
    register(state, seq, lines);
    appendLedger({ seq, eligible: true, compressed: false, reason: res.reason });
    saveState(state);
    return res; // fail-closed
  }
  // render compressed text
  const parts = [];
  for (const s of segments) {
    if (s.type === "orig") parts.push(lines.slice(s.i, s.j).join("\n"));
    else parts.push(MARKER(s.src, s.a + 1, s.b + 1, s.chars, 0));
  }
  const markerLine = MARKER(anchorSeq,
    Math.min(...segments.filter(s => s.type === "omit").map(s => s.a + 1)),
    Math.max(...segments.filter(s => s.type === "omit").map(s => s.b + 1)),
    matched, newChars);
  const compressedText = parts.join("\n") + "\n" + markerLine;
  res.compressed = true; res.text = compressedText;
  res.matched_chars = matched; res.new_chars = newChars; res.anchor_seq = anchorSeq;
  res.reason = "repeated_delivery_suppressed";
  register(state, seq, lines);
  appendLedger({ seq, eligible: true, compressed: true, matched_chars: matched, new_chars: newChars, anchor_seq: anchorSeq });
  saveState(state);
  return res;
}

function t_lastNoNewline(runLen, i, j, lines) { return j === lines.length; } // last line of payload has no trailing newline
function register(state, seq, lines) {
  for (let k = 0; k < lines.length; k++) {
    if (!state.delivered_index[lines[k]]) state.delivered_index[lines[k]] = [seq, k];
  }
  state.obs_count = Math.max(state.obs_count || 0, seq);
}

module.exports = { process, loadState, saveState, appendLedger, MARKER };
