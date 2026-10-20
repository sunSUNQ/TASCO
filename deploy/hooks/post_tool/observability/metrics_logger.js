// ============================================================================
// observability/metrics_logger.js — 压缩可观测性统一打点
// ============================================================================
// 统一生成单次压缩事件(tasco_compression)并维护 Session 累计:
//   - 事件日志:<session_dir>/tasco_metrics/tasco_compression.ndjson(每行一事件)
//   - Session 累计:<session_dir>/tasco_metrics/session_summary.json(锁内读改写,
//     临时文件 + rename 原子覆写)
//
// compression_id 使用 crypto.randomUUID():跨进程唯一,与时间戳/进程无关,
// 避免同一毫秒多个 Hook 进程并发时碰撞。
//
// 打点协议(与策略解耦):
//   setPayload(payload)   —— 入口解析 payload 后调用,提供 session_id / tool_call_id
//                            上下文;同时开启一个新的 invocation 上下文,
//                            保证「每次 Hook invocation 至多一条事件」。
//   noteCandidate(strategy, candidateText)
//                         —— 策略生成压缩 candidate 后、调用 output() 前调用。
//                            candidateText 必须是策略产出文本、尚未经
//                            clampToolSummary / 模板包装前的长度(统一口径)。
//                            也用于 output() 收到空文本时的 candidate 记录
//                            以及 candidate 被丢弃(RLM 压缩不足等)的 fallback 判定。
//   finalize({text, replaceOutput, delivered, reason})
//                         —— 唯一交付出口 output() 在每个返回点调用;
//                            delivered 必须是最终真正交给 Agent 的正文。
//
// candidate 口径(唯一):candidate_chars = noteCandidate 传入的候选文本长度
//   (策略产出、包装/裁剪前);与 delivered(实际交付正文,可能含包装模板)
//   差异是预期的 —— candidate 仅用于内部诊断,不直接视为真实节省。
//
// fail-open 保证:public finalize 整体包在硬 try/catch 中,任何异常(含
// 日志写入失败)都绝不向 output() 抛出;Tool Result 一定正常交付。
//
// Session 边界:真实 session_id 缺失/为空时,事件仍写入 NDJSON(保留完整
// 审计链),但跳过 Session 聚合 —— 绝不累计到共享的 default bucket。
// 事件带 aggregation_skipped_reason:"missing_session_id" 标记。
//
// ---------------------------------------------------------------- 增量扩展
// 第二阶段(产品效果观测)在既有字段之后**纯追加**新字段,不删除/重命名/
// 改变任何既有字段与语义;旧 reader 按 key 读取不受影响。新增观测均不改
// 变策略决策与交付行为,全部 fail-open:
//
//   - opportunity:eligible / eligibility_reason / scenario / access
//     (规则式机会面与资源访问键,口径见 opportunity.js)
//   - recovery:recovery_detected / recovery_of / recovery_kind /
//     recovery_gap_calls / recovery_cost_chars
//     (行 M finalize 时对既有行向后扫「最近 applied + 窗口 N 内 + access
//     命中」;append-only 不做回溯;口径见 recovery.js)
//   - latency:decision_latency_ms / compression_latency_ms /
//     hook_total_latency_ms —— v1 口径:
//       t0 = setPayload(解析完成);t1 = noteCandidate;t2 = finalize 入口。
//       hook_total_latency_ms  = t2 − t0(决策+压缩+交付判定全程,不含落盘 IO)
//       compression_latency_ms = 有 candidate:t1 − t0(策略判定与压缩在
//         同步内联区间内,不可再分;native:null)
//       decision_latency_ms    = null(v1 不单独拆分决策阶段,与压缩合并)
//     所有延迟 ≥ 0;0 允许(毫秒分辨率下快路径);null = 本版本未测量。
//   - tokens:input/output/cache_read/cache_write/total_tokens 一律 null +
//     token_source(真实 provider usage 在 Claude Code hook payload 中不可
//     得 → 绝不伪造;估算见既有 *_tokens_est + token_mode:"estimated")
//   - quality:test_executed / test_passed / test_exit_code / test_command
//     (仅规则可观察项;退出码/通过与否在 hook payload 不可得 → null,不猜)
//   - environment:agent / model / repo_name / repo_hash / experiment_id /
//     arm / tasco_version / strategy_version(无绝对路径/源码正文;repo_hash
//     来自 git rev-parse --short HEAD,非 git 目录或失败 → null)
// ============================================================================

"use strict";

const { randomUUID } = require("crypto");
const cp = require("child_process");
const opportunity = require("./opportunity");
const recovery = require("./recovery");

// 测试执行规则(npm test / jest / vitest / pytest / go test 等 runner 调用)。
// 仅用于 run_shell_command 的 command 字段;误判面刻意收紧。
const TEST_RUNNER_RE =
  /\b(npm|yarn|pnpm|bun)\s+(run\s+)?test\b|\b(npx|pnpmx)\s+[\w@./-]*(jest|vitest|mocha|ava|tap)\b|\bpytest\b|\bnode\s+--test\b|\bgo\s+test\b|\bcargo\s+test\b|\b(mvn|mvnw|gradle)\s+(test|verify|check)\b|\b(cargo|make|mix|dotnet|ruby)\s+test\b|\brspec\b|\bvitest\b|\bjest\b/i;

// 环境信息进程级缓存:同进程内 cwd 与 env 不变,只捕获一次。
let envMemo = null;

function createMetricsLogger(deps) {
  const {
    fs,
    path,
    sessionPath,
    log,
    extractToolText,
    extractToolName,
    compressionMetrics,
    sessionMetrics,
  } = deps;

  const EVENTS_FILE = "tasco_compression.ndjson";
  const METRICS_DIR = "tasco_metrics";

  /** 当前 invocation 的 payload 上下文(output() 阶段才使用)。 */
  let activePayload = null;
  /** 策略最近一次生成的 candidate(每次 finalize 后清空)。 */
  let pendingCandidate = null;
  /** 当前 invocation 是否已产出一条事件(setPayload 重置)。 */
  let finalizedThisInvocation = false;
  /** 延迟观测:t0 = setPayload,t1 = noteCandidate,t2 = finalize 入口。 */
  let invocationStartMs = 0;
  let candidateAtMs = 0;

  function setPayload(payload) {
    activePayload = payload || {};
    finalizedThisInvocation = false;
    invocationStartMs = Date.now();
    candidateAtMs = 0;
  }

  /**
   * 策略生成压缩 candidate 后打点。
   * @param {string} strategy 策略名(rlm_compress / quick_grep / fast_truncate ...)
   * @param {string} candidateText 策略产出的 candidate 正文(包装/裁剪前)
   */
  function noteCandidate(strategy, candidateText) {
    pendingCandidate = {
      strategy: String(strategy || "unknown"),
      candidateText: candidateText == null ? "" : String(candidateText),
    };
    candidateAtMs = Date.now();
  }

  function getSessionId(payload) {
    return String(payload.session_id || payload.sessionId || "");
  }

  function getToolCallId(payload) {
    return String(payload.tool_use_id || payload.toolUseId || "");
  }

  /** 追加单次事件到 NDJSON;失败 fail-open。 */
  function appendEvent(event) {
    try {
      const file = sessionPath(METRICS_DIR, EVENTS_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
    } catch (e) {
      try {
        log(`tasco metrics ndjson append error=${String(e)}`);
      } catch (_e) {}
    }
  }

  /** 读取本 session 已写的事件行(供 recovery link 判定);失败 → []。 */
  function readEventRows() {
    try {
      const file = sessionPath(METRICS_DIR, EVENTS_FILE);
      if (!fs.existsSync(file)) return [];
      return fs
        .readFileSync(file, "utf8")
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
    } catch (_e) {
      return [];
    }
  }

  /** 运行环境标识(进程级缓存);git 失败/非 git 目录 → repo_hash=null。 */
  function captureEnvironment() {
    if (envMemo) return envMemo;
    let repoHash = null;
    try {
      const r = cp.spawnSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: process.cwd(),
        timeout: 1500,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      if (r && r.status === 0) {
        const hash = String(r.stdout || "").trim();
        if (hash) repoHash = hash;
      }
    } catch (_e) {}
    envMemo = {
      agent: process.env.CODE_GUARD_AGENT_RUNTIME || "claude_code",
      model: process.env.CODE_GUARD_MODEL || null,
      repo_name: path.basename(process.cwd()) || null,
      repo_hash: repoHash,
      experiment_id: process.env.CODE_GUARD_EXPERIMENT_ID || null,
      arm: process.env.CODE_GUARD_ARM || null,
      tasco_version: process.env.CODE_GUARD_TASCO_VERSION || "unknown",
      strategy_version: process.env.CODE_GUARD_STRATEGY_VERSION || "v1",
    };
    return envMemo;
  }

  /** 任务/测试规则观测:仅测试 runner 调用可确定;退出码不可得 → null。 */
  function detectTestCommand(payload) {
    const tool = extractToolName(payload);
    if (tool !== "run_shell_command") return { executed: false, command: null };
    const input = payload && (payload.tool_input || payload.toolInput);
    if (!input || typeof input !== "object") return { executed: false, command: null };
    const command = String(input.command || input.description || "");
    if (!command || !TEST_RUNNER_RE.test(command)) {
      return { executed: false, command: null };
    }
    // 命令原文属 agent 文本,非源码正文;截断 + 折叠空白后入行。
    return { executed: true, command: command.replace(/\s+/g, " ").trim().slice(0, 200) };
  }

  /**
   * 交付出口统一打点(内部实现)。delivered 必须是最终真正交给 Agent 的
   * Tool Result 正文(由调用方 output() 在拒绝/接受/guidance/native
   * 各分支给出)。
   *
   * @param {object} params
   * @param {string} params.text          调用 output() 时传入的 text(可能为空)
   * @param {boolean} params.replaceOutput 是否请求替换原始 Tool Result
   * @param {string} params.delivered     最终交付正文
   * @param {string} params.reason        交付路径:applied | insufficient_savings |
   *                                      archive_receipt_erased_savings | guidance | native
   */
  function doFinalize({ text, replaceOutput, delivered, reason }) {
    const payload = activePayload || {};
    const tFinalize = Date.now();
    const beforeText = extractToolText(payload);
    const deliveredText = String(delivered == null ? beforeText : delivered);

    // candidate:策略显式打点的优先;否则取 output() 收到的替换文本。
    let candidateText = pendingCandidate
      ? pendingCandidate.candidateText
      : replaceOutput && text
        ? String(text)
        : null;

    // candidate 存在但未被提交交付(如 RLM 压缩不足被丢弃)时,
    // 即使 output() 收到空文本,也必须记为 selected + fallback。
    let effectiveReason = reason || "native";
    if (
      effectiveReason === "native" &&
      pendingCandidate &&
      pendingCandidate.candidateText
    ) {
      effectiveReason = "candidate_discarded";
    }

    const metrics = compressionMetrics.computeEvent({
      beforeText,
      candidateText,
      deliveredText,
    });
    const selected = candidateText != null && candidateText.length > 0;
    const state = compressionMetrics.classifyEvent({
      selected,
      reason: effectiveReason,
    });

    const toolName = extractToolName(payload);
    // ---- 增量扩展观测(全部 fail-open;任一失败只影响扩展字段) -------------
    // 延迟:纯算术,独立计算 —— 即使其余扩展捕获失败也保证存在。
    const latT0 = invocationStartMs || tFinalize;
    const latency = {
      hookTotalMs: Math.max(0, tFinalize - latT0),
      compressionMs:
        pendingCandidate && candidateAtMs
          ? Math.max(0, candidateAtMs - latT0)
          : null,
    };
    let opportunityInfo = { eligible: false, eligibility_reason: null };
    let accessInfo = null;
    let recoveryLink = null;
    let env = null;
    let testInfo = { executed: false, command: null };
    try {
      opportunityInfo = opportunity.classifyEligibility({
        tool: toolName,
        before_chars: metrics.before_chars,
        selected,
      });
      // toolName = extractToolName(payload) 已通过统一归一化入口(mapCodeAgentToolName
      // + normalizeToolName)得到 canonical 名;必须传给 extractAccess —— 否则它与
      // payload 原始显示名(Read/Grep/Bash/Glob)比较将恒失配,access 全空(recovery 结构性失效)。
      accessInfo = opportunity.extractAccess(payload, toolName);
      recoveryLink = recovery.findRecoveryLink(
        recovery.dedupeRows(readEventRows()),
        { tool_call_id: getToolCallId(payload), access: accessInfo },
        recovery.recoveryWindowCalls()
      );
      env = captureEnvironment();
      testInfo = detectTestCommand(payload);
    } catch (_e) {}

    const now = new Date();
    const event = {
      event: "tasco_compression",
      timestamp: now.toISOString(),

      session_id: getSessionId(payload),
      tool_call_id: getToolCallId(payload),
      // crypto.randomUUID():跨进程唯一,不依赖进程内序号/时间戳,
      // 同一毫秒并发 Hook 进程也不会碰撞。
      compression_id: randomUUID(),

      tool: toolName,
      strategy: pendingCandidate ? pendingCandidate.strategy : "none",

      selected: state.selected,
      applied: state.applied,
      fallback: state.fallback,

      before_chars: metrics.before_chars,
      candidate_chars: metrics.candidate_chars,
      delivered_chars: metrics.delivered_chars,

      saved_chars: metrics.saved_chars,
      reduction_rate: metrics.reduction_rate,
      delta_chars: metrics.delta_chars,

      before_tokens_est: metrics.before_tokens_est,
      candidate_tokens_est: metrics.candidate_tokens_est,
      delivered_tokens_est: metrics.delivered_tokens_est,
      saved_tokens_est: metrics.saved_tokens_est,

      token_mode: "estimated",
      reason: effectiveReason,

      // ---------------- 以下为第二阶段增量扩展(纯新增,不动既有字段) ----
      // 机会面(口径见 opportunity.js;eligible_reason 仅非 eligible 时有值)
      scenario: opportunity.scenarioOf(toolName),
      eligible: !!opportunityInfo.eligible,
      eligibility_reason: opportunityInfo.eligibility_reason,

      // 资源访问键(file 为相对路径 / query 归一化 / command 短哈希;
      // 禁止绝对路径与命令原文入库)。
      access: accessInfo,

      // 恢复观测(本行是否在窗口内重访某次压缩的资源)
      recovery_detected: !!recoveryLink,
      recovery_of: recoveryLink ? recoveryLink.of_compression_id : null,
      recovery_kind: recoveryLink ? recoveryLink.kind : null,
      recovery_gap_calls: recoveryLink ? recoveryLink.gap_calls : null,
      // 本行作为恢复行重新消费的内容 = delivered(与既有 delivered 同值,
      // 独立字段便于成本归集)。
      recovery_cost_chars: recoveryLink ? metrics.delivered_chars : null,

      // 延迟(v1 口径见文件头:decision 与压缩合并;null = 未测量)
      decision_latency_ms: null,
      compression_latency_ms: latency.compressionMs,
      hook_total_latency_ms: latency.hookTotalMs,

      // 真实 provider token usage:Claude Code hook payload 不携带 usage →
      // 一律 null;token_source 声明真实 usage 不可得、估算见 *_tokens_est。
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      total_tokens: null,
      token_source: "tokenizer_estimate",

      // 任务/测试结果:仅规则可观察项;通过与否/退出码不可得 → null(不猜)。
      test_executed: testInfo.executed,
      test_passed: null,
      test_exit_code: null,
      test_command: testInfo.command,

      // 环境标识(无绝对路径;repo_hash=null 表示非 git 或取不到)
      agent: env ? env.agent : null,
      model: env ? env.model : null,
      repo_name: env ? env.repo_name : null,
      repo_hash: env ? env.repo_hash : null,
      experiment_id: env ? env.experiment_id : null,
      arm: env ? env.arm : null,
      tasco_version: env ? env.tasco_version : null,
      strategy_version: env ? env.strategy_version : null,
    };

    const sessionId = getSessionId(payload);
    if (!sessionId) {
      // 缺失 Session ID:事件保留完整审计链,但绝不累计到共享 default
      // bucket —— 展示层不得把该事件计入任何真实 Session。
      event.aggregation_skipped_reason = "missing_session_id";
    }

    // 事件日志与 Session 累计相互独立,均 fail-open。
    appendEvent(event);

    if (!sessionId) {
      return;
    }

    const result = sessionMetrics.applyEvent(sessionId, event);
    if (result.skipped) {
      // 重复回调:事件已记录,但累计被跳过;在原事件行补标记。
      event.duplicate_callback = true;
      try {
        const file = sessionPath(METRICS_DIR, EVENTS_FILE);
        fs.appendFileSync(
          file,
          JSON.stringify({
            event: "tasco_compression_duplicate_skipped",
            timestamp: new Date().toISOString(),
            session_id: event.session_id,
            tool_call_id: event.tool_call_id,
            compression_id: event.compression_id,
            reason: result.reason,
          }) + "\n",
          "utf8"
        );
      } catch (e) {
        try {
          log(`tasco metrics duplicate marker error=${String(e)}`);
        } catch (_e) {}
      }
    }
  }

  /**
   * 公开打点边界:硬 fail-open。任何异常(含 metrics 内部日志写入失败)
   * 都被吞掉,保证 Tool Result 交付路径不受 observability 影响。
   */
  function finalize(params) {
    try {
      if (finalizedThisInvocation) {
        return;
      }
      finalizedThisInvocation = true;
      doFinalize(params || {});
    } catch (e) {
      try {
        log(`tasco metrics event error=${String(e)}`);
      } catch (_e) {}
    } finally {
      pendingCandidate = null;
    }
  }

  return { setPayload, noteCandidate, finalize };
}

module.exports = { createMetricsLogger };
