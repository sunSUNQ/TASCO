"use strict";

// ============================================================================
// Capability Options V1 — capability registry (Phase 1: infrastructure only).
//
// HARD CONSTRAINT (from AGENTS.md / CAPABILITY-OPTIONS-V1.md):
//   Capability Options V1 only migrates configuration & orchestration
//   infrastructure. The current formal default MUST be strictly equivalent to
//   TASCO v0.1:
//     - diagnostic.semantic_compression = auto   (the only released capability)
//     - every other registered sub-capability   = off
//
// Schema design principles:
//   1. 实验通过 ≠ 默认启用（positive evidence does NOT enable a capability）
//   2. 技术实现完成 ≠ 默认启用（implemented does NOT enable a capability）
//   3. 只有正式冻结发布能力才允许 defaultState = "auto"
//   4. "off"   = 当前版本根本不开这个能力
//      "native" = 能力已开启时，某类任务被策略明确保护为 Native（决策期输出，
//                  不作为全局默认状态大面积使用）
//
// Registration metadata is informational only: registered / implemented /
// released are NOT inputs to routing. defaultState is the only thing that
// feeds the default configuration.
// ============================================================================

const STATUS = Object.freeze({
  OFF: "off",
  SHADOW: "shadow",
  CANARY: "canary",
  AUTO: "auto",
  NATIVE: "native",
});

const VALID_STATUS = new Set(Object.values(STATUS));

function capability(id, meta) {
  return Object.freeze(
    Object.assign(
      {
        id,
        line: id.split(".")[0],
        registered: true,
        implemented: false,
        released: false,
        defaultState: STATUS.OFF,
        description: "",
      },
      meta,
      { id, line: id.split(".")[0] }
    )
  );
}

// Frozen default configuration — equivalent to TASCO v0.1.
const CAPABILITIES = Object.freeze({
  "diagnostic.semantic_compression": capability(
    "diagnostic.semantic_compression",
    {
      implemented: true,
      released: true,
      defaultState: STATUS.AUTO,
      description:
        "v0.1 Diagnostic Auto: compress a single large semantic diagnostic output (Express-style root-cause) in the frozen positive zone.",
    }
  ),

  "search.discovery_guidance": capability(
    "search.discovery_guidance",
    {
      implemented: false,
      description: "Search discovery/task-aware guidance (WIP search_guidance line; not deployed).",
    }
  ),
  "search.filter_guidance": capability(
    "search.filter_guidance",
    {
      implemented: false,
      description: "Search filter guidance (WIP search_guidance line; not deployed).",
    }
  ),
  "search.result_selective_compression": capability(
    "search.result_selective_compression",
    {
      implemented: true,
      description: "Search selective result compression (positive zone evidenced, not released).",
    }
  ),
  "search.enumeration_statistics_protection": capability(
    "search.enumeration_statistics_protection",
    {
      implemented: true,
      description: "Enumeration/statistics negative-zone protection (router guard exists, not released).",
    }
  ),

  "read.large_file_guidance": capability(
    "read.large_file_guidance",
    {
      implemented: true,
      description: "Large-file read guidance / slice limits.",
    }
  ),
  "read.slice_read": capability(
    "read.slice_read",
    {
      implemented: true,
      description: "Bounded slice read.",
    }
  ),
  "read.repeated_read_suppression": capability(
    "read.repeated_read_suppression",
    {
      implemented: true,
      description: "Repeated read suppression / dedup.",
    }
  ),
  "read.result_compression": capability(
    "read.result_compression",
    {
      implemented: true,
      description: "Read result compression (extractive / RLM path).",
    }
  ),

  "shell.large_output_compression": capability(
    "shell.large_output_compression",
    {
      implemented: true,
      description: "Generic shell large-output compression (outside diagnostic positive zone).",
    }
  ),
  "shell.error_tail_extraction": capability(
    "shell.error_tail_extraction",
    {
      implemented: true,
      description: "Shell error-tail extraction.",
    }
  ),

  "repo_navigation.repo_map_first": capability(
    "repo_navigation.repo_map_first",
    {
      implemented: false,
      description: "Repo map first navigation (map production not frozen).",
    }
  ),
  "repo_navigation.broad_glob_guard": capability(
    "repo_navigation.broad_glob_guard",
    {
      implemented: true,
      description: "Broad glob / directory exploration guard.",
    }
  ),
});

// Frozen default map: diagnostic auto, everything else off.
const DEFAULT_CAPABILITY_STATES = Object.freeze(
  Object.fromEntries(
    Object.keys(CAPABILITIES).map((id) => [id, CAPABILITIES[id].defaultState])
  )
);

module.exports = {
  STATUS,
  VALID_STATUS,
  CAPABILITIES,
  DEFAULT_CAPABILITY_STATES,
};
