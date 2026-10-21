"use strict";

// V1-D1 Test/Build Structured Extraction (frozen definition:
// docs/architecture/V1-D1-PRIMITIVE-DEFINITION-V1.md).
//
// Pre-arbitration INPUT NORMALIZATION for the quick_shell winner path.
// NOT a fifth winner: the folded text is only ever consumed inside an existing
// winner branch (quick_shell generic diagnostic); if arbitration stays Native
// the folded payload is never delivered (raw output continues unchanged).
// Fail-open: any anomaly -> { eligible:false } and raw output continues.
//
// D1a scope: exactly three mechanical patterns, zero semantic judgment:
//   P1  consecutive stack frames from the same file (>=3) -> keep 2 + count line
//   P2  consecutive identical-signature Error lines (>=3) -> keep 1 + count line
//   P3  consecutive exact-duplicate boilerplate lines (>=3) -> keep 1 + count line
// Retention contract (definition §6): every `not ok` line, every first `Error:`
// line, and every assertion line (expected/actual) must survive verbatim in the
// folded text; mechanical self-check, failure -> ineligible.

const { parseFailureCarrier } = require("./failure_carrier");

const MIN_BYTES = 2000;
const MIN_SAVING = 0.3;

const STACK_FRAME_MATCH = /at\s+.+?\((.+?):\d+:\d+\)/g; // D0-frozen (text-level, unanchored)
const STACK_RE = /^\s*at\s+.+?\((.+?):(\d+):(\d+)\)\s*$/; // P1 consecutive-run detector (line-level)
const SIG_MATCH = /^([A-Za-z]*Error):[ \t]*(.{0,60})/gm; // D0-frozen
const LINT_MATCH = /^\s*(?:\d+:\d+)?\s*(error|warning)\s+['"]?([\w@/-]+)/gm; // D0-frozen
const SIG_RE = /^([A-Za-z]*Error):[ \t]*(.*)$/;
const NOTOK_RE = /^not ok \d+\s*-\s*/;
const KEY_LINE_RE = /^not ok \d+|^ok \d+|^\s*(?:expected|actual|assert|Error:)/i;
const CMD_RE = /\b(node --test|vitest|jest|mocha|tap|tsc|typecheck|eslint|lint|coverage|benchmark)|\b(test|tests|build|check)\b/i; // D0-frozen

function isTestBuildText(text) {
  return /\bnot ok \d+|\bTests?:\s*\d+|#\s*(pass|fail|tests)\s+\d+|error TS\d+|AssertionError|coverage summary|All files\s*\|/i.test(text);
}

// D0-frozen event gate: command OR output features (identical to
// v1d0_test_build_audit.js isTestBuild)
function isTestBuildEvent(cmd, text) {
  return (cmd && CMD_RE.test(cmd)) || isTestBuildText(text);
}

// D0 frozen fold-estimate algorithm (v1d0_test_build_audit.js foldEstimate):
// potential lower bound of repeated-structure collapse. Used for the eligibility
// gate exactly as pre-registered in V1-D1 definition §2.
function estimateSaving(lines, rawText) {
  const frameGroups = {};
  const sigGroups = {};
  const lintGroups = {};
  for (const m of rawText.matchAll(STACK_FRAME_MATCH)) frameGroups[m[1]] = (frameGroups[m[1]] || 0) + 1;
  for (const m of rawText.matchAll(SIG_MATCH)) {
    const sig = m[1] + ":" + m[2].replace(/\d+/g, "#").replace(/[\s\\/"']+/g, "_").slice(0, 40);
    sigGroups[sig] = (sigGroups[sig] || 0) + 1;
  }
  for (const m of rawText.matchAll(LINT_MATCH)) lintGroups[m[2]] = (lintGroups[m[2]] || 0) + 1;
  let foldable = 0;
  for (const n of Object.values(frameGroups)) if (n >= 3) foldable += n - 1;
  for (const n of Object.values(sigGroups)) if (n >= 3) foldable += n - 1;
  for (const n of Object.values(lintGroups)) if (n >= 5) foldable += Math.max(0, n - 3);
  const notOkIdx = lines.map((l, i) => (l.startsWith("not ok ") ? i : -1)).filter((i) => i >= 0);
  for (let k = 1; k < notOkIdx.length; k++) foldable += Math.max(0, notOkIdx[k] - notOkIdx[k - 1] - 1 - 2);
  // V1-D1 §4 P3 dimension (consecutive exact-duplicate lines): D0 estimator did
  // not carry this pattern (D0 morphology had no boilerplate-dup class); added
  // here as the estimate counterpart of frozen pattern P3. Same lines x avgLine basis.
  let dupRun = [];
  let dupText = null;
  for (const line of lines) {
    if (KEY_LINE_RE.test(line)) { if (dupRun.length >= 3) foldable += dupRun.length - 1; dupRun = []; dupText = null; continue; }
    if (line === dupText) dupRun.push(line);
    else { if (dupRun.length >= 3) foldable += dupRun.length - 1; dupText = line; dupRun = [line]; }
  }
  if (dupRun.length >= 3) foldable += dupRun.length - 1;
  const avgLine = Buffer.byteLength(rawText, "utf8") / Math.max(lines.length, 1);
  const saving = Math.min(0.6, (foldable * avgLine) / Math.max(Buffer.byteLength(rawText, "utf8"), 1));
  return { saving: +saving.toFixed(3), foldable_lines: foldable };
}

function extractStructured(rawText, command, opts = {}) {
  const result = {
    eligible: false,
    reason: null,
    morphology: [],
    families: [],
    stats: null,
    structuredText: rawText,
    retentionCheck: null,
  };
  try {
    // MIN_BYTES applies to the raw unit the winner consumes. Carrier bodies
    // are sub-units of an already-gated report (V1-D2 W1: the report-level
    // gate runs in extractStructuredFromCarrier), so the carrier entry may
    // skip this per-body floor.
    if (!(opts && opts.skipMinBytes) && (typeof rawText !== "string" || Buffer.byteLength(rawText, "utf8") < MIN_BYTES)) {
      result.reason = "below_min_bytes";
      return result;
    }
    if (!isTestBuildEvent(command, rawText)) {
      result.reason = "not_test_build_output";
      return result;
    }

    const lines = rawText.split(/\r?\n/);
    const eol = rawText.includes("\r\n") ? "\r\n" : "\n";
    const drop = new Map(); // line index -> { pattern, group }

    // P1: same-file stack frames (global grouping per frozen definition SS4 —
    // same signature, instances 2..n): keep first 2 occurrences, drop the rest
    const frameSeen = new Map();
    for (let i = 0; i < lines.length; i++) {
      const m = STACK_RE.exec(lines[i]);
      if (!m) continue;
      const n = frameSeen.get(m[1]) || 0;
      frameSeen.set(m[1], n + 1);
      if (n >= 2) drop.set(i, { pattern: "P1", group: m[1] });
    }
    for (const [sig, n] of frameSeen) {
      if (n > 1) {
        result.morphology.push("T3_repeated_stack_traces");
        result.families.push({ kind: "stack_frame_by_file", signature: sig, count: n });
      }
    }

    // P2: identical-signature Error lines (global grouping): keep first, drop rest
    const sigSeen = new Map();
    for (let i = 0; i < lines.length; i++) {
      const m = SIG_RE.exec(lines[i]);
      if (!m) continue;
      const sig = m[1] + ":" + m[2].replace(/\d+/g, "#").replace(/\s+/g, "_").slice(0, 40);
      const n = sigSeen.get(sig) || 0;
      sigSeen.set(sig, n + 1);
      if (n >= 1) drop.set(i, { pattern: "P2", group: sig });
    }
    for (const [sig, n] of sigSeen) {
      if (n > 1) {
        result.morphology.push("T4_error_signature_family");
        result.families.push({ kind: "error_signature", signature: sig, count: n });
      }
    }

    // P3: consecutive exact-duplicate boilerplate lines (>=3) -> keep first
    let run = [];
    let runText = null;
    const flushP3 = () => {
      if (run.length >= 3) {
        for (let k = 1; k < run.length; k++) drop.set(run[k].idx, { pattern: "P3", group: runText });
        result.morphology.push("T2_repeated_boilerplate");
        result.families.push({ kind: "exact_duplicate_lines", signature: runText.slice(0, 80), count: run.length });
      }
      run = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (KEY_LINE_RE.test(line)) { flushP3(); runText = null; continue; }
      if (line === runText) run.push({ idx: i, line });
      else { flushP3(); runText = line; run = [{ idx: i, line }]; }
    }
    flushP3();

    // P5: lint rule violation aggregation (D0 estimator T6 dimension): per
    // rule, keep first 3 violations (file:line positions), drop the rest; the
    // rule header count lives in telemetry families.
    const lintSeenRows = new Map(); // rule -> [lineIdx]
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(?:\d+:\d+)?\s*(error|warning)\s+['"]?([\w@/-]+)/.exec(lines[i]);
      if (!m) continue;
      if (!lintSeenRows.has(m[2])) lintSeenRows.set(m[2], []);
      lintSeenRows.get(m[2]).push(i);
    }
    for (const [rule, idxs] of lintSeenRows) {
      if (idxs.length >= 5) {
        for (let k = 3; k < idxs.length; k++) drop.set(idxs[k], { pattern: "P5", group: rule });
        result.morphology.push("T6_lint_rule_violations");
        result.families.push({ kind: "lint_rule", signature: rule, count: idxs.length });
      }
    }

    // P4: failure-group boilerplate between consecutive `not ok` lines —
    // keep each gap's first 2 non-key lines + ALL key (assertion) lines, drop
    // the remaining boilerplate (stack frames / blank lines). D0 estimator's
    // T2-gap dimension corresponds to this pattern.
    const notOkIdx = lines.map((l, i) => (l.startsWith("not ok ") ? i : -1)).filter((i) => i >= 0);
    let p4Drops = 0;
    for (let k = 1; k < notOkIdx.length; k++) {
      const gapStart = notOkIdx[k - 1] + 1;
      const gapEnd = notOkIdx[k] - 1;
      const gapLen = gapEnd - gapStart + 1;
      if (gapLen <= 2) continue;
      let keptNonKey = 0;
      for (let i = gapStart; i <= gapEnd; i++) {
        if (KEY_LINE_RE.test(lines[i])) continue;
        if (drop.has(i)) continue; // already folded by P1/P2/P3
        if (keptNonKey < 2) { keptNonKey++; continue; }
        drop.set(i, { pattern: "P4", group: "gap" + k });
        p4Drops++;
      }
    }
    if (p4Drops > 0) result.morphology.push("T2_failed_test_groups");

    if (!drop.size) {
      result.reason = "no_repeat_structure";
      return result;
    }

    // eligibility gate per frozen definition §2: D0 fold ESTIMATE (potential
    // lower bound) >= 0.3 — not the actual delivered saving (estimate is the
    // pre-registered D0 estimator; actual saving is recorded for telemetry).
    const estimate = estimateSaving(lines, rawText);

    // build folded text: pure deletion of dropped lines; the line immediately
    // BEFORE each maximal deleted run gets a short inline marker (non-key lines
    // only) so the model knows a collapse happened without paying long markers.
    const outLines = [];
    let foldedCount = 0;
    let i = 0;
    while (i < lines.length) {
      if (drop.has(i)) {
        const info = drop.get(i);
        const run2 = [i];
        let j = i + 1;
        while (j < lines.length && drop.get(j) && drop.get(j).pattern === info.pattern && drop.get(j).group === info.group) {
          run2.push(j);
          j++;
        }
        foldedCount += run2.length;
        if (outLines.length && !KEY_LINE_RE.test(outLines[outLines.length - 1]) && !outLines[outLines.length - 1].endsWith("[+folded]")) {
          outLines[outLines.length - 1] += ` [+${run2.length} folded]`;
        }
        i = j;
      } else {
        outLines.push(lines[i]);
        i++;
      }
    }

    const structuredText = outLines.join(eol);
    // retention contract (definition §6): every key line must survive verbatim
    const kept = new Set(structuredText.split(/\r?\n/));
    const missing = [];
    for (const line of lines) {
      if (KEY_LINE_RE.test(line) && !kept.has(line)) missing.push(line.slice(0, 120));
    }
    result.retentionCheck = { pass: missing.length === 0, missing: missing.slice(0, 5), retained_evidence_count: lines.length - foldedCount };
    if (result.retentionCheck.pass === false) {
      result.reason = "retention_check_failed";
      result.structuredText = rawText;
      return result;
    }

    const rawBytes = Buffer.byteLength(rawText, "utf8");
    const foldedBytes = Buffer.byteLength(structuredText, "utf8");
    const saving = 1 - foldedBytes / rawBytes;
    result.stats = {
      raw_bytes: rawBytes,
      folded_bytes: foldedBytes,
      saving: +saving.toFixed(3),
      estimated_saving: estimate.saving,
      fold_count: foldedCount,
      retained_evidence_count: result.retentionCheck.retained_evidence_count,
    };
    if (estimate.saving < MIN_SAVING) {
      result.reason = "saving_below_threshold";
      result.structuredText = rawText;
      return result;
    }
    result.eligible = true;
    result.reason = "ok";
    result.structuredText = structuredText;
    return result;
  } catch (_e) {
    result.eligible = false;
    result.reason = "extractor_exception";
    result.structuredText = rawText;
    return result;
  }
}

// pre-arbitration input normalization for an existing winner branch.
// returns null when not applicable (caller delivers raw text unchanged).
function maybeNormalize(rawText) {
  const r = extractStructured(rawText);
  if (!r.eligible) return null;
  return r;
}

// ---------------------------------------------------------------------------
// V1-D2 W1: carrier-envelope aware entry (prereg
// evidence/V1/V1-D2-WIRING-EXPOSURE-PLAN-V1.md, frozen).
// Parses the [TASCO_FAILURE_CARRIER] envelope with the frozen
// failure_carrier.js parser, runs the SAME P1-P5 extractor on the raw
// stdout/stderr bodies independently, and rebuilds the report with every
// envelope contract line preserved verbatim. The folded text is still only
// ever consumed by an existing winner branch (carrier/diagnostic delivery);
// this is NOT a fifth winner. Fail-open: malformed envelope or any exception
// -> eligible:false and the raw report continues unchanged.
const CARRIER_PREFIX = "[TASCO_FAILURE_CARRIER";
const CARRIER_MARKER = "[TASCO_FAILURE_CARRIER]";
const STDOUT_BLOCK = "[TASCO_FAILURE_CARRIER_STDOUT]";
const STDERR_BLOCK = "[TASCO_FAILURE_CARRIER_STDERR]";
const END_BLOCK = "[TASCO_FAILURE_CARRIER_END]";

function extractStructuredFromCarrier(reportText, command) {
  const result = {
    eligible: false,
    reason: null,
    morphology: [],
    families: [],
    stats: null,
    structuredText: reportText,
    retentionCheck: null,
    carrier: { present: false, valid: false, reason: null },
    wiring_path: "carrier_diagnostic",
  };
  try {
    if (typeof reportText !== "string" || reportText.indexOf(CARRIER_PREFIX) === -1) {
      result.reason = "carrier_absent";
      return result;
    }
    const carrier = parseFailureCarrier(reportText);
    result.carrier = { present: carrier.present, valid: carrier.valid, reason: carrier.reason || null };
    if (!carrier.present) { result.reason = "carrier_absent"; return result; }
    if (!carrier.valid) { result.reason = "carrier_malformed"; return result; }

    const rawLines = reportText.split(/\r?\n/);
    const eol = reportText.includes("\r\n") ? "\r\n" : "\n";
    const findBlock = (marker, from) => {
      for (let i = from; i < rawLines.length; i++) if (rawLines[i].trim() === marker) return i;
      return -1;
    };
    const markerIdx = rawLines.findIndex((l) => l.trimStart().startsWith(CARRIER_MARKER));
    const stdoutIdx = markerIdx === -1 ? -1 : findBlock(STDOUT_BLOCK, markerIdx + 1);
    const stderrIdx = stdoutIdx === -1 ? -1 : findBlock(STDERR_BLOCK, stdoutIdx + 1);
    const endIdx = stderrIdx === -1 ? -1 : findBlock(END_BLOCK, stderrIdx + 1);
    if (markerIdx === -1 || stdoutIdx === -1 || stderrIdx === -1 || endIdx === -1) {
      result.reason = "carrier_malformed";
      return result;
    }

    // Same frozen extractor on each raw body; envelope original_command is the
    // agent-semantic command and takes precedence for the test/build gate.
    const bodyCommand = String((carrier.fields && carrier.fields.original_command) || command || "");
    if (Buffer.byteLength(reportText, "utf8") < MIN_BYTES) {
      result.reason = "below_min_bytes";
      return result;
    }
    const r1 = extractStructured(rawLines.slice(stdoutIdx + 1, stderrIdx).join("\n"), bodyCommand, { skipMinBytes: true });
    const r2 = extractStructured(rawLines.slice(stderrIdx + 1, endIdx).join("\n"), bodyCommand, { skipMinBytes: true });
    const folds = [r1.eligible ? r1 : null, r2.eligible ? r2 : null];
    if (!folds[0] && !folds[1]) {
      result.reason = (r1 && r1.reason) || "no_repeat_structure";
      result.retentionCheck = { pass: true, envelope_preserved: true, retained_evidence_count: 0 };
      return result;
    }

    const outLines = [];
    outLines.push(...rawLines.slice(0, stdoutIdx + 1));
    outLines.push(...(folds[0] ? folds[0].structuredText.split(/\r?\n/) : rawLines.slice(stdoutIdx + 1, stderrIdx)));
    outLines.push(...rawLines.slice(stderrIdx, stderrIdx + 1));
    outLines.push(...(folds[1] ? folds[1].structuredText.split(/\r?\n/) : rawLines.slice(stderrIdx + 1, endIdx)));
    outLines.push(...rawLines.slice(endIdx));
    const structuredText = outLines.join(eol);

    // mechanical self-check: every envelope line (marker, fields, block
    // markers, end, and anything outside the two bodies) survives verbatim.
    const kept = new Set(structuredText.split(/\r?\n/));
    const missingEnv = [];
    for (let i = 0; i < rawLines.length; i++) {
      if (i <= stdoutIdx || i === stderrIdx || i >= endIdx) {
        if (!kept.has(rawLines[i])) missingEnv.push(rawLines[i].slice(0, 120));
      }
    }
    const bodyChecks = [r1, r2].filter((r) => r.retentionCheck);
    const retentionFailed = bodyChecks.some((r) => r.retentionCheck && r.retentionCheck.pass === false);
    result.retentionCheck = {
      pass: missingEnv.length === 0 && !retentionFailed,
      envelope_preserved: missingEnv.length === 0,
      missing: missingEnv.slice(0, 5),
      retained_evidence_count: bodyChecks.reduce((a, r) => a + (r.retentionCheck ? r.retentionCheck.retained_evidence_count : 0), 0),
    };
    if (result.retentionCheck.pass === false) {
      result.reason = "retention_check_failed";
      result.structuredText = reportText;
      return result;
    }

    const rawBytes = Buffer.byteLength(reportText, "utf8");
    const foldedBytes = Buffer.byteLength(structuredText, "utf8");
    const foldedBodies = folds.filter(Boolean);
    const bodiesFolded = [];
    if (folds[0]) bodiesFolded.push("stdout");
    if (folds[1]) bodiesFolded.push("stderr");
    result.stats = {
      raw_bytes: rawBytes,
      folded_bytes: foldedBytes,
      saving: +(1 - foldedBytes / rawBytes).toFixed(3),
      fold_count: foldedBodies.reduce((a, r) => a + r.stats.fold_count, 0),
      retained_evidence_count: result.retentionCheck.retained_evidence_count,
      bodies_folded: bodiesFolded,
    };
    result.morphology = [...new Set(foldedBodies.flatMap((r) => r.morphology))];
    result.families = foldedBodies.flatMap((r) => r.families);
    result.eligible = true;
    result.reason = "ok";
    result.structuredText = structuredText;
    return result;
  } catch (_e) {
    result.eligible = false;
    result.reason = "extractor_exception";
    result.structuredText = reportText;
    return result;
  }
}

module.exports = { extractStructured, extractStructuredFromCarrier, maybeNormalize, isTestBuildText, MIN_BYTES, MIN_SAVING };
