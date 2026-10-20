// ============================================================================
// observability/recovery.js — 恢复(Recovery/Recheck)观测(规则式,纯计算)
// ============================================================================
// 第二阶段增量扩展(A):压缩交付后,模型在后续固定窗口 N 个 tool calls 内
// 重新访问同一资源(文件 / 搜索 query / 命令)→ 记为一次「恢复(recovery)」。
//
// 关键约束与口径:
//   - NDJSON append-only:不回溯改写已写行。恢复判定只写在「恢复发生的
//     那一行」:行 M 在 finalize 时对已有行(同 session、去重、排除同
//     tool_call_id 的既有行)向后扫描,找到「最近的 applied 行 E」且
//     gap_calls = M−E ≤ N 且 access 命中 → 行 M 打 recovery_link。
//   - 双重计数防护:一行只链接「最近」的 applied 行;成本只记一次。
//     行级 link 与 summary replay 使用同一判定函数,结果必然一致。
//   - v1 全规则式(文件/query/命令键相等),不用模型判断恢复意图;
//     误判方向与窗口 N 的关系见 schema 注释(可经 CODE_GUARD_RECOVERY_WINDOW
//     调整窗口,默认 5)。
//
// 成本口径:
//   gross_saved          = Σ applied 行 saved_chars(与既有直接节省口径一致)
//   recovery_cost_chars  = Σ 恢复行 delivered_chars(模型因压缩而重新消费的内容)
//   net_saved_chars      = gross_saved_chars − recovery_cost_chars
//   (恢复行本身若也被压缩,其 delivered 只按恢复行消费内容计一次成本;
//   其余额照常计入 gross —— 两本账互不干扰,均在 replay 内确定性得出)
//
// no_recovery_rate 的窗口语义(防止尾部窗口误判):
//   applied 行 E 之后的行数 F ≥ N → 全窗口已观测(evaluated);
//   E 在窗口内出现过恢复行 → recovered;否则 → no_recovery。
//   F < N 且未检出恢复 → pending(恢复可能还没发生),不进 rate 分母。
//
// 本模块纯计算:无副作用、无 I/O;对缺新字段的历史行安全跳过。
// ============================================================================

"use strict";

/** 恢复观测窗口:默认 N=5,可用 CODE_GUARD_RECOVERY_WINDOW(1..50)覆盖。 */
function recoveryWindowCalls() {
  const raw = Number(process.env.CODE_GUARD_RECOVERY_WINDOW);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 50) return raw;
  return 5;
}

/** 数字容错:null/undefined/非数 → 0(历史行缺字段安全)。 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 行去重:与既有 verify/session 语义一致 —— event==="tasco_compression" 且
 * tool_call_id 首次出现者保留(重复回调/乱序重复只累计一次)。
 */
function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || r.event !== "tasco_compression") continue;
    const cid = String(r.tool_call_id || "");
    if (cid && seen.has(cid)) continue;
    if (cid) seen.add(cid);
    out.push(r);
  }
  return out;
}

/** 两个 access 键是否命中 → 命中类型(same_file/same_query/same_command)。 */
function overlapKind(accessA, accessB) {
  if (!accessA || !accessB) return null;
  if (accessA.type !== accessB.type || !accessA.key || !accessB.key) return null;
  if (accessA.key !== accessB.key) return null;
  switch (accessA.type) {
    case "file":
      return "same_file";
    case "query":
      return "same_query";
    case "command":
      return "same_command";
    default:
      return null;
  }
}

/**
 * 行级 recovery link:在已有行(去重后,不含当前行)中向后找「最近的
 * applied 行」,gap ≤ window 且 access 命中。
 * @param {Array} rows      去重后的既有行(不含当前行)
 * @param {object} current  {tool_call_id, access}
 * @param {number} window   窗口 N(恢复发生在距压缩行 ≤ N 次调用内)
 * @returns {{of_compression_id: string|null, kind: string, gap_calls: number}|null}
 */
function findRecoveryLink(rows, current, window) {
  if (!current || !current.access || !current.access.key) return null;
  const myId = String(current.tool_call_id || "");
  // 当前行将插入在 rows.length 位置 → 与 rows[i] 的 gap = rows.length − i。
  for (let i = rows.length - 1; i >= 0; i--) {
    const gap = rows.length - i;
    if (gap > window) break;
    const r = rows[i];
    if (!r || !r.applied) continue;
    if (myId && String(r.tool_call_id || "") === myId) continue;
    const kind = overlapKind(r.access, current.access);
    if (kind) {
      return { of_compression_id: r.compression_id || null, kind, gap_calls: gap };
    }
  }
  return null;
}

/**
 * Session 级确定性 replay(对全量去重行):
 *   - 每行 j 的恢复判定 = findRecoveryLink(前序行, 行 j)(成本只记最近者);
 *   - 但「E 是否被恢复过」标记 E 窗口内所有命中的 applied 行(供 rate 统计);
 *   - 聚合 gross / recovery_cost / net / 分 kind 计数 / 窗口状态计数。
 * @param {Array} rows   原始 NDJSON 行(内部去重)
 * @param {number} window 窗口 N
 */
function replay(rows, window) {
  const deduped = dedupeRows(rows);
  const out = {
    applied_rows: 0,
    gross_saved_chars: 0,
    detected_events: 0,
    recovery_cost_chars: 0,
    read_count: 0,
    search_count: 0,
    command_count: 0,
    // 窗口状态(用于 no_recovery_rate):applied 行按「其后的行数 F」分档。
    applied_evaluated: 0, // F ≥ N:全窗口已观测
    applied_pending: 0, // 0 < F < N 且未检出恢复:尾部窗口,恢复可能尚未发生
    applied_no_recovery: 0, // evaluated 且窗口内无恢复
  };

  // 窗口内 recent applied 行(entry 保留对象引用,供标记 recovered);
  // appliedAll 保留全部 applied 行(窗口统计与 recent 剪枝解耦)。
  const recent = [];
  const appliedAll = [];
  const n = deduped.length;

  for (let j = 0; j < n; j++) {
    const r = deduped[j];
    // 移除窗口外 applied 行(距当前行超过 window 次调用)。
    while (recent.length && j - recent[0].idx > window) recent.shift();

    // 当前行是否恢复某次压缩:从最近向后找 access 命中;成本/行 link 只取
    // 最近者,但恢复标记给窗口内所有命中的 applied 行(各自都确实被重访)。
    let link = null;
    if (r.access && r.access.key) {
      for (let k = recent.length - 1; k >= 0; k--) {
        const kind = overlapKind(recent[k].access, r.access);
        if (!kind) continue;
        recent[k].recovered = true;
        if (!link) {
          link = {
            of_compression_id: recent[k].compression_id,
            kind,
            gap_calls: j - recent[k].idx,
          };
        }
      }
    }
    if (link) {
      out.detected_events += 1;
      out.recovery_cost_chars += num(r.delivered_chars);
      if (link.kind === "same_file") out.read_count += 1;
      else if (link.kind === "same_query") out.search_count += 1;
      else if (link.kind === "same_command") out.command_count += 1;
    }

    if (r.applied) {
      out.applied_rows += 1;
      out.gross_saved_chars += num(r.saved_chars);
      const entry = {
        idx: j,
        access: r.access || null,
        compression_id: r.compression_id || null,
        recovered: false,
      };
      recent.push(entry);
      appliedAll.push(entry);
    }
  }

  // 窗口分档:按 applied 行之后的剩余行数 F = n − 1 − idx 回算。
  for (const e of appliedAll) {
    const f = n - 1 - e.idx; // 该 applied 行之后的行数
    if (f >= window) {
      out.applied_evaluated += 1;
      if (!e.recovered) out.applied_no_recovery += 1;
    } else if (!e.recovered) {
      out.applied_pending += 1;
    }
    // f < window 但已检出恢复 → 已定性,不计入 rate 分母也不计 pending。
  }

  return out;
}

module.exports = {
  recoveryWindowCalls,
  dedupeRows,
  overlapKind,
  findRecoveryLink,
  replay,
};
