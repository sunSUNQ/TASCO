"use strict";

// ============================================================================
// post_tool/failure_carrier.js — P1-S2a Carrier-Aware Diagnostic Eligibility
// ============================================================================
// Pure-function implementation of the consumption rules frozen in
// docs/architecture/FAILURE-CARRIER-CONTRACT-V1.md (P1-S1, commit cf67057).
//
// A shell output carrying the [TASCO_FAILURE_CARRIER] marker is governed by
// the carrier contract, not by prompt heuristics:
//
//   valid carrier AND original_exit_code != 0 -> deterministic Diagnostic
//     candidate (failure carrier positive zone), independent of prompt
//     wording.
//
//   malformed marker / unsupported version / missing original_command /
//   missing or unparseable original_exit_code / original_exit_code == 0 /
//   non-enum failure_kind / truncated state not explicit / truncated=true
//   without an audit note / missing transport / non-separable stdout-stderr
//   blocks -> invalid carrier. Failure semantics never come from the wrapper
//   process exit code (always 0) - only from original_exit_code.
//
// The carrier process exit code (always 0) is a transport-layer signal; the
// semantic layer signal is original_exit_code. No I/O in this module.
// ============================================================================

const CARRIER_PREFIX = "[TASCO_FAILURE_CARRIER";
const CARRIER_MARKER = "[TASCO_FAILURE_CARRIER]";
const STDOUT_BLOCK = "[TASCO_FAILURE_CARRIER_STDOUT]";
const STDERR_BLOCK = "[TASCO_FAILURE_CARRIER_STDERR]";
const END_BLOCK = "[TASCO_FAILURE_CARRIER_END]";
const SUPPORTED_VERSION = 1;

const FAILURE_KINDS = new Set([
  "test_failure",
  "command_failure",
  "timeout",
  "interrupt",
  "unknown",
]);

// Contract field set. stdout_chars / stderr_chars are emitter audit fields
// (present in the qualified A2 emitter); truncation_note is the explicit
// truncation boundary required when truncated=true.
const FIELD_KEYS = new Set([
  "carrier_version",
  "original_command",
  "original_exit_code",
  "failure_kind",
  "truncated",
  "transport",
  "stdout_chars",
  "stderr_chars",
  "truncation_note",
]);

const NOT_PRESENT = Object.freeze({
  present: false,
  valid: false,
  reason: null,
  fields: {},
  stdout: null,
  stderr: null,
});

function parseIntStrict(value) {
  const s = String(value === undefined || value === null ? "" : value).trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

// key=value token parser for the marker header line (whitespace-separated
// tokens; values must not contain spaces on this line).
function parseHeaderTokens(headerRest) {
  const fields = {};
  for (const token of String(headerRest || "").trim().split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    if (!FIELD_KEYS.has(key)) continue;
    if (!(key in fields)) fields[key] = token.slice(eq + 1);
  }
  return fields;
}

// key=value line parser for the field block between marker and stdout block
// (value = everything after the first '=', spaces allowed).
function parseFieldLine(line) {
  const eq = line.indexOf("=");
  if (eq <= 0) return null;
  const key = line.slice(0, eq).trim();
  if (!FIELD_KEYS.has(key)) return null;
  return { key, value: line.slice(eq + 1) };
}

/**
 * Parse a shell tool output into carrier form. Deterministic; no I/O.
 * Returns { present, valid, reason, fields, stdout, stderr } where
 * fields carries the contract values (strings) when discoverable.
 */
function parseFailureCarrier(text) {
  const raw = String(text === undefined || text === null ? "" : text);
  const lines = raw.split(/\r?\n/);
  const present = lines.some((l) => l.trimStart().startsWith(CARRIER_PREFIX));
  if (!present) return { ...NOT_PRESENT };

  const invalid = (reason, fields = {}, stdout = null, stderr = null) => ({
    present: true,
    valid: false,
    reason,
    fields,
    stdout,
    stderr,
  });

  // Marker line: must exist in the exact canonical form.
  const markerIdx = lines.findIndex((l) => l.trimStart().startsWith(CARRIER_MARKER));
  if (markerIdx === -1) return invalid("malformed_marker");

  const fields = parseHeaderTokens(lines[markerIdx].trimStart().slice(CARRIER_MARKER.length));

  // Block structure: STDOUT -> STDERR -> END, each exactly once, after the
  // marker line, in order (stdout/stderr strictly separable per contract).
  const countBlock = (marker) =>
    lines.reduce((n, l) => (l.trim() === marker ? n + 1 : n), 0);
  const findBlockAfter = (marker, from) => {
    for (let i = from; i < lines.length; i++) {
      if (lines[i].trim() === marker) return i;
    }
    return -1;
  };
  const stdoutIdx = findBlockAfter(STDOUT_BLOCK, markerIdx + 1);
  const stderrIdx = stdoutIdx === -1 ? -1 : findBlockAfter(STDERR_BLOCK, stdoutIdx + 1);
  const endIdx = stderrIdx === -1 ? -1 : findBlockAfter(END_BLOCK, stderrIdx + 1);
  if (stdoutIdx === -1 || stderrIdx === -1 || endIdx === -1) {
    return invalid("blocks_missing", fields);
  }
  if (
    countBlock(STDOUT_BLOCK) !== 1 ||
    countBlock(STDERR_BLOCK) !== 1 ||
    countBlock(END_BLOCK) !== 1
  ) {
    return invalid("blocks_duplicated", fields);
  }
  if (endIdx < stderrIdx || stderrIdx < stdoutIdx) {
    return invalid("blocks_disordered", fields);
  }

  // Field lines between marker and stdout block.
  for (let i = markerIdx + 1; i < stdoutIdx; i++) {
    const parsed = parseFieldLine(lines[i]);
    if (parsed && !(parsed.key in fields)) fields[parsed.key] = parsed.value;
  }

  const stdout = lines.slice(stdoutIdx + 1, stderrIdx).join("\n");
  const stderr = lines.slice(stderrIdx + 1, endIdx).join("\n");

  // ---- Contract validation chain (first failure wins; deterministic). ----
  const version = parseIntStrict(fields.carrier_version);
  if (version === null) return invalid("version_missing_or_unparseable", fields, stdout, stderr);
  if (version !== SUPPORTED_VERSION) return invalid("version_unsupported", fields, stdout, stderr);

  const command = String(fields.original_command === undefined ? "" : fields.original_command).trim();
  if (!command) return invalid("command_missing", fields, stdout, stderr);

  const exitCode = parseIntStrict(fields.original_exit_code);
  if (exitCode === null) return invalid("exit_code_missing_or_unparseable", fields, stdout, stderr);

  const kind = String(fields.failure_kind === undefined ? "" : fields.failure_kind).trim();
  if (!FAILURE_KINDS.has(kind)) return invalid("failure_kind_invalid", fields, stdout, stderr);

  const truncatedRaw = String(fields.truncated === undefined ? "" : fields.truncated).trim();
  if (truncatedRaw !== "true" && truncatedRaw !== "false") {
    return invalid("truncated_not_explicit", fields, stdout, stderr);
  }
  const truncated = truncatedRaw === "true";
  const truncationNote = String(fields.truncation_note === undefined ? "" : fields.truncation_note).trim();
  // Contract §1: truncated=true must carry the truncation quantity/boundary
  // (explicit and auditable). A bare truncated=true is semantically
  // incomplete -> invalid (Native; never guessed).
  if (truncated && !truncationNote) {
    return invalid("truncation_not_auditable", fields, stdout, stderr);
  }

  const transport = String(fields.transport === undefined ? "" : fields.transport).trim();
  if (!transport) return invalid("transport_missing", fields, stdout, stderr);

  return {
    present: true,
    valid: true,
    reason: null,
    fields: {
      carrier_version: String(version),
      original_command: command,
      original_exit_code: String(exitCode),
      failure_kind: kind,
      truncated: truncatedRaw,
      transport,
      ...(fields.stdout_chars !== undefined ? { stdout_chars: fields.stdout_chars } : {}),
      ...(fields.stderr_chars !== undefined ? { stderr_chars: fields.stderr_chars } : {}),
      ...(truncationNote ? { truncation_note: truncationNote } : {}),
    },
    original_exit_code: exitCode,
    stdout,
    stderr,
  };
}

/**
 * Frozen consumption rule (Contract V1 §2): a valid carrier with a real
 * nonzero original_exit_code is a deterministic Diagnostic candidate.
 */
function isDiagnosticEligibleFailureCarrier(parsed) {
  return Boolean(
    parsed &&
      parsed.valid === true &&
      typeof parsed.original_exit_code === "number" &&
      parsed.original_exit_code !== 0
  );
}

module.exports = {
  CARRIER_MARKER,
  SUPPORTED_VERSION,
  parseFailureCarrier,
  isDiagnosticEligibleFailureCarrier,
};
