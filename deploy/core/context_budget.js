"use strict";

// ============================================================================
// context_budget.js — Context Budget Controller (Phase 2)
// ============================================================================
// Per-session token budget state machine. The task starts with a fixed policy
// (from the Compression Policy Router), but enterprise tasks change risk while
// executing, so the controller reacts to accumulated context:
//
//   soft limit  -> escalate compression one tier (native -> assist -> aggressive)
//   hard limit  -> fallback to native context + force summarize (once)
//
// Token estimation is char-based (chars / 4) when explicit token counts are not
// available at the hook boundary. Everything is deterministic and explainable:
// each transition/fallback carries a reason and the token reading.
//
// Phase 3: per-taskClass budgets can be calibrated from history. Point
// CODE_GUARD_BUDGET_PROFILE at a budgets_profile.json (see
// calibrate_budgets.js); taskClass-specific budgets override mode defaults.
// ============================================================================

const fs = require("fs");

const MODE_ORDER = ["native", "assist", "aggressive"];

// Per-mode default budgets. Env overrides:
//   CODE_GUARD_BUDGET_SOFT / CODE_GUARD_BUDGET_HARD
const DEFAULT_BUDGETS = {
  native: { soft: 40000, hard: 80000 },
  assist: { soft: 60000, hard: 100000 },
  aggressive: { soft: 80000, hard: 120000 },
};

const EXPLORE_TOOLS = new Set([
  "read_file",
  "grep_search",
  "glob_search",
  "run_shell_command",
]);

const MAX_EVENTS = 50;

let profileCache = null;

function loadBudgetProfile(env) {
  const path = String((env || process.env).CODE_GUARD_BUDGET_PROFILE || "").trim();
  if (!path) return null;
  if (profileCache && profileCache.path === path) return profileCache.data;
  try {
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    profileCache = { path, data };
    return data;
  } catch (_e) {
    profileCache = { path, data: null };
    return null;
  }
}

function estimateTokens(chars) {
  const n = Number(chars) || 0;
  return Math.ceil(n / 4);
}

function resolveBudgetLimits(mode, env, taskClass) {
  const e = env || process.env;
  const base = DEFAULT_BUDGETS[mode] || DEFAULT_BUDGETS.aggressive;
  const profile = loadBudgetProfile(e);
  const profileEntry =
    profile && profile.budgets && profile.budgets[taskClass || ""]
      ? profile.budgets[taskClass]
      : null;
  const softRaw = Number(e.CODE_GUARD_BUDGET_SOFT);
  const hardRaw = Number(e.CODE_GUARD_BUDGET_HARD);
  const soft = Number.isFinite(softRaw) && softRaw > 0
    ? softRaw
    : profileEntry && profileEntry.soft > 0
      ? profileEntry.soft
      : base.soft;
  const hard = Number.isFinite(hardRaw) && hardRaw > 0
    ? hardRaw
    : profileEntry && profileEntry.hard > 0
      ? profileEntry.hard
      : base.hard;
  return { soft: Math.min(soft, hard), hard: Math.max(soft, hard) };
}

function escalateMode(mode) {
  const idx = MODE_ORDER.indexOf(mode);
  if (idx < 0) return "assist";
  return MODE_ORDER[Math.min(idx + 1, MODE_ORDER.length - 1)];
}

function createBudgetTracker(options) {
  const opts = options || {};
  const initialMode = opts.initialMode || "assist";
  const limits = resolveBudgetLimits(initialMode, opts.env, opts.taskClass);

  const state = {
    sessionId: opts.sessionId || "",
    taskClass: opts.taskClass || "unknown",
    initialPolicy: initialMode,
    mode: initialMode,
    budget: { soft: limits.soft, hard: limits.hard },
    current: {
      tokens: 0,
      explorationCount: 0,
      toolCalls: 0,
      readCalls: 0,
      limitedByBudget: 0,
    },
    softLimitReached: false,
    hardLimitReached: false,
    forcedSummarize: false,
    events: [],
  };

  function pushEvent(event) {
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) {
      state.events = state.events.slice(-MAX_EVENTS);
    }
  }

  return {
    state,

    current() {
      return JSON.parse(JSON.stringify(state));
    },

    /**
     * Record one tool call and return the events it triggered.
     * mode is the effective mode used for the call (transition attribution).
     */
    recordCall({ toolName, inputTokens, outputTokens, mode }) {
      const events = [];
      state.current.toolCalls += 1;
      if (EXPLORE_TOOLS.has(toolName)) {
        state.current.explorationCount += 1;
      }
      if (toolName === "read_file") {
        state.current.readCalls += 1;
      }
      state.current.tokens +=
        (Number(inputTokens) || 0) + (Number(outputTokens) || 0);

      if (!state.softLimitReached && state.current.tokens >= state.budget.soft) {
        state.softLimitReached = true;
        const from = state.mode;
        const to = escalateMode(from);
        if (to !== from) {
          state.mode = to;
          const event = {
            type: "mode_transition",
            from,
            to,
            reason: "soft_limit",
            tokens: state.current.tokens,
            at: new Date().toISOString(),
          };
          pushEvent(event);
          events.push(event);
        }
      }

      if (!state.hardLimitReached && state.current.tokens >= state.budget.hard) {
        state.hardLimitReached = true;
        state.forcedSummarize = true;
        state.mode = "native";
        const event = {
          type: "fallback",
          reason: "hard_limit",
          from: mode || state.mode,
          to: "native",
          tokens: state.current.tokens,
          at: new Date().toISOString(),
        };
        pushEvent(event);
        events.push(event);
      }

      return events;
    },

    noteLimitedByBudget() {
      state.current.limitedByBudget += 1;
    },
  };
}

// 硬限触发后注入一次性的收敛引导（force summarize / stop exploration）。
function hardLimitGuidance(state) {
  return (
    `[context-budget] hard limit reached (${state.current.tokens} tokens, ` +
    `budget ${state.budget.hard}). Stop further exploration; reuse existing ` +
    "evidence and finish with best effort."
  );
}

module.exports = {
  MODE_ORDER,
  DEFAULT_BUDGETS,
  EXPLORE_TOOLS,
  estimateTokens,
  loadBudgetProfile,
  resolveBudgetLimits,
  escalateMode,
  createBudgetTracker,
  hardLimitGuidance,
};
