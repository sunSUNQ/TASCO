// ============================================================================
// observability/session_metrics.js — Session 级压缩收益累计
// ============================================================================
// 同一 Agent Session 内持续累计 TASCO 压缩收益。
// 存储:<session_dir>/tasco_metrics/session_summary.json,每次更新后覆写。
// session 目录由 guard_core/runtime_paths.js 的 sessionPath 按 session_id
// 路由 —— 不同 Session 落到不同文件,天然隔离,不串数据。
//
// 核心口径(禁止对每次压缩百分比取平均):
//   session.reduction_rate = session.before_chars > 0
//     ? session.saved_chars / session.before_chars
//     : 0
// 只有 selected=true 的压缩事件才进入 before/delivered/saved 累计;
// native(未选中)事件仅计入 total_calls / native_calls 辅助计数。
//
// 并发与重复防护:
//   - 每次 hook invocation 是独立进程,read-modify-write 可能跨进程并发;
//     applyEvent 用目录锁(.summary.lock)串行化同 Session 的读改写。
//     锁获取有界重试(约 2s),超时则 fail-open 直接执行 —— 宁可丢失一次
//     累计精度,也不阻塞 Tool Result 交付。
//   - 相同 tool_call_id 的重复回调(如 hook 重试)只累计一次:
//     session 维护有界的近期 tool_call_id 集合(recent_tool_call_ids,
//     最多 128 个),命中即跳过累计(事件仍写入 NDJSON,带
//     duplicate_callback 标记)。有界集合可处理 A→B→A 乱序重复,
//     而不只是「连续相同」;超过窗口的极端重复会重复累计,属可接受退化。
//
// 存储口径(展示命名锁死):
//   session.reduction_rate 表示「直接上下文缩减率(估算)」—— 只统计
//   直接交付的 Tool Result 字符缩减,不包含 structural map trajectory
//   规避的后续 Read,也不代表账单级 token 节省。
//
// ---------------------------------------------------------------- 增量扩展
// 第二阶段新增的嵌套 groups(opportunity / recovery / tokens / quality /
// latency / environment)紧跟在既有 flat 字段之后 —— 既有字段、口径、写入
// 方式全部不变,旧 reader 按 key 读取不受影响。groups 是**全量 NDJSON 的
// 确定性 replay**(与 legacy 增量累计相互独立):每次 applyEvent 在锁内对
// 事件行去重(与 verify 同规则:tool_call_id 首次出现)后重算,因此 groups
// 永远与完整行集一致,天然兼容「旧 summary + 新代码」与「旧行 + 新代码」。
// 除数为 0 一律得 null(不允许 NaN/Infinity)。任何 extended 计算失败只
// 影响 groups,legacy 累计照常保存(fail-open)。
//
// 所有文件操作 fail-open:写入失败不影响 TASCO 正常交付 Tool Result。
// summary 采用原子覆写:临时文件 → flush/close → rename 替换,避免
// 读改写中途被另一进程读到半截 JSON。
// ============================================================================

"use strict";

const opportunity = require("./opportunity");
const recovery = require("./recovery");

function createSessionMetrics(deps) {
  const { fs, path, sessionPath, log } = deps;

  const METRICS_DIR = "tasco_metrics";
  const SUMMARY_FILE = "session_summary.json";
  const EVENTS_FILE = "tasco_compression.ndjson";
  const SUMMARY_TMP_SUFFIX = ".tmp";
  const LOCK_DIR = ".summary.lock";
  // 锁获取重试:100 次 × 20ms ≈ 2s;超时 fail-open。
  const LOCK_MAX_ATTEMPTS = 100;
  const LOCK_RETRY_MS = 20;
  // 重复回调防护窗口:最近 128 个 tool_call_id。
  const RECENT_TOOL_CALL_LIMIT = 128;

  function summaryFilePath() {
    return sessionPath(METRICS_DIR, SUMMARY_FILE);
  }

  function eventsFilePath() {
    return sessionPath(METRICS_DIR, EVENTS_FILE);
  }

  function emptySession(sessionId) {
    return {
      session_id: sessionId,
      // 实际事件总数 / 未选中压缩事件数
      total_calls: 0,
      native_calls: 0,
      // 压缩事件计数(仅 selected=true 的事件计入;applied + fallback = selected)
      selected_calls: 0,
      applied_calls: 0,
      fallback_calls: 0,
      // 累计字符(仅 selected=true 事件)
      before_chars: 0,
      delivered_chars: 0,
      saved_chars: 0,
      // 累计 token 估算(仅 selected=true 事件)
      before_tokens_est: 0,
      delivered_tokens_est: 0,
      saved_tokens_est: 0,
      // 基于累计 before / delivered 计算,不取平均。
      // 注意:这是「直接上下文缩减率(估算)」,不是 Session 总 Token
      // 节省率 —— 不包含 structural map trajectory 规避的后续 Read。
      reduction_rate: 0,
      // 重复回调防护:有界近期 tool_call_id 集合(最多 128 个,新加入的
      // 排后;命中即视为重复回调,跳过累计)。空则不防护。
      recent_tool_call_ids: [],
      updated_at: "",
    };
  }

  /** 读取当前 session 累计状态;失败 fail-open 返回空 session。 */
  function loadSession(sessionId) {
    const file = summaryFilePath();
    try {
      if (fs.existsSync(file)) {
        const loaded = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
        // 兼容旧版 summary:剔除已被 recent_tool_call_ids 取代的字段。
        const { last_event_tool_call_id, ...rest } = loaded;
        const base = emptySession(sessionId);
        return { ...base, ...rest, session_id: sessionId };
      }
    } catch (e) {
      try {
        log(`session metrics load error=${String(e)}`);
      } catch (_e) {}
    }
    return emptySession(sessionId);
  }

  /** 用一个有效 compression event 更新 session 累计指标。 */
  function updateSession(session, event) {
    session.total_calls += 1;

    if (!event.selected) {
      session.native_calls += 1;
      return session;
    }

    session.selected_calls += 1;
    if (event.applied) session.applied_calls += 1;
    if (event.fallback) session.fallback_calls += 1;

    session.before_chars += event.before_chars;
    session.delivered_chars += event.delivered_chars;
    session.saved_chars += event.saved_chars;

    session.before_tokens_est += event.before_tokens_est;
    session.delivered_tokens_est += event.delivered_tokens_est;
    session.saved_tokens_est += event.saved_tokens_est;

    session.reduction_rate =
      session.before_chars > 0
        ? session.saved_chars / session.before_chars
        : 0;

    return session;
  }

  /** 原子覆写 session summary;失败 fail-open。 */
  function saveSession(session) {
    try {
      const file = summaryFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + SUMMARY_TMP_SUFFIX;
      const fd = fs.openSync(tmp, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(session, null, 2), "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (e) {
      // rename 失败时旧 summary 保持完整,可容忍残留 .tmp 文件,
      // 下次成功保存会覆写它;绝不向调用方抛错。
      try {
        log(`session metrics save error=${String(e)}`);
      } catch (_e) {}
    }
  }

  /**
   * 获取同 Session 读改写锁;失败/超时 fail-open(不阻塞交付)。
   * 锁本身为目录原子创建,进程退出时由 finally 释放;若进程崩溃留下
   * 陈旧锁,后续最多等待约 2s 后继续(不删别人可能仍持用的锁)。
   */
  function withSessionLock(fn) {
    const lockDir = sessionPath(METRICS_DIR, LOCK_DIR);
    let acquired = false;
    try {
      for (let i = 0; i < LOCK_MAX_ATTEMPTS; i++) {
        try {
          fs.mkdirSync(lockDir);
          acquired = true;
          break;
        } catch (e) {
          if (!e || e.code !== "EEXIST") {
            break;
          }
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
          } catch (_e2) {}
        }
      }
      return fn();
    } finally {
      if (acquired) {
        try {
          fs.rmdirSync(lockDir);
        } catch (_e) {}
      }
    }
  }

  /** 除数为 0 → null(不允许 NaN/Infinity)。 */
  function safeRate(num, den) {
    const d = Number(den);
    return d > 0 ? Number(num) / d : null;
  }

  function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * 读取并解析本 session 事件行(单行损坏容错)。
   */
  function readEventRows() {
    try {
      if (!fs.existsSync(eventsFilePath())) return [];
      return fs
        .readFileSync(eventsFilePath(), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch (_e) {
            return null;
          }
        })
        .filter(Boolean);
    } catch (e) {
      try {
        log(`session metrics rows read error=${String(e)}`);
      } catch (_e) {}
      return [];
    }
  }

  /**
   * 第二阶段扩展:在 session 末尾追加嵌套 groups(opportunity / recovery /
   * tokens / quality / latency / environment)。对全量去重行做确定性 replay,
   * 与 legacy flat 累计相互独立。extended 失败绝不影响 legacy 保存。
   * 旧 summary / 旧行(缺新字段)→ 正常产出,缺字段按 0 / null 处理。
   */
  function attachExtendedGroups(session) {
    const rows = recovery.dedupeRows(readEventRows());
    if (!rows.length) return session;

    const windowCalls = recovery.recoveryWindowCalls();
    const rp = recovery.replay(rows, windowCalls);

    const eligibleCalls = rows.filter(
      (r) =>
        opportunity.classifyEligibility({
          tool: r.tool,
          before_chars: r.before_chars,
          selected: r.selected,
        }).eligible
    ).length;
    const selectedCalls = rows.filter((r) => r.selected).length;
    const appliedCalls = rows.filter((r) => r.applied).length;
    const positiveYield = rows.filter(
      (r) => r.applied && toNum(r.saved_chars) > 0
    ).length;

    // 调用漏斗 total → eligible → selected → applied → positive / no_recovery。
    // 除数为 0 → null(如无 eligible / 无 selected / 无 applied)。
    session.opportunity = {
      eligible_calls: eligibleCalls,
      eligible_rate: safeRate(eligibleCalls, rows.length),
      selection_rate: safeRate(selectedCalls, eligibleCalls),
      apply_rate: safeRate(appliedCalls, selectedCalls),
      positive_yield: safeRate(positiveYield, appliedCalls),
      no_recovery_rate: safeRate(
        rp.applied_no_recovery,
        rp.applied_evaluated
      ),
    };

    // 恢复/净节省:net = gross(直接节省) − recovery cost;可为负
    // (恢复成本超过直接节省是真实的负收益,如实记录)。
    session.recovery = {
      detected_events: rp.detected_events,
      read_count: rp.read_count,
      search_count: rp.search_count,
      command_count: rp.command_count,
      recovery_cost_chars: rp.recovery_cost_chars,
      gross_saved_chars: rp.gross_saved_chars,
      net_saved_chars: rp.gross_saved_chars - rp.recovery_cost_chars,
      applied_evaluated: rp.applied_evaluated,
      applied_pending: rp.applied_pending,
      applied_no_recovery: rp.applied_no_recovery,
    };

    // 真实 provider token usage:Claude Code hook payload 不可得 → null;
    // token_source 声明估算来源(tokenizer_estimate),既有 *_tokens_est 不变。
    session.tokens = {
      token_source: "tokenizer_estimate",
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      total_tokens: null,
    };

    // 任务/测试结果:仅规则可观察项;退出码/通过与否不可得 → null(不猜)。
    const testRows = rows.filter((r) => r.test_executed);
    session.quality = {
      task_status: null,
      task_success: null,
      test_executed: testRows.length > 0,
      test_events: testRows.length,
      test_passed: null,
      test_exit_code: null,
      agent_abort: null,
      user_retry: null,
    };

    // 延迟聚合(v1 口径见 metrics_logger.js 文件头;sum/mean 取整 ms)。
    // 只累计带延迟字段的行(旧行缺字段 → 不混入 0ms)。
    const hasLat = (r) => r.hook_total_latency_ms != null && Number.isFinite(toNum(r.hook_total_latency_ms));
    const hasComp = (r) => r.compression_latency_ms != null && Number.isFinite(toNum(r.compression_latency_ms));
    const latRows = rows.filter(hasLat);
    const compRows = rows.filter(hasComp);
    const latSum = latRows.reduce((a, r) => a + toNum(r.hook_total_latency_ms), 0);
    const compSum = compRows.reduce((a, r) => a + toNum(r.compression_latency_ms), 0);
    session.latency = {
      events: latRows.length,
      hook_total_latency_ms: Math.round(latSum),
      hook_mean_latency_ms: latRows.length ? Math.round(latSum / latRows.length) : null,
      compression_latency_ms: Math.round(compSum),
      compression_mean_latency_ms: compRows.length ? Math.round(compSum / compRows.length) : null,
      decision_latency_ms: null, // v1 不单独拆分决策阶段
    };

    // 环境标识:取首条带环境字段的行(新格式行;旧行先行的 session 也能
    // 反映当前运行环境;全旧行 → 各字段 null)。
    const e0 = rows.find((r) => r.agent != null) || rows[0];
    session.environment = {
      agent: e0.agent != null ? e0.agent : null,
      model: e0.model != null ? e0.model : null,
      repo_name: e0.repo_name != null ? e0.repo_name : null,
      repo_hash: e0.repo_hash != null ? e0.repo_hash : null,
      experiment_id: e0.experiment_id != null ? e0.experiment_id : null,
      arm: e0.arm != null ? e0.arm : null,
      tasco_version: e0.tasco_version != null ? e0.tasco_version : null,
      strategy_version: e0.strategy_version != null ? e0.strategy_version : null,
    };

    return session;
  }

  /**
   * 原子地应用一个事件到 Session 累计:锁内 read → 去重检查 → 更新 →
   * extended groups replay → 覆写。
   * @param {string} sessionId 原始 session_id(事件记录用)
   * @param {object} event     完整 compression event
   * @returns {{session: object, skipped: boolean, reason: string}}
   *   skipped=true 表示重复回调被跳过(不累计)。
   */
  function applyEvent(sessionId, event) {
    return withSessionLock(() => {
      const session = loadSession(sessionId);
      const toolCallId = String(event.tool_call_id || "");
      const recent = Array.isArray(session.recent_tool_call_ids)
        ? session.recent_tool_call_ids
        : [];

      // 有界近期集合去重:A→B→A 乱序重复也能命中,不限于连续相同。
      if (toolCallId && recent.includes(toolCallId)) {
        return { session, skipped: true, reason: "duplicate_tool_call" };
      }

      updateSession(session, event);
      if (toolCallId) {
        recent.push(toolCallId);
        // 超过窗口的极端重复会重复累计 —— 可接受退化,窗口 128 足够。
        if (recent.length > RECENT_TOOL_CALL_LIMIT) {
          recent.splice(0, recent.length - RECENT_TOOL_CALL_LIMIT);
        }
        session.recent_tool_call_ids = recent;
      }
      // 第二阶段扩展 groups:NDJSON 确定性 replay;失败只丢 groups,
      // 不阻断 legacy 保存与 Tool Result 交付。
      try {
        attachExtendedGroups(session);
      } catch (e) {
        try {
          log(`session metrics extended groups error=${String(e)}`);
        } catch (_e) {}
      }
      session.updated_at = new Date().toISOString();
      saveSession(session);
      return { session, skipped: false, reason: "" };
    });
  }

  return { emptySession, loadSession, updateSession, saveSession, applyEvent };
}

module.exports = { createSessionMetrics };
