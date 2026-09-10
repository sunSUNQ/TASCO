"use strict";

// ============================================================================
// run_smoke.js — Line-6 任务驱动 Read 压缩确定性冒烟（主线⑥）
// 零依赖、无模型。用真实 frozen bridge（claude_bridge.js）验证：
//   1) flag OFF : read 逐字节 Native，无 read_task_compression 痕迹（回滚门）
//   2) R1       : 任务派生符号 → [EXTRACTIVE READ v1]，目标函数 verbatim 保留
//   3) R2       : identity map → [READ_RELATION_EVIDENCE]，边只来自 map
//   4) R4       : 同会话重复读 → [READ_SUPPRESSED]（note 无代码内容）；
//                 内容变化 → refresh（绝不抑制 stale）
//   5) R5       : 大文档 → [READ_SECTION_EXTRACTION]，无关章节剔除
//   6) R0       : 无法分类 → Native（默认原生）
// 观测产物落在 .tasco-runs/<timestamp>/ 下。
// 运行:node scripts/run_smoke.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const EXAMPLE_ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(EXAMPLE_ROOT, "..", "..", "adapters", "claude_bridge.js");
const HOOK_DIR = path.join(EXAMPLE_ROOT, "..", "..", "hooks");
const MAP_FILE = path.join(EXAMPLE_ROOT, "fixtures", "identity-map.json");
const RUN_DIR = path.join(EXAMPLE_ROOT, ".tasco-runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));

// ---- 合成大读取内容（离线、确定性；行数足以越过 3000-char skip 阈值）----
const R1_SOURCE = [
  "'use strict';",
  "",
  "// helper_1: verbose boilerplate unrelated to the task",
  "export function helper_1(input) {",
  "  const normalized = String(input || \"\").trim().toLowerCase();",
  "  if (normalized.length === 0) return { ok: false, code: \"E_EMPTY\" };",
  "  return { ok: true, value: normalized };",
  "}",
  "",
  "export function parseConnectionString(raw) {",
  "  const trimmed = String(raw || \"\").trim();",
  "  const scheme = trimmed.split(\"://\")[0] || \"http\";",
  "  const rest = trimmed.slice(scheme.length + 3);",
  "  const authority = rest.split(\"/\")[0];",
  "  const [hostPart, portPart] = authority.split(\":\");",
  "  let port = portPart ? Number(portPart) : null;",
  "  if (!port) {",
  "    if (scheme === \"https\") { port = 443; }",
  "    else if (scheme === \"postgres\") { port = 5432; }",
  "    else { port = 80; }",
  "  }",
  "  const tls = scheme === \"https\";",
  "  return { scheme, host: hostPart, port, tls };",
  "}",
  "",
  "// helper_2: historical note, intentionally verbose",
  "export function helper_2(input) {",
  "  const normalized = String(input || \"\").trim().toLowerCase();",
  "  if (normalized.length === 0) return { ok: false, code: \"E_EMPTY\" };",
  "  return { ok: true, value: normalized };",
  "}",
].join("\n");

function pad(source, targetChars) {
  let out = source;
  while (out.length < targetChars) out += `\n// filler line ${out.length} to exceed the small-read threshold`;
  return out;
}

const R1_RAW = pad(R1_SOURCE, 4200);
const R1_TASK =
  "Read read_lab/connection.js and analyze parseConnectionString: what default port does it use for each scheme, and when is tls enabled? Do not modify code.";
const R1_TASK_AGAIN =
  "I already read read_lab/connection.js earlier in this session; read it again to double-check the parseConnectionString port logic. Do not modify code.";

const R2_TASK =
  "Read-only analysis of request dispatch. Starting at lib/route.js, trace the bounded one-hop internal dependency path that passes a request into processing. Identify how route dispatch reaches handle-request, validation/hooks, and error handling. Do not modify files.";
const R2_RAW = pad("const routeOptions = require('./route-options');\n", 4200);

const R5_TASK =
  "Read docs/api_v2.md and report the required header for creating a v2 order, and state when the v1 endpoints are removed. Only use the document. Do not modify code.";
const R5_MD = [
  "# API v2",
  "",
  "## Creating orders",
  "Required header: Idempotency-Key.",
  "Auth uses Bearer tokens for all v2 endpoints.",
  "",
  "## Rate limits",
  "1000 req/min per key.",
  "",
  "## Unrelated section",
  "Nothing relevant here at all.",
  "",
].join("\n");
const R5_RAW = pad(R5_MD, 4200);
const R0_TASK = "Give me a general onboarding overview of this project.";

function readEvent(sessionId, filePath, rawText, over = {}) {
  return {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    cwd: EXAMPLE_ROOT,
    tool_name: "Read",
    tool_input: { file_path: filePath },
    tool_response: { type: "text", file: { filePath, content: rawText } },
    ...over,
  };
}

function spawnBridge({ base, sessionId, event, prompt, readFlag }) {
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env: {
      ...process.env,
      CODE_GUARD_BASE_DIR: base,
      CODE_GUARD_HOOK_DIR: HOOK_DIR,
      CODE_GUARD_AUTO_CANARY_V1A: "1",
      CODE_GUARD_CLAUDE_PROMPT: prompt,
      CODE_GUARD_READ_COMPRESSION: readFlag ? "1" : "",
      CODE_GUARD_STRUCTURAL_MAP: MAP_FILE,
      CODE_GUARD_TERMINAL_STATE: "",
      CODE_GUARD_TERMINAL_STATE_SHADOW: "",
      CODE_GUARD_VALIDATION_DELTA: "",
      CODE_GUARD_FAILURE_CARRIER_AUTO: "",
      CODE_GUARD_SEARCH_GUIDANCE: "",
    },
    encoding: "utf8",
    timeout: 120000,
  });
  if (res.status !== 0) throw new Error(String(res.stderr));
  const output = JSON.parse(String(res.stdout).trim() || "{}");
  const delivered = output.hookSpecificOutput && output.hookSpecificOutput.updatedToolOutput;
  const content =
    typeof delivered === "string"
      ? delivered
      : delivered && delivered.file && typeof delivered.file.content === "string"
        ? delivered.file.content
        : (delivered && (delivered.content || delivered.stdout)) || null;
  return { content: content || null };
}

function rows(base, sessionId) {
  const f = path.join(base, "context_budget", "claude_auto_canary.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const runOn = path.join(RUN_DIR, "session");
fs.mkdirSync(runOn, { recursive: true });
const runOff = path.join(RUN_DIR, "flag-off");
fs.mkdirSync(runOff, { recursive: true });

// ---- session telemetry markers（skill 打点管线的离线确定性验证）----
// SKILL.md 在真实 agent 会话中指示 agent 调用 session_marker.py（start/end）；
// 本冒烟以相同脚本离线驱动同一管线：start → 压缩 cells → end rollup，
// 并校验 dashboard.ndjson 中的会话级行（saved_chars 只计 model-visible）。
// python 不可用时 fail-open（marker 跳过，不破坏冒烟）。
const MARKER = path.join(EXAMPLE_ROOT, "..", "..", "skills", "code-guard-workflow", "scripts", "session_marker.py");
// marker cwd = EXAMPLE_ROOT：rollup 递归扫描本目录的 .tasco-runs 遥测。
const MARKER_CWD = EXAMPLE_ROOT;
let markerRan = false;
function runMarker(phase) {
  for (const py of ["python", "py"]) {
    try {
      const r = cp.spawnSync(py, [MARKER, phase, "--skill", "code-guard-workflow", "--task", "read compression smoke"], {
        cwd: MARKER_CWD, encoding: "utf8", timeout: 30000,
      });
      if (r.status === 0) return true;
    } catch (_e) { /* try next interpreter */ }
  }
  return false;
}
markerRan = runMarker("start");

// 1) flag OFF：读取保持 Native，无能力痕迹
const off = spawnBridge({ base: runOff, sessionId: "smoke-read-off", event: readEvent("smoke-read-off", "read_lab/connection.js", R1_RAW), prompt: R1_TASK, readFlag: false });

// 2) R1：任务派生符号提取
const r1 = spawnBridge({ base: runOn, sessionId: "smoke-read", event: readEvent("smoke-read", "read_lab/connection.js", R1_RAW), prompt: R1_TASK, readFlag: true });

// 3) R4：同会话重复读 → suppress；内容变化 → refresh（原样重投）
const r4suppress = spawnBridge({ base: runOn, sessionId: "smoke-read", event: readEvent("smoke-read", "read_lab/connection.js", R1_RAW), prompt: R1_TASK_AGAIN, readFlag: true });
const r4refresh = spawnBridge({ base: runOn, sessionId: "smoke-read", event: readEvent("smoke-read", "read_lab/connection.js", `// CHANGED-MARKER\n${R1_RAW}`), prompt: R1_TASK_AGAIN, readFlag: true });

// 4) R2：任务入口文件的读取 → 关系边（边只来自 map）
const r2 = spawnBridge({ base: runOn, sessionId: "smoke-read", event: readEvent("smoke-read", "lib/route.js", R2_RAW), prompt: R2_TASK, readFlag: true });

// 5) R5：大文档 → 相关章节
const r5 = spawnBridge({ base: runOn, sessionId: "smoke-read", event: readEvent("smoke-read", "docs/api_v2.md", R5_RAW), prompt: R5_TASK, readFlag: true });

// 6) R0：无法分类 → Native（新文件，无 ledger 历史 → 无 R4 干扰）
const R0_RAW = pad("const overview = require('./meta');\n", 4200);
const r0 = spawnBridge({ base: runOn, sessionId: "smoke-read", event: readEvent("smoke-read", "lib/overview.js", R0_RAW), prompt: R0_TASK, readFlag: true });

// ---- session telemetry marker：end rollup（汇总上面的压缩 cells）----
markerRan = runMarker("end") && markerRan;

// dashboard.ndjson 校验：session_end 行须汇总到本冒烟的 model-visible 压缩
let dashRow = null;
try {
  const dashPath = path.join(MARKER_CWD, ".code-guard", "markers", "dashboard.ndjson");
  const rows = fs.readFileSync(dashPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  dashRow = rows.filter((r) => r.type === "session_end").pop() || null;
} catch (_e) {
  dashRow = null;
}

const onRows = rows(runOn, "smoke-read");
const offRows = rows(runOff, "smoke-read-off");
const readCompRows = onRows.filter((r) => r.type === "compression" && r.capability === "read_task_compression");
const offCompRows = offRows.filter((r) => r.capability === "read_task_compression");

const checks = {
  "flag OFF: 读取保持 Native（无替换）": off.content === null,
  "flag OFF: 无 read_task_compression 行（逐字节回滚）": offCompRows.length === 0,
  "R1: 交付 [EXTRACTIVE READ v1]": Boolean(r1.content && r1.content.includes("[EXTRACTIVE READ v1]")),
  "R1: 任务符号 parseConnectionString verbatim 保留": Boolean(r1.content && r1.content.includes("parseConnectionString")),
  "R1: 结果保真（443/5432/tls 语义在交付内）": Boolean(r1.content && r1.content.includes("443") && r1.content.includes("5432")),
  "R1: 有净节省（< 原文 40%）": Boolean(r1.content && r1.content.length < R1_RAW.length * 0.4),
  "R4: 重复读 → [READ_SUPPRESSED]": Boolean(r4suppress.content && r4suppress.content.includes("[READ_SUPPRESSED]")),
  "R4: suppress note 不含代码内容": Boolean(r4suppress.content && !r4suppress.content.includes("parseConnectionString")),
  "R4: 内容变化 → refresh（绝不抑制 stale）": r4refresh.content === null,
  "R2: 交付 [READ_RELATION_EVIDENCE]": Boolean(r2.content && r2.content.includes("[READ_RELATION_EVIDENCE]")),
  "R2: 边只来自 map（route.js -> handle-request.js）": Boolean(r2.content && r2.content.includes("lib/route.js -> lib/handle-request.js")),
  "R5: 交付 [READ_SECTION_EXTRACTION]": Boolean(r5.content && r5.content.includes("[READ_SECTION_EXTRACTION]")),
  "R5: 命中章节保留（Idempotency-Key）": Boolean(r5.content && r5.content.includes("Idempotency-Key")),
  "R5: 无关章节剔除（rate limits 不在交付内）": Boolean(r5.content && !r5.content.includes("1000 req/min")),
  "R0: 无法分类 → Native（无替换）": r0.content === null,
  "遥测: 每次交付都有 model-visible 记录": readCompRows.length >= 4 && readCompRows.every((r) => r.transport_replacement_emitted === true),
  "遥测: 全部 read 行 originalLength > compressedLength": readCompRows.every((r) => r.originalLength > r.compressedLength),
  "看板: start/end 打点被触发（session_marker.py 可用）": markerRan && dashRow !== null,
  "看板: session_end 行汇总 saved_chars > 0（仅 model-visible 计入）": Boolean(dashRow && dashRow.compression && dashRow.compression.saved_chars > 0),
  "看板: session_end 行 strategy 维度齐全": Boolean(dashRow && dashRow.compression && ["extractive_read", "relation_evidence", "repeat_suppression", "section_extraction"].every((s) => (dashRow.compression.by_strategy[s] || 0) >= 1)),
};

fs.writeFileSync(path.join(RUN_DIR, "runs.json"), JSON.stringify({
  off: off.content, r1: r1.content, r4suppress: r4suppress.content, r4refresh: r4refresh.content,
  r2: r2.content, r5: r5.content, r0: r0.content,
  read_compression_rows: readCompRows,
}, null, 2));
fs.writeFileSync(path.join(RUN_DIR, "checks.json"), JSON.stringify(checks, null, 2));

console.log(`R1 raw ${R1_RAW.length} -> ${r1.content ? r1.content.length : "NONE"} chars | R4 repeat ${R1_RAW.length} -> ${r4suppress.content ? r4suppress.content.length : "native"} chars | R2 raw ${R2_RAW.length} -> ${r2.content ? r2.content.length : "NONE"} chars | R5 raw ${R5_RAW.length} -> ${r5.content ? r5.content.length : "NONE"} chars`);
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"} - ${k}`);
console.log(allPass(checks) ? "\nSMOKE PASS — task-driven read compression delivers model-visible extractions, edges, sections and repeat suppression" : "\nSMOKE FAIL");
console.log(`evidence -> ${RUN_DIR}`);
process.exit(allPass(checks) ? 0 : 1);

function allPass(checks) {
  return Object.values(checks).every(Boolean);
}
