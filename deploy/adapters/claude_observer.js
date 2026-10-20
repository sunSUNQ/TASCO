"use strict";
// Claude bridge 的会话级 Auto-Canary 观察器。
// 只复用冻结模块（capability_interface/shadow_router.js），实现
// current 策略的最小 dominant-eligible 语义（≥4K 且不小于已介入最大输出）。
// 状态按 session 落盘，保证 Claude hook 多进程间连续。
const fs = require("fs");
const path = require("path");
const CAPABILITY_INTERFACE_DIR = (() => {
  const candidates = [
    path.join(__dirname, "..", "core", "capability_interface"),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, "shadow_router.js"))) || candidates[0];
})();
const {
  decideWithDiagnosticEligibilityBoundary,
  decide,
} = require(path.join(CAPABILITY_INTERFACE_DIR, "shadow_router.js"));
const { detectIntents } = require(path.join(CAPABILITY_INTERFACE_DIR, "bilingual_intent.js"));
const { canonicalToolFamily } = require("./canonical_tools");
const MIN_DIAGNOSTIC_OUTPUT = 4000;
function stateDir() {
  return process.env.CODE_GUARD_BASE_DIR || path.join(process.cwd(), ".code-guard");
}
function stateFile(sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(stateDir(), "context_budget", `claude_state_${safe}.json`);
}
function createAutoCanaryObserver({ sessionId, prompt }) {
  const file = stateFile(sessionId);
  const state = {
    prompt: String(prompt || ""),
    observedMaxOutputSize: 0,
    observedDominantTool: "unknown",
    eligibleMaxOutputSize: 0,
    files: [],
    grepUsed: false,
    readUsed: false,
    toolOrdinal: 0,
    capabilitySequence: [],
    interventionCount: 0,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(state, saved);
    if (!Array.isArray(state.files)) state.files = [];
    if (!Array.isArray(state.capabilitySequence)) state.capabilitySequence = [];
    if (prompt) state.prompt = String(prompt);
  } catch (_e) {
    // 首次会话：无状态文件，使用初始状态。
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
    } catch (_e) {}
  }
  function observe(payload, raw) {
    const rawTool = String((payload && payload.tool_name) || "unknown");
    const family = canonicalToolFamily(rawTool);
    const size = String(raw || "").length;
    state.toolOrdinal += 1;
    if (size >= state.observedMaxOutputSize) {
      state.observedMaxOutputSize = size;
      state.observedDominantTool = rawTool;
    }
    if (family === "search") state.grepUsed = true;
    if (family === "read") state.readUsed = true;
    const args = (payload && payload.tool_input) || {};
    const fileArg = args.file_path || args.filePath || args.path;
    if (fileArg) {
      const f = String(fileArg);
      if (!state.files.includes(f)) state.files.push(f);
    }
    const boundary =
      process.env.CODE_GUARD_AUTO_CANARY_DIAGNOSTIC_ELIGIBILITY_BOUNDARY === "1";
    const decision = (boundary ? decideWithDiagnosticEligibilityBoundary : decide)({
      prompt: state.prompt,
      dominantTool: state.observedDominantTool,
      maxOutputSize: state.observedMaxOutputSize,
      distinctFiles: state.files.length,
      crossFile: state.files.length >= 2,
      grepUsed: state.grepUsed,
      readUsed: state.readUsed,
    });
    const selected = decision.expected_strategy;
    if (state.capabilitySequence[state.capabilitySequence.length - 1] !== selected) {
      state.capabilitySequence.push(selected);
    }
    const currentEligible =
      selected === "diagnostic_semantic" &&
      size >= MIN_DIAGNOSTIC_OUTPUT &&
      size >= state.eligibleMaxOutputSize;
    const applied = currentEligible ? "diagnostic_semantic" : "native";
    if (applied === "diagnostic_semantic") {
      state.eligibleMaxOutputSize = size;
      state.interventionCount += 1;
    }
    save();
    const intentInfo = detectIntents(state.prompt);
    return {
      selected,
      applied,
      decision,
      size,
      tool: rawTool,
      family,
      language: intentInfo.language,
      matchedIntents: intentInfo.intents,
      matchedPatterns: intentInfo.matchedPatterns,
    };
  }
  return { state, file, save, observe };
}
module.exports = { createAutoCanaryObserver, MIN_DIAGNOSTIC_OUTPUT, stateFile };
