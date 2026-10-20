const path = require("path");

function createStateRuntime(deps) {
  const {
    fs,
    getStateFilePath,
    log,
    safeJsonStringify,
    mapCodeAgentToolName,
  } = deps;
function loadState() {
  try {
    const file = getStateFilePath();
    if (!fs.existsSync(file)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(file, "utf8") || "{}");
  } catch (e) {
    log(`load state error=${String(e)}`);
    return {};
  }
}

function saveState(state) {
  try {
    const file = getStateFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    log(`save state error=${String(e)}`);
  }
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function addUniqueLimited(arr, item, maxItems = 200) {
  const result = ensureArray(arr);
  const v = String(item || "").trim();

  if (!v) {
    return result;
  }

  if (!result.includes(v)) {
    result.push(v);
  }

  return result.slice(-maxItems);
}

function ensureSearchGovernanceState(state) {
  state = ensureObject(state);

  // 必须和 BeforeTool 统一字段名
  state.search_policy_state = ensureObject(state.search_policy_state);

  const sg = state.search_policy_state;

  sg.sessionSeenSearchKeys = ensureArray(sg.sessionSeenSearchKeys).slice(-500);
  sg.turnSearchCount = ensureNumber(sg.turnSearchCount, 0);
  sg.turnGlobalSearchCount = ensureNumber(sg.turnGlobalSearchCount, 0);
  sg.turnEmptySearchCount = ensureNumber(sg.turnEmptySearchCount, 0);

  sg.targetEvidenceScore = ensureNumber(sg.targetEvidenceScore, 0);

  sg.noNewEvidenceSearchCount = ensureNumber(sg.noNewEvidenceSearchCount, 0);
  sg.lastEvidenceGain = ensureObject(sg.lastEvidenceGain);
  sg.evidenceGainHistory = ensureArray(sg.evidenceGainHistory).slice(-50);

  sg.targetFiles = ensureArray(sg.targetFiles).slice(-100);
  sg.targetSymbols = ensureArray(sg.targetSymbols).slice(-120);
  sg.targetTests = ensureArray(sg.targetTests).slice(-80);

  sg.readRanges = ensureArray(sg.readRanges).slice(-500);
  sg.fullyReadFiles = ensureArray(sg.fullyReadFiles).slice(-200);
  sg.readRangeRecords = ensureArray(sg.readRangeRecords).slice(-500);

  return sg;
}

function normalizeAfterToolState(state) {
  state = ensureObject(state);

  state.phase = state.phase || "explore";
  state.phase_updated_at = state.phase_updated_at || new Date().toISOString();

  state.phase_state = ensureObject(state.phase_state);
  state.phase_state.root_list_done = Boolean(state.phase_state.root_list_done);
  state.phase_state.repo_map_done = Boolean(state.phase_state.repo_map_done);
  state.phase_state.repo_map_suggested = Boolean(state.phase_state.repo_map_suggested);
  state.phase_state.target_locked = Boolean(state.phase_state.target_locked);

  state.repo_map = ensureObject(state.repo_map);
  state.target_files = ensureArray(state.target_files).slice(-80);
  state.target_symbols = ensureArray(state.target_symbols).slice(-80);
  state.required_keywords = ensureArray(state.required_keywords).slice(-80);
  state.recent_files = ensureArray(state.recent_files).slice(-80);

  state.search_policy_state = ensureObject(state.search_policy_state);
  ensureSearchGovernanceState(state);

  state.replace_policy_state = ensureObject(state.replace_policy_state);
  state.replace_policy_state.recentSlices = ensureArray(
    state.replace_policy_state.recentSlices
  ).slice(-100);

  state.replace_policy_state.lastReplaceFailed = Boolean(
    state.replace_policy_state.lastReplaceFailed
  );

  state.replace_policy_state.recoverySliceReady = Boolean(
    state.replace_policy_state.recoverySliceReady
  );

  state.replace_policy_state.recoverySliceReadyAt = ensureNumber(
    state.replace_policy_state.recoverySliceReadyAt,
    0
  );

  state.recent_edit_blocks = ensureObject(state.recent_edit_blocks);

  return state;
}

function getKnownFiles(state) {
  const sg = ensureObject(state.search_policy_state);

  return [
    ...ensureArray(state.target_files),
    ...ensureArray(sg.targetFiles)
  ].filter(Boolean);
}

function getKnownSymbols(state) {
  const sg = ensureObject(state.search_policy_state);

  return [
    ...ensureArray(state.target_symbols),
    ...ensureArray(sg.targetSymbols)
  ].filter(Boolean);
}

function hasKnownFiles(state) {
  return getKnownFiles(state).length > 0;
}

function hasKnownSymbols(state) {
  return getKnownSymbols(state).length > 0;
}

function setPhaseIfForward(state, phase, reason) {
  const order = {
    explore: 0,
    focus: 1,
    edit: 2
  };

  const current = state.phase || "explore";

  if ((order[phase] || 0) >= (order[current] || 0)) {
    state.phase = phase;
    state.phase_reason = reason || "";
    state.phase_updated_at = new Date().toISOString();
  }
}

function syncTopLevelEvidence(state) {
  const sg = ensureObject(state.search_policy_state);

  for (const f of ensureArray(sg.targetFiles)) {
    state.target_files = addUniqueLimited(state.target_files, f, 80);
    state.recent_files = addUniqueLimited(state.recent_files, f, 80);
  }

  for (const s of ensureArray(sg.targetSymbols)) {
    state.target_symbols = addUniqueLimited(state.target_symbols, s, 80);
  }

  // AfterTool only records evidence and moves to focus.
  // Do not enter edit merely because files + symbols exist.
  // Edit should be entered only after a real edit tool succeeds.
  state.phase_state = ensureObject(state.phase_state);
  if (state.phase_state.repo_map_done || hasKnownFiles(state)) {
    setPhaseIfForward(state, "focus", "aftertool_focus_evidence");
  }
  return state;
}

function addUnique(arr, item, maxItems = 200) {
  const x = String(item || "").trim();
  if (!x) return;

  if (!arr.includes(x)) {
    arr.push(x);
  }

  if (arr.length > maxItems) {
    arr.splice(0, arr.length - maxItems);
  }
}

function extractResponseText(response) {
  if (response === undefined || response === null) return "";
  if (typeof response === "string") return response;
  if (typeof response.content === "string") return response.content;
  if (typeof response.stdout === "string") {
    return [response.stdout, response.stderr].filter(Boolean).join("\n");
  }
  if (response.file && typeof response.file.content === "string") return response.file.content;
  if (typeof response.output === "string") return response.output;
  if (Array.isArray(response.content)) {
    const parts = response.content
      .map((block) => typeof block === "string" ? block : block?.text)
      .filter((value) => typeof value === "string" && value);
    if (parts.length) return parts.join("\n");
  }
  return "";
}

function extractToolText(payload, toolName = "") {
  if (toolName === "replace" || toolName === "edit") {
    const resp =
      payload.tool_response ||
      payload.toolResponse ||
      payload.response ||
      {};
    return extractResponseText(resp) || String(resp.llmContent || resp.returnDisplay || "");
  }

  const candidates = [
    extractResponseText(payload.tool_response),
    extractResponseText(payload.toolResponse),
    extractResponseText(payload.response),
    payload.tool_response?.content,
    payload.toolResponse?.content,
    payload.response?.content,
    payload.tool_response?.llmContent,
    payload.tool_response?.returnDisplay,
    payload.toolResponse?.llmContent,
    payload.toolResponse?.returnDisplay,
    payload.response?.llmContent,
    payload.response?.returnDisplay,
    payload.output,
    payload.result
  ];

  for (const item of candidates) {
    if (item === undefined || item === null) continue;
    if (typeof item === "string") {
      if (item) return item;
      continue;
    }
    return safeJsonStringify(item);
  }

  return "";
}



function normalizeToolName(name) {
  const raw = mapCodeAgentToolName(name);
  const lower = raw.toLowerCase();

  if (lower.includes("read") && lower.includes("file")) return "read_file";
  if (lower.includes("grep") || lower.includes("search")) return "grep_search";

  if (
    lower.includes("shell") ||
    lower.includes("command") ||
    lower.includes("run")
  ) {
    return "run_shell_command";
  }

  if (lower.includes("replace") || lower === "edit") return "replace";
  if (lower.includes("update") && lower.includes("topic")) return "update_topic";

  return raw;
}

function extractToolName(payload) {
  return normalizeToolName(
    payload.tool_name ||
      payload.toolName ||
      payload.name ||
      payload.tool?.name ||
      payload.toolCall?.name ||
      payload.tool_call?.name ||
      "unknown_tool"
  );
}

function hasShellError(text) {
  const patterns = [
    /traceback/i,
    /assertionerror/i,
    /\bfailed\b/i,
    /\berror\b/i,
    /exception/i,
    /modulenotfounderror/i,
    /importerror/i,
    /syntaxerror/i,
    /typeerror/i,
    /valueerror/i,
    /npm err!/i,
    /fatal:/i,
    /command failed/i,
    /permission denied/i,
    /no such file or directory/i,
    /cannot find module/i
  ];

  return patterns.some((p) => p.test(text));
}

  return {
    loadState,
    saveState,
    ensureObject,
    ensureArray,
    ensureNumber,
    addUniqueLimited,
    ensureSearchGovernanceState,
    normalizeAfterToolState,
    getKnownFiles,
    getKnownSymbols,
    hasKnownFiles,
    hasKnownSymbols,
    setPhaseIfForward,
    syncTopLevelEvidence,
    addUnique,
    extractResponseText,
    extractToolText,
    normalizeToolName,
    extractToolName,
    hasShellError,
  };
}

module.exports = { createStateRuntime };
