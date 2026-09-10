"use strict";

// ============================================================================
// run_smoke.js — 看板对接最小运行（一次真实压缩 + start/end 打点）
// ============================================================================
// 面向看板对接方的最小可跑 kit（离线、无模型、零依赖）：
//   1. session_marker.py start
//   2. 一次最小真实压缩（真实 frozen bridge：R1 任务派生符号提取）
//   3. session_marker.py end（自动从遥测汇总压缩效果）
//   4. 实时打印 dashboard.ndjson 全部行 —— 对接方即可核对字段
// 运行：node scripts/run_smoke.js（或 npm run smoke）
// ============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const EXAMPLE_ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(EXAMPLE_ROOT, "..", "..", "adapters", "claude_bridge.js");
const HOOK_DIR = path.join(EXAMPLE_ROOT, "..", "..", "hooks");
const MARKER = path.join(EXAMPLE_ROOT, "..", "..", "skills", "code-guard-workflow", "scripts", "session_marker.py");
const RUN_DIR = path.join(EXAMPLE_ROOT, ".tasco-runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));

// ---- 最小压缩样本：一个大文件 + 一个点名符号的任务 ----
const SOURCE = [
  "'use strict';",
  "",
  "export function parseOrderConfig(raw) {",
  "  const trimmed = String(raw || \"\").trim();",
  "  if (!trimmed) return { ok: false, code: \"E_EMPTY\" };",
  "  const config = JSON.parse(trimmed);",
  "  return { ok: true, mode: config.mode || \"standard\", retries: config.retries || 3 };",
  "}",
  "",
  "export function unrelatedHelper(input) {",
  "  const normalized = String(input || \"\").trim().toLowerCase();",
  "  if (normalized.length === 0) return { ok: false, code: \"E_EMPTY\" };",
  "  return { ok: true, value: normalized };",
  "}",
].join("\n");
let text = SOURCE;
while (text.length < 4200) text += `\n// filler line ${text.length} to exceed the small-read threshold`;
const TASK = "Read order_config.js and analyze parseOrderConfig: what mode and retries does it return? Do not modify code.";

function spawnBridge(sessionId) {
  const event = {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    cwd: EXAMPLE_ROOT,
    tool_name: "Read",
    tool_input: { file_path: "order_config.js" },
    tool_response: { type: "text", file: { filePath: "order_config.js", content: text } },
  };
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env: {
      ...process.env,
      CODE_GUARD_BASE_DIR: RUN_DIR,
      CODE_GUARD_HOOK_DIR: HOOK_DIR,
      CODE_GUARD_AUTO_CANARY_V1A: "1",
      CODE_GUARD_CLAUDE_PROMPT: TASK,
      CODE_GUARD_READ_COMPRESSION: "1",
      CODE_GUARD_STRUCTURAL_MAP: "",
      CODE_GUARD_TERMINAL_STATE: "",
      CODE_GUARD_VALIDATION_DELTA: "",
      CODE_GUARD_FAILURE_CARRIER_AUTO: "",
      CODE_GUARD_SEARCH_GUIDANCE: "",
    },
    encoding: "utf8",
    timeout: 120000,
  });
  if (res.status !== 0) throw new Error(String(res.stderr));
  const out = JSON.parse(String(res.stdout).trim() || "{}");
  const u = out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput;
  const content =
    typeof u === "string" ? u : u && u.file && typeof u.file.content === "string" ? u.file.content : (u && (u.content || u.stdout)) || null;
  return content || null;
}

function runMarker(phase) {
  for (const py of ["python", "py"]) {
    try {
      const r = cp.spawnSync(py, [MARKER, phase, "--skill", "dashboard-integration-test", "--task", "minimal compression run"], {
        cwd: EXAMPLE_ROOT, encoding: "utf8", timeout: 30000,
      });
      if (r.status === 0) return true;
    } catch (_e) { /* try next */ }
  }
  return false;
}

// ---- 1. start 打点 ----
const started = runMarker("start");
console.log(`[marker] start ${started ? "recorded" : "SKIPPED (python unavailable)"}`);

// ---- 2. 一次最小真实压缩 ----
const delivered = spawnBridge("marker-demo-session");
if (!delivered) throw new Error("compression did not deliver");
console.log(`[compress] raw ${text.length} -> delivered ${delivered.length} chars (model-visible)`);

// ---- 3. end 打点（自动汇总上面的压缩）----
const ended = runMarker("end");
console.log(`[marker] end ${ended ? "recorded" : "SKIPPED (python unavailable)"}`);

// ---- 4. 实时打印看板行 ----
const dashPath = path.join(EXAMPLE_ROOT, ".code-guard", "markers", "dashboard.ndjson");
const rows = fs.existsSync(dashPath)
  ? fs.readFileSync(dashPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : [];
console.log("\n===== dashboard.ndjson（实时）=====");
for (const r of rows) console.log(JSON.stringify(r));
console.log("=====================================\n");

const endRow = rows.filter((r) => r.type === "session_end").pop();
const checks = {
  "压缩: 真实交付（model-visible）": Boolean(delivered && delivered.includes("[EXTRACTIVE READ v1]")),
  "打点: start/end 均被触发": started && ended,
  "看板: session_end 行存在": Boolean(endRow),
  "看板: saved_chars > 0（仅 model-visible 计入）": Boolean(endRow && endRow.compression && endRow.compression.saved_chars > 0),
  "看板: by_strategy 含 extractive_read": Boolean(endRow && endRow.compression && (endRow.compression.by_strategy.extractive_read || 0) >= 1),
};

fs.writeFileSync(path.join(RUN_DIR, "checks.json"), JSON.stringify(checks, null, 2));
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"} - ${k}`);
console.log(allPass(checks) ? "\nSMOKE PASS — one minimal compression + session markers, dashboard rows printed above" : "\nSMOKE FAIL");
console.log(`dashboard log -> ${dashPath}`);
process.exit(allPass(checks) ? 0 : 1);

function allPass(checks) {
  return Object.values(checks).every(Boolean);
}
