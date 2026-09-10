"use strict";

// Claude Code hook bridge（统一 Agent Adapter 的 Claude 侧）。
// 只负责生命周期与 JSON 契约：
//   PreToolUse  -> canonical pre-tool event（v1a 下 before 治理关闭 -> approve）
//   PostToolUse -> canonical after-tool event -> 冻结核心 post hook -> result
//   Bash/Read/Grep/Edit 等只做 tool normalization（canonical_tools）
//   不认识的 payload/schema -> fail-open Native（输出 {}）
// 不在此文件内实现任何 TASCO 策略；router / guard / rescue / primitive 全部
// 复用冻结模块。

const fs = require("fs");
const path = require("path");

const { AGENT_CLAUDE_CODE } = require("./agent_runtime");
const { normalizeAfter } = require("./unified_payload");
const { runUnifiedAfter } = require("./unified_runtime");
const { createAutoCanaryObserver } = require("./claude_observer");
const { createClaudeNativeObservability } = require("./claude_native_observability");
const { createTerminalStateCompressor, classifyCommand } = require("../hooks/post_tool/terminal_state");
const {
  foldCommand,
  buildFingerprint,
  sameCommand,
  tryCompressValidationDelta,
} = require("../hooks/post_tool/validation_delta");
const {
  parseFailureCarrier,
  isDiagnosticEligibleFailureCarrier,
} = require("../hooks/post_tool/failure_carrier");
const {
  isAutoCarrierEligible,
  buildCarrierRewrite,
  parseCarrierWrapper,
} = require("../hooks/pre_tool/failure_carrier_auto");
const { arbitrate, markApplied, ARBITRATION_VERSION } = require("../core/arbitration_runtime");
const { classifyToolAccess } = require("./qualification_policy");
const {
  shouldAdoptCompression,
  rescueCompression,
} = require(path.join(__dirname, "..", "core", "fallback.js"));
const {
  capabilityForStrategy,
  resolveCapabilityDecision,
  resolveCapabilityOptions,
  loadCapabilityOptions,
} = require(path.join(__dirname, "..", "core", "capability_options", "index.js"));
const searchGuidanceModulePath = path.join(
  process.env.CODE_GUARD_HOOK_DIR || path.join(__dirname, "..", "hooks"),
  "pre_tool",
  "search_guidance.js"
);
const {
  buildSearchGuidance,
  buildProbeMarker,
} = require(searchGuidanceModulePath);
// Line-6 任务驱动 Read：冻结分类器（任务 → 策略映射）。
const readStrategyModulePath = path.join(
  process.env.CODE_GUARD_HOOK_DIR || path.join(__dirname, "..", "hooks"),
  "pre_tool",
  "read_strategy.js"
);
const { classifyReadTask } = require(readStrategyModulePath);

function extractText(response) {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return "";
  // Claude Code Read: { type, file: { filePath, content, ... } }
  if (
    response.file &&
    typeof response.file === "object" &&
    typeof response.file.content === "string"
  ) {
    return response.file.content;
  }
  // Claude Code Read（旧形状）: { type, file }（file 为内容文本）
  if (typeof response.file === "string") return response.file;
  // Claude Code Glob: { filenames, ... }
  if (Array.isArray(response.filenames)) return response.filenames.join("\n");
  // Claude Code Bash: { stdout, stderr, ... }
  if (typeof response.stdout === "string") {
    return [response.stdout, response.stderr].filter(Boolean).join("\n");
  }
  if (typeof response.content === "string") return response.content;
  if (typeof response.output === "string") return response.output;
  if (Array.isArray(response.content)) {
    return response.content
      .map((block) => (typeof block === "string" ? block : block && block.text))
      .filter((v) => typeof v === "string")
      .join("\n");
  }
  return "";
}

// Claude Code PostToolUse delivery contract (verified by transport probes
// against 2.1.263, 2026-09-07): hookSpecificOutput must carry
// hookEventName="PostToolUse" AND updatedToolOutput must mirror the original
// tool_response object shape with only the text-bearing field replaced.
// A bare string or { content: ... } wrapper is silently ignored and the model
// keeps receiving the raw tool output. Ordering mirrors the frozen
// output_transport.buildUpdatedToolOutput.
function buildDeliveredToolOutput(originalResponse, replacementText) {
  if (!originalResponse || typeof originalResponse !== "object" || Array.isArray(originalResponse)) {
    return { content: replacementText };
  }
  let updated;
  try {
    updated = structuredClone(originalResponse);
  } catch (_e) {
    updated = JSON.parse(JSON.stringify(originalResponse));
  }
  if (typeof updated.content === "string") {
    updated.content = replacementText;
    if (typeof updated.numLines === "number") updated.numLines = replacementText.split(/\r?\n/).length;
    return updated;
  }
  if (typeof updated.stdout === "string") {
    updated.stdout = replacementText;
    return updated;
  }
  if (updated.file && typeof updated.file === "object" && typeof updated.file.content === "string") {
    updated.file.content = replacementText;
    if (typeof updated.file.numLines === "number") updated.file.numLines = replacementText.split(/\r?\n/).length;
    return updated;
  }
  if (typeof updated.output === "string") {
    updated.output = replacementText;
    return updated;
  }
  if (Array.isArray(updated.content)) {
    const textBlock = updated.content.find(
      (block) => block && typeof block === "object" && typeof block.text === "string"
    );
    if (textBlock) {
      textBlock.text = replacementText;
      return updated;
    }
  }
  return { ...updated, stdout: replacementText };
}

function deliveredEnvelope(originalResponse, replacementText) {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: buildDeliveredToolOutput(originalResponse, replacementText),
    },
  };
}

function telemetryFile() {
  const base = process.env.CODE_GUARD_BASE_DIR || path.join(process.cwd(), ".code-guard");
  return path.join(base, "context_budget", "claude_auto_canary.jsonl");
}

// Validation Delta cross-invocation state: each PostToolUse hook is a fresh
// process, so the previous test-run fingerprint persists per session in its
// own file (isolated from the observer state claude_state_<session>.json).
function validationStateFile(sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(
    process.env.CODE_GUARD_BASE_DIR || path.join(process.cwd(), ".code-guard"),
    "context_budget",
    `claude_validation_${safe}.json`
  );
}

// Fingerprint state is keyed by the folded command (one recent run per
// command): alternating test commands under one session never clobber each
// other's baseline. File shape v2: { v: 2, runs: { [foldedCommand]: fp } }.
function loadValidationState(sessionId, command) {
  try {
    const parsed = JSON.parse(fs.readFileSync(validationStateFile(sessionId), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.v !== 2) return null; // legacy single-slot shape: not comparable
    const key = foldCommand(command);
    return parsed.runs && parsed.runs[key] ? parsed.runs[key] : null;
  } catch (_e) {
    return null;
  }
}

function saveValidationState(sessionId, command, fp) {
  try {
    const f = validationStateFile(sessionId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let stored = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
      if (parsed && parsed.v === 2 && parsed.runs) stored = parsed.runs;
    } catch (_e) {}
    const key = foldCommand(command);
    const runs = Object.assign({}, stored, { [key]: fp });
    fs.writeFileSync(f, JSON.stringify({ v: 2, runs }, null, 2), "utf8");
  } catch (_e) {} // fail-open: state persistence never blocks delivery
}

function appendEvent(ev) {
  try {
    const f = telemetryFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${JSON.stringify(ev)}\n`, "utf8");
  } catch (_e) {}
}

function handlePreToolUse(event) {
  const sessionId = String(event.session_id || "");
  // Qualification Auto-Approval Policy (bridge layer only). When enabled, it
  // classifies each PreToolUse: local read/test/analysis -> approve; bounded
  // external exploration / dangerous / mutating / unknown -> deny. Decisions
  // are emitted as telemetry so the live runner can print them in real time.
  if (process.env.CODE_GUARD_QUALIFICATION_POLICY === "1") {
    const bounded = process.env.CODE_GUARD_BOUNDED === "1";
    const toolName = String(event.tool_name || event.toolName || "");
    const toolInput = event.tool_input || {};
    const d = classifyToolAccess({
      toolName,
      toolInput,
      bounded,
    });
    appendEvent({
      type: "qualification_policy",
      sessionId: String(event.session_id || ""),
      verdict: d.verdict,
      category: d.category,
      reason: d.reason,
      toolName,
      command: String(d.command || "").slice(0, 300),
      bounded,
      at: new Date().toISOString(),
    });
    if (d.verdict === "deny") {
      return { decision: "deny", reason: d.reason };
    }
  }
  // P1-S2b Auto Failure Carrier (flag-gated, default off = Native). Rewrites
  // an eligible test/build Bash command into the exit-0 carrier shim so a real
  // failure reaches PostToolUse as a FAILURE-CARRIER-CONTRACT-V1 report.
  // Fail-closed: everything not matching the frozen simple test/build form is
  // executed legacy. A1 shape verified on Claude Code 2.1.263 (10/10): the
  // rewrite response carries only hookSpecificOutput.updatedInput.command.
  if (process.env.CODE_GUARD_FAILURE_CARRIER_AUTO === "1") {
    const toolName = String(event.tool_name || event.toolName || "");
    const cmd = String((event.tool_input || {}).command || "");
    const carrierEligibility = isAutoCarrierEligible({ toolName, command: cmd });
    if (carrierEligibility.eligible) {
      const hookDir =
        process.env.CODE_GUARD_HOOK_DIR || path.join(__dirname, "..", "hooks");
      const rewrite = buildCarrierRewrite({ command: cmd, hookDir });
      appendEvent({
        type: "failure_carrier_auto_rewrite",
        sessionId,
        toolName,
        original_command: cmd,
        rewritten_command: rewrite.rewrittenCommand,
        kind: carrierEligibility.kind,
        at: new Date().toISOString(),
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { command: rewrite.rewrittenCommand },
        },
      };
    }
    appendEvent({
      type: "failure_carrier_auto_skip",
      sessionId,
      toolName,
      command: cmd.slice(0, 200),
      reason: carrierEligibility.reason,
      at: new Date().toISOString(),
    });
  }
  // v1a lab 条件与 opencode 一致：before 治理关闭 -> approve 透传。
  return { decision: "approve" };
}

// Line-6 Read Runtime Integration（flag-gated，默认 off = Native）。
// UserPromptSubmit 腿：把任务文本按冻结映射（classifyReadTask）分类并持久化
// 到会话状态文件，供 PostToolUse read leg / policy hook fallback 消费。
// delivery-neutral：不注入 guidance、不改 tool_input，仅记录遥测。
function readTaskStateFile(sessionId) {
  const safe = String(sessionId || "unknown")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 80);
  return path.join(
    process.env.CODE_GUARD_BASE_DIR || path.join(process.cwd(), ".code-guard"),
    "context_budget",
    `claude_read_task_${safe}.json`
  );
}

function persistReadTaskClassification(event) {
  try {
    if (process.env.CODE_GUARD_READ_COMPRESSION !== "1") return;
    const prompt = String(event.prompt || event.message || event.text || "");
    const sessionId = String(event.session_id || "");
    const task = classifyReadTask(prompt);
    const f = readTaskStateFile(sessionId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(
      f,
      JSON.stringify(
        {
          task_class: task.task_class,
          strategy: task.strategy,
          prompt,
          signals: task.signals,
          at: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );
    appendEvent({
      type: task.suppressed ? "read_strategy_native" : "read_strategy_selected",
      sessionId,
      task_class: task.task_class,
      strategy: task.strategy,
      reason: task.reason,
      at: new Date().toISOString(),
    });
  } catch (_e) {} // fail-open: classification persistence never blocks delivery
}

// P0-A2 Search Guidance transport（2026-08-27 已验证，2026-08-31 恢复）。
// UserPromptSubmit -> buildSearchGuidance -> hookSpecificOutput.additionalContext。
// 只在 CODE_GUARD_SEARCH_GUIDANCE=1（或 probe=A）时注入；否则返回
// { stopReason: "allow" }（当前调用不变）。不 deny、不改 tool_input。
function handleUserPromptSubmit(event) {
  persistReadTaskClassification(event);
  const probe = process.env.CODE_GUARD_SEARCH_GUIDANCE_PROBE;
  if (probe === "a") {
    const marker = buildProbeMarker("a");
    appendEvent({
      type: "search_guidance_probe_a",
      sessionId: String(event.session_id || ""),
      at: new Date().toISOString(),
    });
    return {
      hookSpecificOutput: { additionalContext: marker },
      stopReason: "allow",
    };
  }
  if (process.env.CODE_GUARD_SEARCH_GUIDANCE !== "1") {
    return { stopReason: "allow" };
  }
  // Line-5 精准代码搜索（generalized AUTO, 2026-09-08）：CODE_GUARD_SEARCH_
  // GUIDANCE_AUTO=1 时 eligibility 只由搜索意图决定（frozen classifier 的
  // DISCOVERY/FILTER 正区），仓库白名单不再是 eligibility 的一部分。未设 AUTO
  // 时保留 limited-auto pilot 行为（白名单照常生效），向后逐字节兼容。
  const searchGuidanceAuto = process.env.CODE_GUARD_SEARCH_GUIDANCE_AUTO === "1";
  // Repo identity: the event's cwd is authoritative (in real sessions it equals
  // the hook process cwd); basename is the repo name used by the allowlist.
  const repoName = path.basename(String(event.cwd || process.cwd()));
  // Limited-auto pilot allowlist（2026-08-31 收口）：生产启用只允许
  // 试点仓列表（CODE_GUARD_SEARCH_GUIDANCE_PILOTS）。列表为空 = 实验模式
  // 放行（lab / regression），保持既有行为不变。
  const pilots = String(process.env.CODE_GUARD_SEARCH_GUIDANCE_PILOTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!searchGuidanceAuto && pilots.length) {
    if (!pilots.includes(repoName)) {
      appendEvent({
        type: "search_guidance_pilot_skipped",
        sessionId: String(event.session_id || ""),
        repo: repoName,
        pilots,
        at: new Date().toISOString(),
      });
      return { stopReason: "allow" };
    }
  }
  const prompt = String(event.prompt || event.message || event.text || "");
  if (!prompt) return { stopReason: "allow" };
  let g;
  try {
    g = buildSearchGuidance({ prompt });
  } catch (_e) {
    return { stopReason: "allow" };
  }
  if (!g.suppressed && g.text) {
    appendEvent({
      type: "search_guidance",
      sessionId: String(event.session_id || ""),
      intent: g.intent,
      confidence: g.confidence,
      chars: g.chars,
      mode: searchGuidanceAuto ? "auto" : "pilot",
      repo: repoName,
      at: new Date().toISOString(),
    });
    return {
      hookSpecificOutput: { additionalContext: g.text },
      stopReason: "allow",
    };
  }
  if (g.suppressed && g.suppressReason) {
    appendEvent({
      type: "search_guidance_suppressed",
      sessionId: String(event.session_id || ""),
      reason: g.suppressReason,
      mode: searchGuidanceAuto ? "auto" : "pilot",
      at: new Date().toISOString(),
    });
  }
  return { stopReason: "allow" };
}

function handlePostToolUse(event) {
  const sessionId = String(event.session_id || "");
  const cwd = String(event.cwd || process.cwd());
  const response = event.tool_response;
  const text = extractText(response);
  const input = {
    hookEventName: "PostToolUse",
    tool_name: String(event.tool_name || ""),
    tool_input: event.tool_input || {},
    session: { session_id: sessionId },
    cwd,
    transcript_path: String(event.transcript_path || ""),
  };
  const payload = normalizeAfter(input, { tool_response: response }, { directory: cwd }, AGENT_CLAUDE_CODE);

  // P1-S2b: resolve the agent-semantic original command for auto-carried Bash
  // calls. PostToolUse may expose either the original command (platform case A)
  // or the rewritten wrapper (case B); parseCarrierWrapper restores the
  // original deterministically in-band (base64url token, no side-channel) so
  // Validation Delta identity and success-terminal summaries always carry the
  // command the agent actually requested.
  const carrierWrapper = parseCarrierWrapper(String(input.tool_input.command || ""));
  const semanticCommand = carrierWrapper ? carrierWrapper.originalCommand : null;
  const hookInput = semanticCommand
    ? { ...input, tool_input: { ...input.tool_input, command: semanticCommand } }
    : input;

  if (process.env.CODE_GUARD_AUTO_CANARY_V1A !== "1") return {};

  // P1-S2a Carrier-Aware Diagnostic Eligibility
  // (docs/architecture/FAILURE-CARRIER-CONTRACT-V1.md §2, frozen). A shell
  // output carrying the [TASCO_FAILURE_CARRIER] marker is governed by the
  // carrier contract, not by prompt heuristics:
  //   valid carrier AND original_exit_code != 0 -> deterministic Diagnostic
  //     candidate (evidence.failure=true), independent of prompt wording;
  //   malformed / incomplete carrier -> Native, no semantic guessing: no
  //     diagnostic/terminal/VD candidate is formed from it.
  // Failure semantics come exclusively from original_exit_code, never from
  // the carrier wrapper process exit code (always 0).
  const carrier =
    payload.tool_name === "run_shell_command"
      ? parseFailureCarrier(text)
      : { present: false, valid: false };
  const carrierFailure = isDiagnosticEligibleFailureCarrier(carrier);
  // Valid carrier with original_exit_code === 0: success domain per contract
  // §2 (terminal / VD path may consume it); never a Diagnostic candidate.
  const carrierSuccess =
    carrier.valid === true && !carrierFailure;
  if (carrier.present && !carrier.valid) {
    createClaudeNativeObservability().recordNative({
      event,
      canonicalToolName: payload.tool_name,
      deliveredText: text,
    });
    appendEvent({
      type: "auto_arbitration_v1",
      arbitration_version: ARBITRATION_VERSION,
      sessionId,
      candidate_capabilities: [],
      eligible_capabilities: [],
      selected_capability: null,
      selection_reason: null,
      applied_capability: null,
      fallback_reason: "failure_carrier_malformed",
      double_apply_count: 0,
      at: new Date().toISOString(),
    });
    return {};
  }

  const observer = createAutoCanaryObserver({
    sessionId,
    prompt: process.env.CODE_GUARD_CLAUDE_PROMPT || "",
  });
  const obs = observer.observe(payload, text);
  const capId = capabilityForStrategy(obs.selected);
  const capDecision = capId
    ? resolveCapabilityDecision({
        capabilityId: capId,
        resolvedOptions: resolveCapabilityOptions(loadCapabilityOptions()),
      })
    : null;
  const tsAuto = process.env.CODE_GUARD_TERMINAL_STATE === "1";
  const tsShadow = process.env.CODE_GUARD_TERMINAL_STATE_SHADOW === "1";
  const terminalState = createTerminalStateCompressor({});
  const terminalSummary =
    (tsAuto || tsShadow) && !(tsAuto && tsShadow)
      ? terminalState.tryCompressSuccessTerminal({
          toolName: payload.tool_name,
          command: semanticCommand || (input.tool_input && input.tool_input.command),
          text,
        })
      : null;
  const diagnosticCandidate =
    carrierFailure || (!carrierSuccess && obs.selected === "diagnostic_semantic");
  // Validation Delta candidate detection (CODE_GUARD_VALIDATION_DELTA=1):
  // test-kind shell outputs only, positive zone = success current run with a
  // comparable previous run under the same normalized command (contract v1).
  // The current run's fingerprint is recorded regardless of the arbitration
  // outcome so the NEXT run has a comparable baseline; recording and
  // detection are gated by the same flag (unset stays byte-identical).
  const vdAuto = process.env.CODE_GUARD_VALIDATION_DELTA === "1";
  const vdCommand = semanticCommand || (input.tool_input && input.tool_input.command);
  // Line-7 C 阶段：VD 正区从 test 扩展为 test + build + check（fingerprint
  // 记录与 delta 资格同门；failure current 仍不产生 VD——Diagnostic 域）。
  const vdKind =
    payload.tool_name === "run_shell_command" ? classifyCommand(vdCommand) : null;
  const isTestShell =
    vdKind === "test" || vdKind === "build" || vdKind === "check";
  let vdResult = null;
  let vdHasPrevious = false;
  if (vdAuto && isTestShell) {
    const previous = loadValidationState(sessionId, vdCommand);
    vdHasPrevious = Boolean(sameCommand(previous, vdCommand));
    vdResult = tryCompressValidationDelta({ command: vdCommand, text, previous: vdHasPrevious ? previous : null });
    const fp = buildFingerprint({ command: vdCommand, text });
    if (fp) saveValidationState(sessionId, vdCommand, fp);
  }
  const arbitration = arbitrate({
    candidates: [
      ...(diagnosticCandidate
        ? [{
            id: "diagnostic_semantic",
            // A success terminal is a valid conflict candidate; Arbitration
            // decides whether its semantic evidence should win. A valid
            // failure carrier is deterministic: eligible with failure
            // evidence anchored on original_exit_code != 0, so the frozen
            // failure_diagnostic_precedence rule wins over Terminal-State
            // even when the carrier body looks success-like (C10 class).
            eligible: carrierFailure || obs.applied === "diagnostic_semantic" || Boolean(terminalSummary),
            reason: carrierFailure
              ? "failure_carrier_contract_v1"
              : terminalSummary
                ? "diagnostic_candidate_competes_with_success_terminal"
                : "diagnostic_candidate_eligible",
            evidence: { failure: carrierFailure ? true : !terminalSummary },
          }]
        : []),
      ...(vdAuto && isTestShell && vdHasPrevious
        ? [{
            id: "validation_delta",
            eligible: Boolean(vdResult),
            reason: vdResult
              ? "comparable_validation_delta"
              : "validation_delta_unstable_or_no_saving",
            evidence: { stableDelta: Boolean(vdResult) },
          }]
        : []),
      ...(terminalSummary
        ? [{
            id: "terminal_state_success",
            eligible: true,
            reason: "recognized_success_terminal",
            evidence: { success: true },
          }]
        : []),
    ],
    fallbackReason: "no_eligible_capability",
  });
  const appendArbitration = (applied, fallbackReason = null, arbOverride = null) => {
    const arb = arbOverride || arbitration;
    const decision = markApplied(
      fallbackReason ? { ...arb, fallback_reason: fallbackReason } : arb,
      applied
    );
    appendEvent({
      type: "auto_arbitration_v1",
      arbitration_version: decision.arbitration_version,
      sessionId,
      candidate_capabilities: decision.candidate_capabilities,
      eligible_capabilities: decision.eligible_capabilities,
      selected_capability: decision.selected_capability,
      selection_reason: decision.selection_reason,
      applied_capability: decision.applied_capability,
      fallback_reason: decision.fallback_reason,
      double_apply_count: decision.double_apply_count,
      at: new Date().toISOString(),
    });
    return decision;
  };
  appendEvent({
    type: "auto_canary_v1a",
    sessionId,
    selected_capability: arbitration.selected_capability || "native",
    // Preserve the legacy event while preventing it from claiming a
    // Diagnostic apply when Arbitration selected Terminal-State.
    applied_capability:
      arbitration.selected_capability === "diagnostic_semantic" &&
      (obs.applied === "diagnostic_semantic" || carrierFailure)
        ? "diagnostic_semantic"
        : null,
    intervention_count: observer.state.interventionCount,
    capability_sequence: [...observer.state.capabilitySequence],
    fallback_reason:
      obs.selected === "diagnostic_semantic" && obs.applied === "native"
        ? "diagnostic_not_current_eligible_output"
        : null,
    reason:
      carrierFailure
        ? "failure_carrier_contract_v1: original_exit_code is nonzero"
        : obs.selected === "diagnostic_semantic"
          ? "large semantic diagnostic/log evidence with root-cause intent"
          : "no rule matched - default native",
    confidence: carrierFailure || obs.selected === "diagnostic_semantic" ? "high" : "medium",
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

  // P0 Terminal-State capability dispatch (flag-gated, adapter integration
  // 2026-09-04): bridge acts ONLY as a capability dispatcher - it decides
  // whether the frozen post_tool_policy_hook may be consulted for this
  // shell output. Success/failure semantics stay exclusively in the frozen
  // policy classifier (terminal_state.js). CODE_GUARD_TERMINAL_STATE=1 adds
  // this leg; unset/0 keeps the previous path byte-identical (no extra hook
  // spawn, no telemetry delta, no output change).
  if (tsAuto && tsShadow) {
    // Configuration invalid: both flags on. Terminal capability degrades to
    // Native fail-safe (session unaffected); record the invalid config so the
    // data is never misattributed to shadow or auto.
    appendEvent({
      type: "terminal_configuration_invalid",
      sessionId,
      terminal_state: tsAuto ? "1" : "0",
      terminal_state_shadow: tsShadow ? "1" : "0",
      at: new Date().toISOString(),
    });
  }
  // Validation Delta delivery branch. Runs BEFORE the terminal dispatch leg:
  // that leg's condition captures every non-diagnostic winner, and the legacy
  // policy chain has no VD concept. VD text is built and delivered bridge-
  // natively. Documented exception to the shared shouldAdoptCompression/
  // rescueCompression gate (user decision 2026-09-07): that gate assumes an
  // extractive/summarizing transform and rejects any rewrite-style report
  // (ratio < 5% => low_confidence, non-rescuable) regardless of content.
  // VD deliberately carries no raw-verbatim text — the previous run already
  // gave the model the case detail — so its completeness is enforced by the
  // VD contract itself inside tryCompressValidationDelta (marker + mode +
  // counts lines, deltaText < raw*0.8 guard, parser-verified success state).
  // Extractive capabilities (terminal_state_success, diagnostic_semantic)
  // keep the shared gate unchanged.
  if (arbitration.selected_capability === "validation_delta" && vdResult) {
    const adoptedOutput = vdResult.deltaText;
    appendEvent({
      type: "compression",
      sessionId,
      toolName: obs.tool,
      tool_family: obs.family,
      capability: "validation_delta",
      originalLength: text.length,
      compressedLength: adoptedOutput.length,
      ratio: text.length ? adoptedOutput.length / text.length : null,
      tokenReduction: text.length ? 1 - adoptedOutput.length / text.length : null,
      coverage: null, // N/A: rewrite-report, not an extractive summary
      confidence: null,
      rescued: false,
      vd_mode: vdResult.mode,
      transport_replacement_emitted: true,
      at: new Date().toISOString(),
    });
    appendArbitration("validation_delta");
    return deliveredEnvelope(response, adoptedOutput);
  }

  // Line-6 Read Runtime Integration（CODE_GUARD_READ_COMPRESSION=1）。
  // read_file 事件由冻结 read_runtime 决策接管：本腿单次咨询真实 policy
  // hook（dispatch-scoped env，与 terminal dispatch 同模式），只采纳有净
  // 节省的替换；其余一律 Native。flag 未设 → 逐字节 legacy（read 事件此前
  // 只能经 terminal-dispatch 腿到达 policy hook）。
  // 共享 shouldAdoptCompression gate 的文档化豁免（镜像 VD 先例，
  // 2026-09-07 用户拍板）：R4 suppress note / R2 关系边 / R3 链证据是
  // rewrite 型交付，raw verbatim 不在其中；完整性由各 primitive 自证
  // （R4 note 可审计无代码内容、R2/R3 边全部来自 identity map、R1/R5
  // verbatim fidelity 冻结测试）。桥侧唯一硬校验：delivered < raw
  // （无净节省不采纳，fail-closed）。
  const readAuto = process.env.CODE_GUARD_READ_COMPRESSION === "1";
  if (
    readAuto &&
    payload.tool_name === "read_file" &&
    arbitration.selected_capability !== "diagnostic_semantic"
  ) {
    const readRun = (() => {
      try {
        return runUnifiedAfter(
          hookInput,
          { tool_response: text },
          { directory: cwd },
          {
            hookDir: process.env.CODE_GUARD_HOOK_DIR,
            agent: AGENT_CLAUDE_CODE,
            env: { CODE_GUARD_READ_DISPATCH: "1" },
          }
        );
      } catch (_e) {
        return null; // fail-open
      }
    })();
    const rUpdated =
      readRun && readRun.hookSpecificOutput && readRun.hookSpecificOutput.updatedToolOutput;
    const rDelivered = extractText(rUpdated);
    // mojibake 保护丢弃不是 read compression（保护动作不记为能力交付，
    // 防止 A/B 口径误归因）；照常原样交付（updatedToolOutput 已携带）。
    const mojibakeDrop = rDelivered.includes("[HOOK_OUTPUT_DROPPED_MOJIBAKE]");
    const adoptedRead =
      rDelivered && !mojibakeDrop && rDelivered.length < text.length ? rDelivered : null;
    const readStrategyFromMarker = (t) =>
      t.includes("[READ_SUPPRESSED]")
        ? "repeat_suppression"
        : t.includes("[EXTRACTIVE READ")
          ? "extractive_read"
          : t.includes("[READ_RELATION_EVIDENCE]")
            ? "relation_evidence"
            : t.includes("[READ_IMPLEMENTATION_CHAIN]")
              ? "implementation_chain"
              : t.includes("[READ_SECTION_EXTRACTION]")
                ? "section_extraction"
                : "unknown";
    const readArb = arbitrate({
      candidates: [
        {
          id: "read_task_compression",
          eligible: Boolean(adoptedRead),
          reason: adoptedRead
            ? "read_task_strategy_delivery"
            : "read_task_declined",
          evidence: {
            strategy: adoptedRead ? readStrategyFromMarker(adoptedRead) : null,
          },
        },
      ],
      fallbackReason: "no_eligible_capability",
    });
    if (adoptedRead) {
      appendEvent({
        type: "compression",
        sessionId,
        toolName: obs.tool,
        tool_family: obs.family,
        capability: "read_task_compression",
        read_strategy: readStrategyFromMarker(adoptedRead),
        originalLength: text.length,
        compressedLength: adoptedRead.length,
        ratio: text.length ? adoptedRead.length / text.length : null,
        tokenReduction: text.length ? 1 - adoptedRead.length / text.length : null,
        coverage: null, // rewrite/evidence 型交付不适用 lexical coverage（VD 同口径）
        confidence: null,
        rescued: false,
        transport_replacement_emitted: true,
        at: new Date().toISOString(),
      });
      appendArbitration("read_task_compression", null, readArb);
      return deliveredEnvelope(response, adoptedRead);
    }
    createClaudeNativeObservability().recordNative({
      event,
      canonicalToolName: payload.tool_name,
      deliveredText: text,
    });
    appendArbitration(null, "read_delivery_fallback", readArb);
    return {};
  }

  if (
    (tsAuto || tsShadow) &&
    !(tsAuto && tsShadow) && // invalid config -> terminal Native
    arbitration.selected_capability !== "diagnostic_semantic"
  ) {
    const terminalResult = (() => {
      try {
        return runUnifiedAfter(
          hookInput,
          { tool_response: text },
          { directory: cwd },
          {
            hookDir: process.env.CODE_GUARD_HOOK_DIR,
            agent: AGENT_CLAUDE_CODE,
            // dispatch-scoped: policy hook exits native if terminal declines;
            // shadow mode marks the run so the hook accounts but never
            // replaces the delivered output.
            env: tsShadow
              ? { CODE_GUARD_TERMINAL_DISPATCH: "1", CODE_GUARD_TERMINAL_SHADOW: "1" }
              : { CODE_GUARD_TERMINAL_DISPATCH: "1" },
          }
        );
      } catch (_e) {
        return null; // fail-open
      }
    })();
    const tUpdated =
      terminalResult &&
      terminalResult.hookSpecificOutput &&
      terminalResult.hookSpecificOutput.updatedToolOutput;
    const tCompressed = extractText(tUpdated);
    if (tCompressed) {
      const tGuard = shouldAdoptCompression({
        originalLength: text.length,
        compressedLength: tCompressed.length,
        originalText: text,
        compressedText: tCompressed,
      });
      const tRescue = rescueCompression({ raw: text, compressed: tCompressed, guard: tGuard, minCoverage: 0.5 });
      if (tRescue.adopted) {
        const adoptedOutput = tRescue.output || tCompressed;
        appendEvent({
          type: "compression",
          sessionId,
          toolName: obs.tool,
          tool_family: obs.family,
          capability: "terminal_state_success",
          originalLength: text.length,
          compressedLength: adoptedOutput.length,
          ratio: text.length ? adoptedOutput.length / text.length : null,
          tokenReduction: text.length ? 1 - adoptedOutput.length / text.length : null,
          coverage: tGuard.coverage,
          confidence: tGuard.confidence,
          rescued: Boolean(tRescue.output),
          transport_replacement_emitted: true,
          at: new Date().toISOString(),
        });
        appendArbitration("terminal_state_success");
        return deliveredEnvelope(response, adoptedOutput);
      }
    }
    // policy hook judged native/fallback for this output -> record native.
    createClaudeNativeObservability().recordNative({
      event,
      canonicalToolName: payload.tool_name,
      deliveredText: text,
    });
    appendArbitration(null, "terminal_delivery_fallback");
    return {};
  }

  if (arbitration.selected_capability !== "diagnostic_semantic") {
    // Native is already the final behavior. Record it through the frozen
    // metrics pipeline, then return the original empty hook result unchanged.
    createClaudeNativeObservability().recordNative({
      event,
      canonicalToolName: payload.tool_name,
      deliveredText: text,
    });
    appendArbitration(null, arbitration.fallback_reason || "native_fallback");
    return {};
  }
  // Capability gate (Phase 2A): only diagnostic.semantic_compression is wired.
  // Default (auto) keeps the v0.1 execution path identical.
  if (capDecision && !capDecision.enabled) {
    appendArbitration(null, "capability_disabled");
    return {};
  }

  let updated;
  try {
    const result = runUnifiedAfter(
      hookInput,
      { tool_response: text },
      { directory: cwd },
      { hookDir: process.env.CODE_GUARD_HOOK_DIR, agent: AGENT_CLAUDE_CODE }
    );
    updated =
      result && result.hookSpecificOutput && result.hookSpecificOutput.updatedToolOutput;
  } catch (_e) {
    return {}; // fail-open
  }
  const compressed = extractText(updated);
  if (!compressed) return {};

  const guard = shouldAdoptCompression({
    originalLength: text.length,
    compressedLength: compressed.length,
    originalText: text,
    compressedText: compressed,
  });
  const rescue = rescueCompression({ raw: text, compressed, guard, minCoverage: 0.5 });
  if (!rescue.adopted) {
    appendArbitration(null, "diagnostic_delivery_fallback");
    return {};
  }
  const adoptedOutput = rescue.output || compressed;
  appendEvent({
    type: "compression",
    sessionId,
    toolName: obs.tool,
    tool_family: obs.family,
    originalLength: text.length,
    compressedLength: adoptedOutput.length,
    ratio: text.length ? adoptedOutput.length / text.length : null,
    tokenReduction: text.length ? 1 - adoptedOutput.length / text.length : null,
    coverage: guard.coverage,
    confidence: guard.confidence,
    rescued: Boolean(rescue.output),
    transport_replacement_emitted: true,
    at: new Date().toISOString(),
  });
  appendArbitration("diagnostic_semantic");
  return deliveredEnvelope(response, adoptedOutput);
}

function main() {
  const stdin = fs.readFileSync(0, "utf8");
  let event;
  try {
    event = JSON.parse(stdin);
  } catch (_e) {
    console.log("{}");
    process.exit(0);
  }
  const hookName = String(event.hook_event_name || event.hookEventName || "");
  try {
    // 可观测性标记：确认 Claude 确实调用本 bridge（不参与任何策略）。
    const base = process.env.CODE_GUARD_BASE_DIR || path.join(process.cwd(), ".code-guard");
    const marker = path.join(base, "hook_invoked.jsonl");
    const resp = event.tool_response;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.appendFileSync(
      marker,
      `${JSON.stringify({
        event: "hook_invoked",
        hook: hookName,
        session_id: event.session_id || "",
        tool_name: event.tool_name || "",
        resp_type: typeof resp,
        resp_keys: resp && typeof resp === "object" ? Object.keys(resp).join(",") : "",
        // P1-S2b platform probe: what command identity reaches each hook event
        // (original vs rewritten wrapper) for auto-carried Bash calls.
        cmd_head: String((event.tool_input || {}).command || "").slice(0, 160),
        at: new Date().toISOString(),
      })}\n`,
      "utf8"
    );
    if (process.env.CODE_GUARD_BRIDGE_DEBUG === "1" && hookName === "PostToolUse") {
      const dbg = path.join(base, "bridge_debug.jsonl");
      fs.appendFileSync(
        dbg,
        `${JSON.stringify({ session_id: event.session_id || "", tool_name: event.tool_name || "", tool_response: event.tool_response })}\n`,
        "utf8"
      );
    }
  } catch (_e) {}
  try {
    if (hookName === "PreToolUse") {
      console.log(JSON.stringify(handlePreToolUse(event)));
      return;
    }
    if (hookName === "PostToolUse") {
      console.log(JSON.stringify(handlePostToolUse(event)));
      return;
    }
    if (hookName === "UserPromptSubmit") {
      console.log(JSON.stringify(handleUserPromptSubmit(event)));
      return;
    }
    console.log("{}");
  } catch (err) {
    console.error(`[claude-bridge] fail-open: ${(err && err.message) || err}`);
    console.log("{}");
  }
}

if (require.main === module) main();

module.exports = {
  handlePreToolUse,
  handlePostToolUse,
  handleUserPromptSubmit,
  extractText,
  telemetryFile,
};
