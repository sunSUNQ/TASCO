"use strict";

// ============================================================================
// post_tool/read_repeat_suppression.js — Line-6 R4 Repeat Suppression primitive
// ============================================================================
// 纯函数、无 I/O、确定性。判定一次 read_file 请求应该：
//   suppress       同文件 + 内容指纹未变 + 请求区域此前已完整交付
//                  → 交付短说明（不重发原文）
//   refresh        同文件但内容指纹变化
//                  → 必须重新交付（false_suppression=0 / stale_content=0）
//   deliver_unseen 同文件 + 指纹未变 + 请求含未交付区域
//   deliver        不同文件 / 无历史 / 信息不足（不猜测）
//
// 输入由调用方提供状态（与 validation_delta 相同的纯函数风格）：
//   previous: { path, content_hash, ranges: [[startLine, endLine], ...] } | null
//   request:  { path, start_line, end_line, content_hash }
//
// 铁律：hash 不一致时永远不允许 suppress（stale content 严禁）；
//       range/hash 信息缺失时永远 deliver（fail-open，不猜测）。
// ============================================================================

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function hash8(hash) {
  const s = String(hash || "");
  return s ? s.slice(0, 8) : "unknown";
}

function mergeRanges(ranges) {
  const valid = (ranges || [])
    .map((r) => [Number(r && r[0]), Number(r && r[1])])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e >= s && s >= 1)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of valid) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function isCoveredBy(ranges, start, end) {
  for (const [s, e] of ranges) {
    if (start >= s && end <= e) return true;
  }
  return false;
}

/**
 * 判定一次重复读取的交付动作。确定性。
 */
function decideRepeatRead({ previous, request } = {}) {
  const req = request || {};
  const start = Number(req.start_line);
  const end = Number(req.end_line);
  const hasRange = Number.isFinite(start) && Number.isFinite(end) && end >= start && start >= 1;
  const path = normalizePath(req.path);

  // 不同文件 / 无历史 / 信息不足 → 原样交付（fail-open，绝不猜测）。
  if (!previous || normalizePath(previous.path) !== path) {
    return { action: "deliver", reason: path ? "different_file" : "no_path", note: null };
  }
  if (!hasRange || !previous.content_hash || !req.content_hash) {
    return { action: "deliver", reason: "insufficient_range_or_fingerprint", note: null };
  }

  // 内容指纹变化 → 必须 refresh（禁止 suppress 旧内容）。
  if (String(previous.content_hash) !== String(req.content_hash)) {
    return { action: "refresh", reason: "content_changed", note: null };
  }

  const delivered = mergeRanges(previous.ranges);
  if (delivered.length === 0) {
    return { action: "deliver_unseen", reason: "no_delivered_ranges", note: null };
  }

  if (isCoveredBy(delivered, start, end)) {
    const note =
      `[READ_SUPPRESSED] lines ${start}-${end} of ${path} were already delivered earlier in this ` +
      `session and the file content is unchanged (fingerprint ${hash8(req.content_hash)}). ` +
      `Use the previously delivered content; re-reading the full range is unnecessary. ` +
      `If you need different lines, request a specific new range.`;
    return { action: "suppress", reason: "same_file_unchanged_range_already_delivered", note };
  }

  return { action: "deliver_unseen", reason: "new_range", note: null };
}

module.exports = { decideRepeatRead, mergeRanges, isCoveredBy };
