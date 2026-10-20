"use strict";

// ============================================================================
// carrier/failure_carrier_shim.js — P1-S2b Auto Failure Carrier execution shim
// ============================================================================
// Invoked as: node "<this file>" --orig "<base64url(original command)>"
//
// Executes the original command EXACTLY ONCE (no hidden rerun) and:
//   original exit 0   -> passthrough: original stdout -> stdout, original
//                        stderr -> stderr, exit 0. Success semantics are
//                        preserved for the frozen Terminal-State / Validation
//                        Delta chain (M3 protection).
//   original exit !=0 -> print the FAILURE-CARRIER-CONTRACT-V1 report on
//                        stdout and exit 0 (transport success) so the standard
//                        PostToolUse -> bridge -> Arbitration chain fires.
//                        Failure semantics are carried by original_exit_code;
//                        the wrapper process exit code is transport-only.
//
// The original command is replayed through bash (the shell Claude Code's Bash
// tool actually uses on Windows) with a deterministic resolution chain and a
// cmd.exe last-resort fallback. Shell-neutral: no .cmd dependency.
//
// Telemetry: one append-only row per invocation (carrier_shim.jsonl) is the
// single-execution evidence: one tool request => exactly one row.
// ============================================================================

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { classifyCommand } = require("../post_tool/terminal_state");

const CARRIER_VERSION = "1";
const TRANSPORT = "pre_tool_use_auto";

// The replay must be environment-clean with respect to test-runner context
// markers: if the shim itself runs inside a node:test hierarchy (e.g. the
// agent runs a test inside a test), an inherited NODE_TEST_CONTEXT makes the
// replayed `node --test` silently skip all files and exit 0 - a transparent
// execution would be violated. Strip runner-context markers; keep the rest.
function buildReplayEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function appendTelemetry(row) {
  try {
    const base = process.env.CODE_GUARD_BASE_DIR;
    if (!base) return;
    fs.mkdirSync(base, { recursive: true });
    fs.appendFileSync(
      path.join(base, "carrier_shim.jsonl"),
      JSON.stringify(row) + "\n",
      "utf8"
    );
  } catch (_e) {
    // fail-open: telemetry never alters delivery
  }
}

// Deterministic bash resolution for the replay leg. The Bash tool on Claude
// Code Windows runs Git Bash, so a bash executable exists wherever auto
// carrier is productively used.
function resolveBash() {
  const candidates = [
    process.env.TASCO_CARRIER_BASH,
    "bash.exe",
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const probe = cp.spawnSync(candidate, ["-c", "exit 0"], {
        timeout: 15000,
        windowsHide: true,
      });
      if (!probe.error && probe.status === 0) return candidate;
    } catch (_e) {
      // try next candidate
    }
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  let token = null;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--orig") token = argv[i + 1];
  }
  let originalCommand = null;
  try {
    originalCommand = token ? Buffer.from(token, "base64url").toString("utf8") : null;
  } catch (_e) {
    originalCommand = null;
  }
  if (!originalCommand || !originalCommand.trim()) {
    process.stderr.write(
      "[failure_carrier_shim] missing --orig token; original command unavailable\n"
    );
    process.exit(127);
  }

  const timeoutMs = Number(process.env.TASCO_CARRIER_TIMEOUT_MS || 900000);
  const bash = resolveBash();
  let res;
  let replayShell;
  if (bash) {
    replayShell = "bash";
    res = cp.spawnSync(bash, ["-c", originalCommand], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: buildReplayEnv(),
    });
  } else {
    // Last-resort fallback: eligibility already excludes shell metacharacters,
    // so simple command forms execute identically under cmd.exe.
    replayShell = "cmd";
    const comspec = process.env.comspec || "cmd.exe";
    res = cp.spawnSync(comspec, ["/d", "/s", "/c", originalCommand], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: buildReplayEnv(),
    });
  }

  const spawnError = res.error ? String(res.error && res.error.code ? res.error.code : res.error) : null;
  const timedOut = Boolean(res.error && res.error.code === "ETIMEDOUT");

  // Transport-level failure: the replay never started (no shell). Nothing was
  // executed, so no exit code can be preserved - fail loudly instead of
  // fabricating carrier semantics.
  if (res.error && !timedOut) {
    appendTelemetry({
      event: "failure_carrier_shim_execution",
      at: new Date().toISOString(),
      original_command: originalCommand,
      original_exit_code: null,
      spawn_error: spawnError,
      replay_shell: replayShell,
      transport: TRANSPORT,
    });
    process.stderr.write(`[failure_carrier_shim] replay failed: ${spawnError}\n`);
    process.exit(127);
  }

  const stdout = String(res.stdout || "");
  const stderr = String(res.stderr || "");
  const rc = res.status === null || res.status === undefined ? -1 : res.status;

  appendTelemetry({
    event: "failure_carrier_shim_execution",
    at: new Date().toISOString(),
    original_command: originalCommand,
    original_exit_code: rc,
    spawn_error: spawnError,
    replay_shell: replayShell,
    transport: TRANSPORT,
  });

  // Success passthrough: the model sees exactly what the original command
  // produced, byte-for-byte (M3 success chain untouched).
  if (rc === 0) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(0);
  }

  const kind =
    timedOut ? "timeout" : classifyCommand(originalCommand) === "test" ? "test_failure" : "command_failure";
  const truncated = timedOut;
  const reportLines = [
    `[TASCO_FAILURE_CARRIER] command failed carrier_version=${CARRIER_VERSION} transport=${TRANSPORT}`,
    `original_command=${originalCommand}`,
    `original_exit_code=${rc}`,
    `failure_kind=${kind}`,
    `truncated=${truncated ? "true" : "false"}`,
    ...(truncated
      ? [
          `truncation_note=original command killed by carrier timeout after ${timeoutMs}ms; real exit code unavailable`,
        ]
      : []),
    `stdout_chars=${stdout.length}`,
    `stderr_chars=${stderr.length}`,
    "[TASCO_FAILURE_CARRIER_STDOUT]",
    stdout.replace(/\s+$/, ""),
    "[TASCO_FAILURE_CARRIER_STDERR]",
    stderr.replace(/\s+$/, ""),
    "[TASCO_FAILURE_CARRIER_END]",
  ];

  process.stdout.write(reportLines.join("\n") + "\n");
  process.exit(0);
}

main();
