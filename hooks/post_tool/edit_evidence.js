function createEditEvidence(deps) {
  const {
    loadState,
    saveState,
    log,
    normalizeAfterToolState,
    addUniqueLimited,
    ensureSearchGovernanceState,
    addUnique,
    ensureObject,
    setPhaseIfForward,
  } = deps;
function isReplaceFailedText(text) {
  const lower = String(text || "").toLowerCase();

  return (
    lower.includes("old_string not found") ||
    lower.includes("replace json not found") ||
    lower.includes("not found") ||
    lower.includes("mismatch") ||
    lower.includes("replace failed") ||
    lower.includes("failed to replace")
  );
}

function markReplaceFailed(toolText) {
  const state = loadState();

  state.replace_policy_state = state.replace_policy_state || {};

  state.replace_policy_state.lastReplaceFailed = true;
  state.replace_policy_state.failedAt = new Date().toISOString();
  state.replace_policy_state.failedText = String(toolText || "").slice(0, 1000);
  state.replace_policy_state.recoverySliceReady = false;
  state.replace_policy_state.recoverySliceReadyAt = 0;

  const lastEdit = state.last_edit_attempt || {};

  state.edit_recovery_mode = true;
  state.edit_recovery_file = lastEdit.file_path || state.edit_recovery_file || "";
  state.edit_recovery_since = Date.now();
  state.edit_recovery_attempts = Number(state.edit_recovery_attempts || 0) + 1;

  saveState(state);

  log(
    `enter edit_recovery_mode file=${state.edit_recovery_file}, attempts=${state.edit_recovery_attempts}`
  );
}

function clearReplaceFailed() {
  const state = loadState();

  state.replace_policy_state = state.replace_policy_state || {};

  state.replace_policy_state.lastReplaceFailed = false;
  state.replace_policy_state.failedText = "";
  state.replace_policy_state.recoverySliceReady = false;
  state.replace_policy_state.recoverySliceReadyAt = 0;
  state.replace_policy_state.clearedAt = new Date().toISOString();

  state.edit_recovery_mode = false;
  state.edit_recovery_file = "";
  state.edit_recovery_since = 0;
  state.edit_recovery_attempts = 0;

  saveState(state);

  log("clear edit_recovery_mode after edit success");
}

function extractFilePathFromText(text) {
  const raw = String(text || "");

  const m =
    raw.match(/[A-Za-z]:\\[^"\n\r]+?\.(py|js|ts|java|go|rs|cpp|c|h|hpp|hh|md|txt)/i) ||
    raw.match(/[./\w-]+\/[./\w-]+?\.(py|js|ts|java|go|rs|cpp|c|h|hpp|hh|md|txt)/i);

  return m ? m[0].replace(/[)"',;]+$/g, "") : "";
}

function extractChangedLinesFromText(text) {
  const raw = String(text || "");

  const m1 = raw.match(/changed_start_line:\s*(\d+)[\s\S]{0,120}?changed_end_line:\s*(\d+)/i);
  if (m1) {
    return {
      changedStartLine: Number(m1[1]),
      changedEndLine: Number(m1[2]),
    };
  }

  const m2 = raw.match(/changed_lines:\s*(\d+)\s*-\s*(\d+)/i);
  if (m2) {
    return {
      changedStartLine: Number(m2[1]),
      changedEndLine: Number(m2[2]),
    };
  }

  return {};
}

function markEditSuccessFromAfterTool(toolName, toolText) {
  const state = normalizeAfterToolState(loadState());
  const changed = extractChangedLinesFromText(toolText);

  const filePath = extractFilePathFromText(toolText) || state.last_edit_attempt?.file_path || "";

  if (filePath) {
    state.target_files = addUniqueLimited(state.target_files, filePath, 80);
    state.recent_files = addUniqueLimited(state.recent_files, filePath, 80);

    const sg = ensureSearchGovernanceState(state);
    addUnique(sg.targetFiles, filePath, 100);
    state.search_policy_state = sg;

    const key = String(filePath || "").replace(/[\\/]+/g, "\\").toLowerCase();
    state.recent_edit_blocks = ensureObject(state.recent_edit_blocks);
    state.recent_edit_blocks[key] = {
      file: key,
      source: toolName || "aftertool_edit_success",
      changedStartLine: changed.changedStartLine || 0,
      changedEndLine: changed.changedEndLine || 0,
      updatedAt: Date.now()
    };
  }

  setPhaseIfForward(state, "edit", "aftertool_edit_success");

  state.updated_at = new Date().toISOString();
  saveState(state);

  log(`edit success marked tool=${toolName}, file=${filePath || "unknown"}, phase=${state.phase}`);
}

  return {
    isReplaceFailedText,
    markReplaceFailed,
    clearReplaceFailed,
    markEditSuccessFromAfterTool,
  };
}

module.exports = { createEditEvidence };