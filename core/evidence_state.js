"use strict";

// ============================================================================
// evidence_state.js — Evidence State Adapter（ECOR Pilot 前置，插件层）
// ============================================================================
// v1.2 数据表明复杂 bug 任务的剩余摩擦是 evidence protocol：模型反复触发
// STOP_EVIDENCE_COMPLETE / BLOCK_REPLACE_NEEDS_RECOVERY_SLICE /
// BLOCK_INVALID_SMART_READ，本质是“不知道治理状态机当前在哪一步”。
//
// 本模块在插件层维护 per-session 证据状态（已读文件/行范围），并把证据类
// 拦截归一化成“Evidence state + Allowed next actions”，告诉模型哪些证据
// 已收集、缺什么、下一步该做什么。不修改核心 hook。
// ============================================================================

const path = require("path");

const EVIDENCE_BLOCK_CODES = new Set([
  "STOP_EVIDENCE_COMPLETE",
  "BLOCK_REPLACE_NEEDS_RECOVERY_SLICE",
  "BLOCK_READ_POLICY",
  "BLOCK_INVALID_SMART_READ",
  "BLOCK_INVALID_SLICE_ARGS",
  "BLOCK_NATIVE_REPLACE_UNSTABLE",
]);

const MAX_TRACKED_FILES = 12;

function normalizeFile(filePath) {
  try {
    return path.resolve(String(filePath || ""));
  } catch (_e) {
    return String(filePath || "");
  }
}

function createEvidenceTracker(options) {
  const opts = options || {};
  const sessionId = opts.sessionId || "";
  const state = {
    sessionId,
    files: [], // [{ file, ranges: [{start, end}], lastReadAt }]
    specReads: 0,
    editAttempts: 0,
  };

  function upsertFile(file) {
    let entry = state.files.find((f) => f.file === file);
    if (!entry) {
      if (state.files.length >= MAX_TRACKED_FILES) state.files.shift();
      entry = { file, ranges: [] };
      state.files.push(entry);
    }
    return entry;
  }

  return {
    state,

    recordRead({ filePath, startLine, endLine }) {
      if (!filePath) return;
      const file = normalizeFile(filePath);
      const entry = upsertFile(file);
      const start = Number(startLine);
      const end = Number(endLine);
      if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) {
        const exists = entry.ranges.some((r) => r.start === start && r.end === end);
        if (!exists) entry.ranges.push({ start, end });
      }
      entry.lastReadAt = Date.now();
      if (/spec|requirement|contract|\.md$/i.test(file)) state.specReads += 1;
    },

    recordEdit() {
      state.editAttempts += 1;
    },

    current() {
      return JSON.parse(JSON.stringify(state));
    },

    /**
     * 针对证据类拦截生成 Evidence state 引导。
     */
    guidanceForBlock(code) {
      const s = state;
      const lines = [];
      const collected = s.files.slice(-6).map((f) => {
        const ranges = f.ranges.length
          ? f.ranges.slice(-3).map((r) => `${r.start}-${r.end}`).join(", ")
          : "whole file";
        return `${f.file} (${ranges})`;
      });
      if (collected.length) {
        lines.push("Evidence state (already collected):");
        for (const c of collected) lines.push(`- ${c}`);
      } else {
        lines.push("Evidence state: none collected yet.");
      }

      if (code === "BLOCK_INVALID_SMART_READ" || code === "BLOCK_INVALID_SLICE_ARGS") {
        lines.push(
          "Tool usage fix: use read_file_slice.py with an exact range " +
            "(python read_file_slice.py \"<file>\" <start> <end>), or " +
            "smart_read_file.py --query <symbol> for a target not yet read."
        );
        lines.push("Do NOT re-read ranges already listed above.");
      } else if (code === "STOP_EVIDENCE_COMPLETE" || code === "BLOCK_REPLACE_NEEDS_RECOVERY_SLICE") {
        lines.push(
          "Missing: a fresh verification slice of the exact target range " +
            "(read the target function once with read_file_slice.py, then retry the edit)."
        );
      } else if (code === "BLOCK_READ_POLICY") {
        lines.push(
          "Respect the read budget: use one bounded slice per target; " +
            "do not list directories or re-read collected ranges."
        );
      }
      lines.push("Allowed next actions: 1) read the exact missing range once  2) edit  3) run tests  4) verify.");
      return lines.join("\n");
    },
  };
}

function isEvidenceBlock(code) {
  return EVIDENCE_BLOCK_CODES.has(code);
}

module.exports = {
  EVIDENCE_BLOCK_CODES,
  MAX_TRACKED_FILES,
  normalizeFile,
  createEvidenceTracker,
  isEvidenceBlock,
};
