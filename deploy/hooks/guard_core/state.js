// ============================================================================
// guard_core/state.js — State store and task hash utilities
// ============================================================================

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  sessionPath,
  sanitizeSessionId,
  setActiveSessionId,
} = require("./runtime_paths");
const { log } = require("./log");
const {
  ensureObject,
  ensureArray,
  ensureNumber,
} = require("./text_utils");

function getStateFilePath() {
  return sessionPath("context_budget_state.json");
}

/**
 * Compute a deterministic task hash from task state for per-task tracking.
 * Uses task_mode + last_user_query hash + active_contract hash to uniquely identify a task.
 * Does NOT hardcode any specific repo path.
 */
function computeTaskHash(taskState) {
  if (!taskState) return "default";
  const mode = taskState.task_mode || "unknown";
  const query = String(taskState.last_user_query || "").slice(0, 200);
  const contractFile = taskState.active_contract?.file || "";
  const raw = `${mode}::${query}::${contractFile}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const chr = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return String(Math.abs(hash));
}

function loadState() {
  try {
    const file = getStateFilePath();
    if (!fs.existsSync(file)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(file, "utf8") || "{}");
  } catch (_e) {
    return {};
  }
}

function saveState(state) {
  try {
    const file = getStateFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    try {
      log(`state save error=${String(e)}`);
    } catch (_e) {}
  }
}

function getPhaseState(taskState) {
  taskState.phase_state = ensureObject(taskState.phase_state);
  return taskState.phase_state;
}

function getReplacePolicyState(taskState) {
  taskState.replace_policy_state = ensureObject(taskState.replace_policy_state);
  return taskState.replace_policy_state;
}

function getKnownFiles(taskState) {
  const sg = taskState?.search_policy_state || {};
  return [
    ...ensureArray(taskState?.target_files),
    ...ensureArray(sg.targetFiles)
  ].filter(Boolean);
}

function getKnownSymbols(taskState) {
  const sg = taskState?.search_policy_state || {};
  return [
    ...ensureArray(taskState?.target_symbols),
    ...ensureArray(sg.targetSymbols)
  ].filter(Boolean);
}

function hasKnownFiles(taskState) {
  return getKnownFiles(taskState).length > 0;
}

function hasKnownSymbols(taskState) {
  return getKnownSymbols(taskState).length > 0;
}

function hasRepoMap(taskState) {
  return Boolean(
    getPhaseState(taskState).repo_map_done ||
    taskState?.repo_map?.generated
  );
}

// ============================================================================
// normalizeFocusedCallChainState — Initialize/fix focused_call_chain_state fields
// ============================================================================
function normalizeFocusedCallChainState(state) {
  state = state || {};
  state.focused_call_chain_state = state.focused_call_chain_state || {};
  const ccs = state.focused_call_chain_state;

  ccs.target_symbol = ccs.target_symbol || "";
  ccs.target_files = Array.isArray(ccs.target_files) ? ccs.target_files : [];
  ccs.direct_call_sites_found = Boolean(ccs.direct_call_sites_found);
  ccs.definition_read_done = Boolean(ccs.definition_read_done);
  ccs.direct_callers_read_count = Number.isFinite(ccs.direct_callers_read_count) ? ccs.direct_callers_read_count : 0;
  ccs.callee_or_macro_reads_count = Number.isFinite(ccs.callee_or_macro_reads_count) ? ccs.callee_or_macro_reads_count : 0;
  ccs.upstream_expansion_blocked_count = Number.isFinite(ccs.upstream_expansion_blocked_count) ? ccs.upstream_expansion_blocked_count : 0;
  ccs.completed = Boolean(ccs.completed);
  ccs.exact_symbol_search_count = Number.isFinite(ccs.exact_symbol_search_count) ? ccs.exact_symbol_search_count : 0;
  ccs.direct_caller_search_count = Number.isFinite(ccs.direct_caller_search_count) ? ccs.direct_caller_search_count : 0;
  ccs.user_key_symbol_search_count = Number.isFinite(ccs.user_key_symbol_search_count) ? ccs.user_key_symbol_search_count : 0;
  ccs.user_named_symbols = Array.isArray(ccs.user_named_symbols) ? ccs.user_named_symbols : [];
  ccs.same_file_target_definition_reads = Number.isFinite(ccs.same_file_target_definition_reads) ? ccs.same_file_target_definition_reads : 0;
  ccs.same_file_caller_slices_count = Number.isFinite(ccs.same_file_caller_slices_count) ? ccs.same_file_caller_slices_count : 0;
  ccs.same_file_callee_slices_count = Number.isFinite(ccs.same_file_callee_slices_count) ? ccs.same_file_callee_slices_count : 0;

  return state;
}

// ============================================================================
// normalizeTaskState — Ensure all task state fields have valid defaults
// ============================================================================
function normalizeTaskState(state) {
  state = ensureObject(state);

  // ===== legacy task-level fields =====
  state.spec_contracts = ensureObject(state.spec_contracts);
  state.counters = ensureObject(state.counters);
  state.budget = ensureObject(state.budget);
  state.repo_map = ensureObject(state.repo_map);
  state.read_folder = ensureObject(state.read_folder);
  state.exploration = ensureObject(state.exploration);
  state.agent_budgets = ensureObject(state.agent_budgets);

  state.target_symbols = ensureArray(state.target_symbols).slice(-30);
  state.target_files = ensureArray(state.target_files).slice(-80);
  state.required_keywords = ensureArray(state.required_keywords).slice(-80);
  state.recent_files = ensureArray(state.recent_files).slice(-80);

  if (state.read_folder.history !== undefined) {
    state.read_folder.history = ensureArray(state.read_folder.history).slice(-20);
  }

  state.replace_policy_state = ensureObject(state.replace_policy_state);

  // ===== phase-based agent control =====
  state.phase = state.phase || "explore"; // explore | focus | edit
  state.phase_updated_at = state.phase_updated_at || new Date().toISOString();

  state.phase_state = ensureObject(state.phase_state);
  state.phase_state.root_list_done = Boolean(state.phase_state.root_list_done);
  state.phase_state.repo_map_done = Boolean(state.phase_state.repo_map_done);
  state.phase_state.broad_search_count = ensureNumber(state.phase_state.broad_search_count, 0);
  state.phase_state.focused_code_analysis_symbol_search_count = ensureNumber(state.phase_state.focused_code_analysis_symbol_search_count, 0);
  state.phase_state.target_locked = Boolean(state.phase_state.target_locked);

  // ===== focused call-chain sub-strategy state =====
  state = normalizeFocusedCallChainState(state);

  // ===== repo_analysis readonly mode =====
  state.readonly_task = Boolean(state.readonly_task);
  state.allow_code_mutation = state.allow_code_mutation !== false;

  // ===== per-task-hash structure summary tracking =====
  // These prevent cross-task pollution: each task hash gets its own tracking.
  state.structure_summary_attempted_by_task_hash = ensureObject(state.structure_summary_attempted_by_task_hash);
  state.structure_summary_done_by_task_hash = ensureObject(state.structure_summary_done_by_task_hash);
  state.structure_summary_unavailable_by_task_hash = ensureObject(state.structure_summary_unavailable_by_task_hash);

  // ===== per-task-hash repo_analysis focus budget =====
  state.repo_analysis_focus_budget_by_task_hash = ensureObject(state.repo_analysis_focus_budget_by_task_hash);
  // repo_analysis evidence files (isolated from target_files to avoid cross-task pollution)
  state.repo_analysis_evidence_files = ensureArray(state.repo_analysis_evidence_files);
  state.repo_analysis_doc_reads = ensureArray(state.repo_analysis_doc_reads);
  state.repo_analysis_source_reads = ensureArray(state.repo_analysis_source_reads);
  // Dedup key for repo_analysis focus budget consumption (prevents double-counting in allowAndExit).
  state.repo_analysis_focus_consumed_action_keys =
    ensureArray(state.repo_analysis_focus_consumed_action_keys).slice(-100);
  // Stable task hash for repo_analysis focus tracking (prevents last_user_query changes from invalidating hash)
  state.repo_analysis_focus_task_hash = state.repo_analysis_focus_task_hash || "";

  // Phase state tracking for repo_analysis flow enforcement (targeted grep first, then key file reads)
  state.repo_analysis_targeted_search_seen_by_task_hash = ensureObject(state.repo_analysis_targeted_search_seen_by_task_hash);
  state.repo_analysis_key_file_read_seen_by_task_hash = ensureObject(state.repo_analysis_key_file_read_seen_by_task_hash);

  state.recent_edit_blocks = ensureObject(state.recent_edit_blocks);

  // ===== edit pressure counters =====
  state.tools_after_edit_gap = ensureNumber(state.tools_after_edit_gap, 0);
  state.reads_after_edit_gap = ensureNumber(state.reads_after_edit_gap, 0);
  state.searches_after_edit_gap = ensureNumber(state.searches_after_edit_gap, 0);
  state.dependency_reads_after_edit_gap = ensureNumber(state.dependency_reads_after_edit_gap, 0);
  state.consecutive_non_edit_tools = ensureNumber(state.consecutive_non_edit_tools, 0);

  const rp = state.replace_policy_state;
  rp.recentSlices = ensureArray(rp.recentSlices).slice(-100);
  rp.lastReplaceFailed = Boolean(rp.lastReplaceFailed);
  rp.failedFile = String(rp.failedFile || "");
  rp.failedAt = String(rp.failedAt || "");
  rp.recoverySliceReady = Boolean(rp.recoverySliceReady);
  rp.recoverySliceReadyAt = ensureNumber(rp.recoverySliceReadyAt, 0);

  // ===== unified search policy state =====
  state.search_policy_state = ensureObject(state.search_policy_state);
  const sg = state.search_policy_state;

  sg.sessionSeenSearchKeys = ensureArray(sg.sessionSeenSearchKeys).slice(-500);
  sg.readRanges = ensureArray(sg.readRanges).slice(-500);
  sg.fullyReadFiles = ensureArray(sg.fullyReadFiles).slice(-200);

  sg.targetFiles = ensureArray(sg.targetFiles).slice(-100);
  sg.repoAnalysisFiles = ensureArray(sg.repoAnalysisFiles).slice(-100);
  sg.targetSymbols = ensureArray(sg.targetSymbols).slice(-120);
  sg.targetTests = ensureArray(sg.targetTests).slice(-80);

  sg.turnSearchCount = ensureNumber(sg.turnSearchCount, 0);
  sg.turnGlobalSearchCount = ensureNumber(sg.turnGlobalSearchCount, 0);
  sg.turnEmptySearchCount = ensureNumber(sg.turnEmptySearchCount, 0);
  sg.targetEvidenceScore = ensureNumber(sg.targetEvidenceScore, 0);

  return state;
}

function getSearchPolicyState(taskState) {
  const state = normalizeTaskState(taskState);
  return state.search_policy_state;
}

// ============================================================================
// Counter / Budget / Agent Budget state operations
// ============================================================================

function incCounter(state, key) {
  state.counters = state.counters || {};
  state.counters[key] = (state.counters[key] || 0) + 1;
  saveState(state);
  return state.counters[key];
}

function addBudget(state, key, value) {
  state.budget = state.budget || {};
  state.budget[key] = (state.budget[key] || 0) + value;
  saveState(state);
  return state.budget[key];
}

function getBudgetValue(state, key) {
  return state?.budget?.[key] || 0;
}

function ensureAgentBudgetState(state, agentKey) {
  state.agent_budgets = state.agent_budgets || {};

  const key = agentKey || "unknown_agent";

  if (!state.agent_budgets[key]) {
    state.agent_budgets[key] = {
      blocked_exploration_total: 0,
      blocked_by_kind: {},
      subagent_invoke_total: 0,
      restricted_narrow_read_total: 0,
      stopped: false,
      stop_reason: "",
      updated_at: ""
    };
  }

  return state.agent_budgets[key];
}

function markAgentExplorationStopped(state, agentKey, reason) {
  const agentBudget = ensureAgentBudgetState(state, agentKey);

  agentBudget.stopped = true;
  agentBudget.stop_reason = reason || "agent_budget_exceeded";
  agentBudget.stopped_at = new Date().toISOString();
  agentBudget.updated_at = new Date().toISOString();

  saveState(state);
}

function isAgentExplorationStopped(state, agentKey) {
  const agentBudget = ensureAgentBudgetState(state, agentKey);
  return Boolean(agentBudget.stopped);
}

function incAgentExplorationBlock(state, agentKey, kind) {
  const agentBudget = ensureAgentBudgetState(state, agentKey);

  agentBudget.blocked_exploration_total =
    (agentBudget.blocked_exploration_total || 0) + 1;

  agentBudget.blocked_by_kind = agentBudget.blocked_by_kind || {};
  agentBudget.blocked_by_kind[kind] =
    (agentBudget.blocked_by_kind[kind] || 0) + 1;

  agentBudget.updated_at = new Date().toISOString();

  saveState(state);

  return {
    total: agentBudget.blocked_exploration_total,
    current: agentBudget.blocked_by_kind[kind],
    agentKey
  };
}

function getAgentExplorationBlockTotal(state, agentKey) {
  const agentBudget = ensureAgentBudgetState(state, agentKey);
  return agentBudget.blocked_exploration_total || 0;
}

/**
 * Consume the pending_edit_commit_allow budget that was reserved during
 * edit_commit phase checks. Called only when the action passes all checks
 * and is finally allowed.
 * @param {object} taskState
 */
function markEditCommitAllowed(taskState) {
  const pending = taskState.pending_edit_commit_allow;
  if (!pending) return;

  if (pending.kind === "final_dependency_search") {
    taskState.final_dependency_search_budget = (taskState.final_dependency_search_budget ?? 2) - 1;
  } else if (pending.kind === "final_dependency_read") {
    taskState.final_dependency_read_budget = (taskState.final_dependency_read_budget ?? 2) - 1;
  }
  delete taskState.pending_edit_commit_allow;
}

/**
 * Consume enterprise flow budgets when the action is finally allowed.
 * @param {object} taskState
 * @param {object} flowDecision
 */
function markEnterpriseFlowAllowed(taskState, flowDecision) {
  if (!flowDecision || !flowDecision.allow) return;

  if (flowDecision.kind === "edit_recovery") {
    const budget = taskState.edit_recovery_read_budget ?? 1;
    if (budget > 0) {
      taskState.edit_recovery_read_budget = budget - 1;
      saveState(taskState);
    }
  }
}

module.exports = {
  computeTaskHash,
  sanitizeSessionId,
  setActiveSessionId,
  getStateFilePath,
  loadState,
  saveState,
  getPhaseState,
  getReplacePolicyState,
  getKnownFiles,
  getKnownSymbols,
  hasKnownFiles,
  hasKnownSymbols,
  hasRepoMap,
  normalizeFocusedCallChainState,
  normalizeTaskState,
  getSearchPolicyState,
  incCounter,
  addBudget,
  getBudgetValue,
  ensureAgentBudgetState,
  markAgentExplorationStopped,
  isAgentExplorationStopped,
  incAgentExplorationBlock,
  getAgentExplorationBlockTotal,
  markEditCommitAllowed,
  markEnterpriseFlowAllowed,
};
