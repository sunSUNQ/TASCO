"use strict";

// Line-6 R1 (Local Target Read) qualification — two layers:
//
// Layer 1 (selection, primitive): the REAL frozen primitive
// extractiveReadSummary over the real fixture with TASK-DERIVED symbols —
// the task-driven selection contract: target function preserved verbatim,
// unrelated verbose helpers dropped, reduction, lexical fidelity.
//
// Layer 2 (transport, real chain): spawning the real post_tool_policy_hook
// with CODE_GUARD_EXTRACTIVE_READ=1 really delivers a model-visible
// replacement (transport leg). The SELECTION inside the chain currently
// sources symbols from session state (empty on first read) instead of the
// task text — recorded as the PENDING R1 wiring gap (post_tool_policy_hook
// read_file branch, knownSymbols source); not modified in this
// qualification (frozen hook discipline).
//
// Pairing gate: same files, different task semantics -> different strategy
// (wrong_strategy=0 at the mapping level).
//
// 运行：node --test deploy/hooks/post_tool/read_r1_qualification.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOOK = path.join(__dirname, "..", "post_tool_policy_hook.js");
const HOOK_DIR = path.join(__dirname, "..");
const { extractiveReadSummary } = require("../post_tool/summaries.js").createSummaries({});
const { classifyReadTask } = require("../pre_tool/read_strategy.js");
const { extractSymbols } = require("../pre_tool/search_guidance.js");

const R1_FILE = path.join(__dirname, "..", "..", "..", "compression_lab", "repo", "read_lab", "r1.js");
const rawSource = fs.readFileSync(R1_FILE, "utf8");
const rawLines = rawSource.split(/\r?\n/);
const rawSet = new Set(rawLines.map((l) => l.trim()));
const numbered = rawLines.map((l, i) => `${i + 1}: ${l}`).join("\n");
const readText = `<path>read_lab/r1.js</path>\n${numbered}\n`;

const TASK_PROMPT =
  "Read read_lab/r1.js and analyze parseConnectionString: what default port does it use for each scheme, and when is tls enabled? Do not modify code.";

function deliveredCodeLines(text) {
  return text.split(/\r?\n/).filter((l) => /^\s*\d+:\s/.test(l));
}

test("R1 selection: task-derived symbols drive target extraction (primitive contract)", () => {
  const symbols = extractSymbols(TASK_PROMPT);
  assert.ok(symbols.includes("parseConnectionString"), "task-derived symbol extracted");
  const delivered = extractiveReadSummary(readText, symbols);

  assert.ok(delivered.length < readText.length * 0.35, `reduction: ${delivered.length} < 35% of ${readText.length}`);
  assert.match(delivered, /parseConnectionString/, "target symbol preserved");
  assert.match(delivered, /443/, "ground truth: https default port");
  assert.match(delivered, /5432/, "ground truth: fallback port");
  assert.match(delivered, /tls: scheme === "https"/, "required local context preserved");

  // lexical fidelity: every delivered code line is a verbatim raw line
  const code = deliveredCodeLines(delivered);
  assert.ok(code.length > 0);
  for (const line of code) {
    const body = line.replace(/^\s*\d+:\s/, "").trim();
    if (body) assert.ok(rawSet.has(body), `fidelity broken: ${body.slice(0, 60)}`);
  }

  // unrelated verbose helpers dropped
  assert.ok(!/E_ASCII_\d+/.test(delivered), "unrelated helper boilerplate excluded");
});

test("R1 pairing: same file, different task semantics -> different strategy (wrong_strategy=0)", () => {
  const local = classifyReadTask("Read read_lab/r1.js and analyze parseConnectionString: what default port does it use for each scheme? Do not modify code.");
  assert.equal(local.task_class, "R1_local_target");
  assert.equal(local.strategy, "extractive_read");
  const chain = classifyReadTask("Read read_lab/r1.js and trace the caller/callee relationship: who calls parseConnectionString and where does the result propagate. Do not modify code.");
  assert.equal(chain.task_class, "R2_call_relation");
  assert.equal(chain.strategy, "relation_evidence");
  const doc = classifyReadTask("Read docs/api_v2.md and report the required header for creating a v2 order.");
  assert.equal(doc.task_class, "R5_section_read");
});

test("R1 transport: real chain delivers a model-visible replacement (extraction shape)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "r1-transport-"));
  const payload = {
    hook_event_name: "PostToolUse",
    session_id: "r1-transport",
    cwd: process.cwd(),
    tool_name: "read_file",
    tool_input: { file_path: "read_lab/r1.js" },
    tool_response: { content: readText },
  };
  const res = cp.spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      CODE_GUARD_BASE_DIR: base,
      CODE_GUARD_HOOK_DIR: HOOK_DIR,
      CODE_GUARD_EXTRACTIVE_READ: "1",
      CODE_GUARD_TERMINAL_STATE: "",
      CODE_GUARD_VALIDATION_DELTA: "",
      CODE_GUARD_FAILURE_CARRIER_AUTO: "",
    },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(res.status, 0, String(res.stderr));
  const out = JSON.parse(String(res.stdout).trim() || "{}");
  const updated = out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput;
  const delivered = typeof updated === "string" ? updated : (updated && (updated.content || updated.stdout)) || null;
  assert.ok(delivered, "model-visible replacement delivered");
  assert.match(delivered, /\[EXTRACTIVE READ v1\]/, "extractive envelope present");
  assert.ok(delivered.length < readText.length, "transport delivery reduced");
});

test("R1 WIRING RESOLVED: chain selection now uses task-derived symbols (R1-WIRING-1 done)", () => {
  // Resolved 2026-09-09 (Read Runtime Integration): the read_file branch
  // derives symbols from the task text (CODE_GUARD_CLAUDE_PROMPT, with the
  // bridge-persisted session task file as fallback) via read_strategy +
  // extractSymbols inside read_runtime.decideReadDelivery; session-state
  // symbols are no longer the selection source on first read. Guarded
  // fail-closed: task symbols absent from the file body -> native.
  const { decideReadDelivery } = require("./read_runtime.js");
  const d = decideReadDelivery({
    task_text: TASK_PROMPT,
    tool_input: { file_path: "read_lab/r1.js" },
    tool_text: readText,
    previous: null,
    module_map: null,
  });
  assert.equal(d.action, "replace");
  assert.equal(d.reason, "r1_task_symbols_extraction");
  assert.match(d.delivered, /parseConnectionString/, "task target extracted");
  assert.ok(!/E_ASCII_\d+/.test(d.delivered), "unrelated helpers excluded by task symbols");
  const gap = {
    id: "R1-WIRING-1",
    fix_point: "deploy/hooks/post_tool/read_runtime.js decideReadDelivery + post_tool_policy_hook read_file branch",
    was: "extractiveReadSummary(toolText, getKnownSymbols(st))",
    now: "task-derived symbols from CODE_GUARD_CLAUDE_PROMPT via read_strategy/extractSymbols",
    status: "RESOLVED",
  };
  assert.equal(gap.status, "RESOLVED");
});
