// OpenCode V1 plugin entry for the TASCO v0.1 deploy closure.
//
// Thin adapter ONLY. Responsibilities:
//   1. normalize opencode `tool.execute.before/after` events,
//   2. reuse the frozen deploy adapters/core/hooks (single source of truth),
//   3. translate decisions / compression results back to opencode semantics.
//
// No TASCO policy lives here: Router / Eligibility Boundary / Diagnostic
// primitive / Apply Policy / Quality Gate / Fallback policy are all in the
// frozen deploy modules. The before/after behavior intentionally mirrors the
// shipped `adapters/claude_bridge.js` (auto-canary v1a gating, qualification
// policy, guard/rescue), so all supported agents share one observable path.
//
// Layout: the plugin is copied into a project's `.opencode/plugins/` while the
// deploy closure stays at a fixed location (e.g. D:\tasco-deploy). The deploy
// root is resolved from CODE_GUARD_DEPLOY_ROOT, then CODE_GUARD_HOOK_DIR/..,
// then the plugin's own parent (running directly from the deploy package).

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const AGENT_OPENCODE = "opencode";
const USER_QUERY_TTL_MS = 5 * 60 * 1000;
const userQueryCache = new Map();

function flagOn(name) {
  return String(process.env[name] || "").trim() === "1";
}

function deployRoot() {
  const envRoot = String(process.env.CODE_GUARD_DEPLOY_ROOT || "").trim();
  if (envRoot) return path.resolve(envRoot);
  const hookDir = String(process.env.CODE_GUARD_HOOK_DIR || "").trim();
  if (hookDir) return path.resolve(hookDir, "..");
  return path.resolve(import.meta.dirname, "..");
}

const DEPLOY_ROOT = deployRoot();

function requireDeploy(rel) {
  return require(path.join(DEPLOY_ROOT, rel));
}

const { runUnifiedAfter } = requireDeploy(path.join("adapters", "unified_runtime.js"));
const { createAutoCanaryObserver } = requireDeploy(path.join("adapters", "claude_observer.js"));
const { classifyToolAccess } = requireDeploy(path.join("adapters", "qualification_policy.js"));
const {
  shouldAdoptCompression,
  rescueCompression,
} = requireDeploy(path.join("core", "fallback.js"));
const { mapOpenCodeToolName } = requireDeploy(path.join("adapters", "opencode_tool_map.js"));
const { extractReplacementText } = requireDeploy(path.join("adapters", "opencode_after.js"));
const {
  capabilityForStrategy,
  resolveCapabilityDecision,
  resolveCapabilityOptions,
  loadCapabilityOptions,
} = requireDeploy(path.join("core", "capability_options", "index.js"));

// ---------------- telemetry (mirrors claude_bridge) ----------------

function baseDir() {
  return (
    process.env.CODE_GUARD_BASE_DIR ||
    path.join(process.cwd(), ".code-guard")
  );
}

function telemetryFile() {
  return path.join(baseDir(), "context_budget", "claude_auto_canary.jsonl");
}

function hookMarkerFile() {
  return path.join(baseDir(), "hook_invoked.jsonl");
}

function appendLine(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`, "utf8");
  } catch (_e) {}
}

function appendEvent(ev) {
  appendLine(telemetryFile(), JSON.stringify(ev));
}

function appendHookMarker(sessionId, toolName, raw) {
  appendLine(
    hookMarkerFile(),
    JSON.stringify({
      event: "hook_invoked",
      hook: "AfterTool",
      session_id: String(sessionId || ""),
      tool_name: String(toolName || ""),
      resp_type: typeof raw,
      at: new Date().toISOString(),
    })
  );
}

// ---------------- user query cache (chat.message) ----------------

function getUserQuery(sessionID) {
  if (!sessionID) return undefined;
  const entry = userQueryCache.get(sessionID);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > USER_QUERY_TTL_MS) {
    userQueryCache.delete(sessionID);
    return undefined;
  }
  return entry.text;
}

function cacheUserQuery(sessionID, text) {
  if (!sessionID || !text) return;
  userQueryCache.set(sessionID, { text, ts: Date.now() });
}

// ---------------- plugin ----------------

export const GovernancePlugin = async (ctx) => {
  return {
    "chat.message": async (input, output) => {
      try {
        const message = output && output.message;
        if (!message || message.role !== "user") return;
        const sessionID = message.sessionID || (input && input.sessionID) || "";
        if (!sessionID) return;
        const parts = (output && output.parts) || [];
        const text = parts
          .filter(
            (part) =>
              part &&
              part.type === "text" &&
              typeof part.text === "string" &&
              part.text.trim()
          )
          .map((part) => part.text.trim())
          .join("\n")
          .slice(0, 1000);
        if (text) cacheUserQuery(sessionID, text);
      } catch (_e) {}
    },

    "tool.execute.before": async (input, output) => {
      if (flagOn("CODE_GUARD_BEFORE_DISABLED")) return;
      const toolName = String((input && input.tool) || "");
      const args = (output && output.args) || (input && input.args) || {};
      if (process.env.CODE_GUARD_QUALIFICATION_POLICY === "1") {
        const bounded = process.env.CODE_GUARD_BOUNDED === "1";
        const d = classifyToolAccess({ toolName, toolInput: args, bounded });
        appendEvent({
          type: "qualification_policy",
          sessionId: String((input && input.sessionID) || ""),
          verdict: d.verdict,
          category: d.category,
          reason: d.reason,
          toolName,
          command: String(d.command || "").slice(0, 300),
          bounded,
          at: new Date().toISOString(),
        });
        if (d.verdict === "deny") {
          throw new Error(d.reason || "BLOCKED_BY_CODE_GUARD");
        }
      }
      // Auto-canary v1a lab condition is identical to claude_bridge:
      // before governance off -> approve passthrough.
    },

    "tool.execute.after": async (input, output, ctx) => {
      const sessionId = String((input && input.sessionID) || "");
      const toolName = mapOpenCodeToolName(input && input.tool);
      const args = (input && input.args) || (output && output.args) || {};
      const raw =
        typeof output.output === "string"
          ? output.output
          : JSON.stringify(output.output || "");

      appendHookMarker(sessionId, toolName, raw);

      // Same gating as claude_bridge.handlePostToolUse: without the canary
      // flag the bridge is native passthrough.
      if (process.env.CODE_GUARD_AUTO_CANARY_V1A !== "1") return;

      const prompt =
        getUserQuery(sessionId) || process.env.CODE_GUARD_CLAUDE_PROMPT || "";
      const observer = createAutoCanaryObserver({ sessionId, prompt });
      const payload = { tool_name: toolName, tool_input: args };
      const obs = observer.observe(payload, raw);
      const capId = capabilityForStrategy(obs.selected);
      const capDecision = capId
        ? resolveCapabilityDecision({
            capabilityId: capId,
            resolvedOptions: resolveCapabilityOptions(loadCapabilityOptions()),
          })
        : null;

      appendEvent({
        type: "auto_canary_v1a",
        sessionId,
        selected_capability: obs.selected,
        applied_capability: obs.applied,
        intervention_count: observer.state.interventionCount,
        capability_sequence: [...observer.state.capabilitySequence],
        fallback_reason:
          obs.selected === "diagnostic_semantic" && obs.applied === "native"
            ? "diagnostic_not_current_eligible_output"
            : null,
        reason:
          obs.selected === "diagnostic_semantic"
            ? "large semantic diagnostic/log evidence with root-cause intent"
            : "no rule matched - default native",
        confidence: obs.selected === "diagnostic_semantic" ? "high" : "medium",
        toolName: obs.tool,
        tool_family: obs.family,
        originalLength: obs.size,
        requested_experiment: "internal_canary_v1",
        resolved_apply_policy: "current",
        subagent_enabled: false,
        diagnostic_eligibility_boundary_enabled: true,
        prompt_language: obs.language,
        matched_intents: obs.matchedIntents,
        ...(obs.matchedPatterns ? { matched_patterns: obs.matchedPatterns } : {}),
        capability_id: capId,
        capability_status: capDecision ? capDecision.configured_status : null,
        capability_enabled: capDecision ? capDecision.enabled : null,
        capability_reason: capDecision ? capDecision.reason : null,
        distinct_files: observer.state.files.length,
        rejection_reason: null,
        at: new Date().toISOString(),
      });

      if (obs.applied !== "diagnostic_semantic") return;
      // Capability gate (Phase 2A): only diagnostic.semantic_compression is
      // wired; default (auto) keeps the v0.1 execution path identical.
      if (capDecision && !capDecision.enabled) return;

      let candidate = null;
      try {
        const result = runUnifiedAfter(input, output, ctx, {
          hookDir: process.env.CODE_GUARD_HOOK_DIR,
          agent: AGENT_OPENCODE,
        });
        const hso = (result && result.hookSpecificOutput) || {};
        if (hso.updatedToolOutput !== undefined) {
          candidate = extractReplacementText(hso.updatedToolOutput);
        }
        if (candidate === null && result && result.changes && typeof result.changes.output === "string") {
          candidate = result.changes.output;
        }
        if (candidate === null && typeof output.output === "string") {
          candidate = output.output;
        }
      } catch (_e) {
        output.output = raw; // fail-open: keep original context
        return;
      }

      const compressed = candidate;
      if (!compressed) {
        output.output = raw;
        return;
      }

      const guard = shouldAdoptCompression({
        originalLength: raw.length,
        compressedLength: compressed.length,
        originalText: raw,
        compressedText: compressed,
      });
      const rescue = rescueCompression({
        raw,
        compressed,
        guard,
        minCoverage: 0.5,
      });
      if (!rescue.adopted) {
        output.output = raw; // keep native context
        return;
      }
      const adoptedOutput = rescue.output || compressed;
      output.output = adoptedOutput;
      appendEvent({
        type: "compression",
        sessionId,
        toolName: obs.tool,
        tool_family: obs.family,
        originalLength: raw.length,
        compressedLength: adoptedOutput.length,
        ratio: raw.length ? adoptedOutput.length / raw.length : null,
        tokenReduction: raw.length ? 1 - adoptedOutput.length / raw.length : null,
        coverage: guard.coverage,
        confidence: guard.confidence,
        rescued: Boolean(rescue.output),
        at: new Date().toISOString(),
      });
    },
  };
};

// V1 plugin module: file plugins must default-export an object with `id`.
export default {
  id: "code-guard",
  server: GovernancePlugin,
};
