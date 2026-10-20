// ============================================================================
// guard_core/constants.js — Pure constants for pre_tool_policy_hook.js
// ============================================================================
// All constants here are "pure": they do NOT depend on path, fs, os, or any
// runtime function. Path-related constants (BASE_DIR, HOOK_DIR, STATE_FILE, etc.)
// remain in the main hook file.
// ============================================================================

const SEARCH_POLICY = {
  maxSearchPerTurn: 8,
  maxGlobalSearchPerTurn: 2,
  maxEmptySearchPerTurn: 0,
  broadQueryMaxTerms: 3,
  targetHitMinScore: 3,

  maxBroadSearchPerTurn: 3,
  maxOrSearchPerTurn: 2,
  maxSearchAfterTargetEvidence: 4,
};

const EXPLORATION_GUARD = {
  // Context pressure
  highContextRatio32k: 0.75,
  hardContextRatio32k: 1.0,

  // Search budget
  maxSearchInExplore: 8,
  maxSearchInFocus: 4,
  maxSearchInEdit: 2,

  maxBroadSearchInExplore: 3,
  maxBroadSearchInFocus: 1,
  maxBroadSearchInEdit: 0,

  // Query shape
  maxOrTermsForSpecificSearch: 3,
  minSpecificTokenLength: 4,

  // Scope shape
  maxBroadScopeDepthAfterRoot: 1,
  maxFocusScopeDepthAfterRoot: 2,

  // High context behavior
  maxSearchAfterHighContext: 1,
  allowExactSearchAfterHighContext: true,
};

const MAX_READ_FILE_CHARS = 8000;

// ===== Context budget / task mode =====

const MAX_PARTIAL_READ_LINES = 120;
const EXPLORE_MAX_SLICE_LINES = 150;
const FOCUS_MAX_SLICE_LINES = 100;
const EDIT_MAX_SLICE_LINES = 60;
const EDIT_RECOVERY_MAX_SLICE_LINES = 120;
const MAX_REPLACE_LINES = 60;
const MAX_REPLACE_CHARS = 5000;

const READ_POLICY_LIMITS = {
  focusMaxLinesPerFile: 220,
  editMaxLinesPerFile: 180,
  overlapBlockRatio: 0.55,
  overlapWarnOnce: true,
};

const MAX_NATIVE_REPLACE_LINES = 40;
const MAX_NATIVE_REPLACE_CHARS = 3500;
const MAX_REASON_CHARS = 600;

const EVIDENCE_POLICY = {
  specMaxLines: 80,
  productionCodeMaxLines: 180,
  testMaxLines: 220,
  minProductionEvidenceForNoChange: 2,
  maxExactEvidenceSearches: 24,
};

const REPOMAP_LIMITS = {
  maxDepth: 4,
  maxFilesPerDir: 12,
  maxChars: 6000,
  allowRefreshAfterMs: 10 * 60 * 1000,
};

const RECENT_SLICE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// =========================================================
// Repo analysis focus budget (after structure summary is done)
// =========================================================
const REPO_ANALYSIS_FOCUS_LIMITS = {
  maxTargetedSearch: 4,
  maxKeyFileReads: 3,
  maxDocReads: 1,
  maxSourceReads: 0,
  maxShallowLists: 1,
  maxTotalReadLines: 420,
  maxSingleKeyReadLines: 100,
  maxSingleDocReadLines: 80,
  maxSingleSourceReadLines: 80,
};

// =========================================================
// Repo analysis profiles with per-profile budget limits
// =========================================================
const REPO_ANALYSIS_PROFILES = {
  OVERVIEW: "repo_analysis_overview",
  DEEP_DIVE: "repo_analysis_deep_dive",
  DOC_ANALYSIS: "repo_analysis_doc_analysis",
};

const REPO_ANALYSIS_PROFILE_LIMITS = {
  [REPO_ANALYSIS_PROFILES.OVERVIEW]: {
    maxTargetedSearch: 4,
    maxKeyFileReads: 3,
    maxDocReads: 1,
    maxSourceReads: 0,
    maxShallowLists: 1,
    maxTotalReadLines: 260,
    maxSingleKeyReadLines: 80,
    maxSingleDocReadLines: 60,
    maxSingleSourceReadLines: 60,
  },

  [REPO_ANALYSIS_PROFILES.DEEP_DIVE]: {
    maxTargetedSearch: 6,
    maxKeyFileReads: 3,
    maxDocReads: 1,
    maxSourceReads: 2,
    maxShallowLists: 1,
    maxTotalReadLines: 420,
    maxSingleKeyReadLines: 100,
    maxSingleDocReadLines: 80,
    maxSingleSourceReadLines: 100,
  },

  [REPO_ANALYSIS_PROFILES.DOC_ANALYSIS]: {
    maxTargetedSearch: 5,
    maxKeyFileReads: 2,
    maxDocReads: 3,
    maxSourceReads: 0,
    maxShallowLists: 1,
    maxTotalReadLines: 420,
    maxSingleKeyReadLines: 80,
    maxSingleDocReadLines: 120,
    maxSingleSourceReadLines: 60,
  },
};

// =========================================================
// Generic directory exploration guard
// =========================================================

const MAX_READ_FOLDER_ITEMS = 12;
const ROOT_NEAR_DEPTH = 2;
const MAX_ROOT_NEAR_ITEMS = 6;

const MAX_ITEMS_AFTER_REPOMAP = 6;

// Per-agent / per-subagent budget.
const MAX_BLOCKED_EXPLORATION_CALLS_PER_AGENT = 8;
const MAX_SUBAGENT_INVOKE_CALLS_PER_AGENT = 2;

const TASK_MODES = {
  CODE_FIX: "code_fix",
  SPEC_TO_CODE: "spec_to_code",
  TEST_DEBUG: "test_debug",
  FOCUSED_CODE_ANALYSIS: "focused_code_analysis",
  REPO_ANALYSIS: "repo_analysis",
  DEFAULT: "default"
};

const AGENT_POLICIES = {
  default: {
    allow_shallow_directory_explore: true,

    max_read_folder_calls: 6,
    max_read_folder_after_repomap: 3,
    max_blocked_exploration_calls: 10,

    max_direct_file_chars: 8000,
    max_spec_to_code_direct_read_chars: 2000,
    max_partial_read_lines: 120,
  },

  [TASK_MODES.REPO_ANALYSIS]: {
    max_read_folder_calls: 10,
    max_read_folder_after_repomap: 5,
    max_blocked_exploration_calls: 14,
    max_direct_file_chars: 8000,
  },

  [TASK_MODES.SPEC_TO_CODE]: {
    max_read_folder_calls: 6,
    max_read_folder_after_repomap: 3,
    max_blocked_exploration_calls: 10,
    max_direct_file_chars: 8000,
    max_spec_to_code_direct_read_chars: 2000,
  },

  [TASK_MODES.CODE_FIX]: {
    max_read_folder_calls: 4,
    max_read_folder_after_repomap: 2,
    max_blocked_exploration_calls: 8,
    max_direct_file_chars: 8000,
  },

  [TASK_MODES.TEST_DEBUG]: {
    max_read_folder_calls: 4,
    max_read_folder_after_repomap: 2,
    max_blocked_exploration_calls: 8,
    max_direct_file_chars: 8000,
  },

  [TASK_MODES.FOCUSED_CODE_ANALYSIS]: {
    max_read_folder_calls: 4,
    max_read_folder_after_repomap: 2,
    max_blocked_exploration_calls: 8,
    max_direct_file_chars: 2000,
    max_partial_read_lines: 120,
  },

  CODE_REVIEW: {
    max_read_folder_calls: 4,
    max_read_folder_after_repomap: 2,
    max_blocked_exploration_calls: 8,
    max_direct_file_chars: 8000,
  }
};

const SPEC_TEXT_KEYWORDS = [
  "spec",
  "requirement",
  "requirements",
  "需求",
  "设计",
  "architecture"
];

const COMPACT_REASON_CHARS = 600;
const DEBUG_REASON_CHARS = 1500;

const ACTION_RISK = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
};

const ACTION_GAIN = {
  NONE: "none",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
};

const COMMON_CODE_WORDS = new Set([
  "class", "struct", "enum", "typedef", "interface",
  "include", "define", "static", "using",
  "void", "int", "long", "short", "char", "bool",
  "return", "error", "init", "create", "delete",
  "update", "get", "set", "read", "write",
  "test", "tests", "case"
]);

const FOCUSED_CALL_CHAIN_COMPLETE = "FOCUSED_CALL_CHAIN_COMPLETE";

const REPLACE_EVIDENCE_TTL_MS = 15 * 60 * 1000;
const REPLACE_RECOVERY_EVIDENCE_TTL_MS = 3 * 60 * 1000;

const HELPER_ARG_ALLOWLIST = {
  "smart_read_file.py": new Set([
    "--query",
    "--query-file",
    "--mode"
  ]),

  "spec_read_file.py": new Set([
    "--query-file",
    "--contract"
  ]),

  "repo_map.py": new Set([
    "--max-depth",
    "--max-files-per-dir",
    "--max-chars",
    "--ignore-dir",
    "--focus"
  ]),

  "read_file_slice.py": new Set([
    // Positional: read_file_slice.py "<file>" <start> <end>
    // Flag-based: read_file_slice.py "<file>" --start-line <N> --end-line <N>
    "--start-line",
    "--end-line"
  ]),

  "safe_replace.py": new Set([
    // Positional only: safe_replace.py "<replace_json>"
    // No flags are supported here.
  ])
};

module.exports = {
  SEARCH_POLICY,
  EXPLORATION_GUARD,
  MAX_READ_FILE_CHARS,
  MAX_PARTIAL_READ_LINES,
  EXPLORE_MAX_SLICE_LINES,
  FOCUS_MAX_SLICE_LINES,
  EDIT_MAX_SLICE_LINES,
  EDIT_RECOVERY_MAX_SLICE_LINES,
  MAX_REPLACE_LINES,
  MAX_REPLACE_CHARS,
  READ_POLICY_LIMITS,
  MAX_NATIVE_REPLACE_LINES,
  MAX_NATIVE_REPLACE_CHARS,
  MAX_REASON_CHARS,
  EVIDENCE_POLICY,
  REPOMAP_LIMITS,
  RECENT_SLICE_TTL_MS,
  REPO_ANALYSIS_FOCUS_LIMITS,
  REPO_ANALYSIS_PROFILES,
  REPO_ANALYSIS_PROFILE_LIMITS,
  MAX_READ_FOLDER_ITEMS,
  ROOT_NEAR_DEPTH,
  MAX_ROOT_NEAR_ITEMS,
  MAX_ITEMS_AFTER_REPOMAP,
  MAX_BLOCKED_EXPLORATION_CALLS_PER_AGENT,
  MAX_SUBAGENT_INVOKE_CALLS_PER_AGENT,
  TASK_MODES,
  AGENT_POLICIES,
  SPEC_TEXT_KEYWORDS,
  COMPACT_REASON_CHARS,
  DEBUG_REASON_CHARS,
  ACTION_RISK,
  ACTION_GAIN,
  COMMON_CODE_WORDS,
  FOCUSED_CALL_CHAIN_COMPLETE,
  REPLACE_EVIDENCE_TTL_MS,
  REPLACE_RECOVERY_EVIDENCE_TTL_MS,
  HELPER_ARG_ALLOWLIST,
}; 
