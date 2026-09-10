// Shadow Conservative Router v1.
// Decides expected_strategy from pre-intervention signals only:
//   { prompt, dominantTool, maxOutputSize, distinctFiles, crossFile, grepUsed, readUsed }
// Rules are conservative and ordered; unknown/ambiguous -> native.
"use strict";

const { buildContract } = require("./contract.js");
// Bilingual intent normalization (EN + ZH). classifyPrompt keeps the exact
// frozen signature { scores, flags, dominant }; EN regexes are verbatim, so
// English routing is unchanged.
const { classifyPrompt } = require("./bilingual_intent.js");

function decide(signals) {
  const { prompt = "", dominantTool = "unknown", maxOutputSize = 0, distinctFiles = 0, crossFile = false, grepUsed = false, readUsed = false } = signals || {};
  const cls = classifyPrompt(prompt);
  const { flags } = cls;

  const native = (reason, confidence = "medium") => ({
    expected_strategy: "native",
    eligible: false,
    confidence,
    reason,
    source_tool: dominantTool,
    input_size: maxOutputSize,
  });

  // 1. Distribution / aggregation tasks stay native (sg3, ex_d1).
  if (flags.distribution) {
    return native("distribution/aggregation evidence stays native (precision-sensitive)", "medium");
  }
  // 2. Symbol-location tasks stay native (st1).
  if (flags.location) {
    return native("symbol-location task stays native (no stable positive)", "medium");
  }
  // 3. Full-suite test evidence is precision-sensitive (ex_d1/ex_d2 class).
  if (flags.testSuite) {
    return native("full-suite test evidence is precision-sensitive - stays native", "medium");
  }
  // 4. Edit / mutation tasks are not compression targets.
  if (flags.editIntent && !flags.analysisOnly) {
    return native("edit/mutation workflow stays native", "medium");
  }

  const dom = cls.dominant;

  // 5. Relational structural context: structural intent + cross-file exploration.
  if (dom === "structural" && crossFile) {
    return {
      expected_strategy: "structural_relational",
      eligible: true,
      confidence: "high",
      reason: "relational structural task with cross-file exploration",
      source_tool: dominantTool,
      input_size: maxOutputSize,
    };
  }

  // 6. Large semantic diagnostic output (analysis-only tasks; lab_s2 class).
  if (dom === "diagnostic" && flags.analysisOnly && maxOutputSize >= 4000) {
    return {
      expected_strategy: "diagnostic_semantic",
      eligible: true,
      confidence: "high",
      reason: "large semantic diagnostic/log evidence with root-cause intent",
      source_tool: dominantTool,
      input_size: maxOutputSize,
    };
  }

  // 7. Selective search (filtering intent + grep/search tool usage).
  if (dom === "search" && flags.selective && grepUsed) {
    return {
      expected_strategy: "search_selective",
      eligible: true,
      confidence: "high",
      reason: "selective/filtering search intent with grep evidence",
      source_tool: dominantTool,
      input_size: maxOutputSize,
    };
  }

  // 8. Self-contained raw-code extraction (single-file symbol/type).
  if (dom === "read_extractive" && flags.selfContained && readUsed && distinctFiles <= 1) {
    return {
      expected_strategy: "read_extractive",
      eligible: true,
      confidence: "high",
      reason: "self-contained symbol/type evidence in a single-file read",
      source_tool: dominantTool,
      input_size: maxOutputSize,
    };
  }

  // 9. Conservative fallback.
  if (!dom) {
    return native("ambiguous evidence type - unknown -> native", "low");
  }
  return native("no rule matched - default native", "medium");
}

// Candidate Diagnostic Auto eligibility boundary. Kept separate from decide()
// while the rule is under shadow-only review, so production routing remains
// unchanged until the boundary has independent effect evidence.
function decideWithDiagnosticEligibilityBoundary(signals) {
  const cls = classifyPrompt((signals && signals.prompt) || "");
  if (cls.dominant === "diagnostic" && cls.flags.analysisOnly && cls.flags.multiSourceSynthesis) {
    return {
      expected_strategy: "native",
      eligible: false,
      confidence: "high",
      reason: "explicit multi-source diagnostic synthesis stays native",
      source_tool: (signals && signals.dominantTool) || "unknown",
      input_size: (signals && signals.maxOutputSize) || 0,
    };
  }
  return decide(signals);
}

function decideWithContract(signals) {
  return buildContract(decide(signals));
}

module.exports = { decide, decideWithContract, decideWithDiagnosticEligibilityBoundary, classifyPrompt };
