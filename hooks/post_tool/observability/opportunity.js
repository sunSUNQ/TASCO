// ============================================================================
// observability/opportunity.js — 机会面(Opportunity/Exposure)观测(纯计算)
// ============================================================================
// 第二阶段增量扩展(B / E):在不触碰策略决策树的前提下,为每次 tool call
// 计算「TASCO 实际机会面」观测。本模块是纯计算:不读 payload 之外的任何
// 状态、不产生副作用 —— 观测失败绝不影响 TASCO 策略结果。
//
//   eligible / eligibility_reason —— 本次调用是否落在压缩引擎的机会面上:
//       selected=true(引擎确实介入并产出 candidate)→ eligible=true
//       否则:tool ∈ 引擎覆盖工具集 且 before_chars ≥ MIN_ELIGIBLE_CHARS
//         → eligible=true(体量与类型都足够但引擎未介入 —— 漏斗要暴露的
//           机会缺口,由各策略自身门槛解释,不在本模块镜像策略阈值)
//       其余非 eligible 原因:
//         empty_output                —— 无正文(before_chars = 0)
//         tool_not_in_engine_scope    —— 工具类型不在引擎覆盖集
//         below_min_compress_chars    —— 体量低于通用最小压缩门槛
//   scenario —— 粗粒度场景桶(read / search / shell / task / other),
//     供 Read/Search/Diagnostic 场景分析;不携带正文与路径。
//   access —— 本次调用访问的资源键,供恢复(Recovery)判定:
//       type=file    相对工作目录的归一化文件路径(绝不写绝对路径)
//       type=query   归一化搜索 query(grep pattern 等)
//       type=command 归一化 shell 命令的短哈希(绝不写命令原文)
//
// 门槛常量仅用于观测口径,与策略代码中的阈值解耦:策略阈值变更时本模块
// 口径保持不变(观测连续性优先于镜像精度)。
// ============================================================================

"use strict";

const crypto = require("crypto");

// 通用最小压缩体量门槛(观测口径;与策略侧 MIN_COMPRESS_CHARS=2000 对齐,
// 但此处是观测定义而非策略引用 —— 策略阈值不在本模块维护)。
const MIN_ELIGIBLE_CHARS = 2000;

// 引擎策略树中存在压缩分支的工具集(仅用于机会面观测口径)。
const COMPRESSIBLE_TOOLS = new Set([
  "read_file",
  "grep_search",
  "run_shell_command",
  "invoke_agent",
]);

/** 归一化工具名 → 粗粒度场景桶。 */
function scenarioOf(tool) {
  switch (String(tool || "")) {
    case "read_file":
      return "read";
    case "grep_search":
    case "glob_search":
      return "search";
    case "run_shell_command":
      return "shell";
    case "invoke_agent":
    case "task":
    case "agent":
      return "task";
    default:
      return "other";
  }
}

/**
 * 机会面分类(口径见文件头)。纯函数。
 * @param {object} params
 * @param {string} params.tool         归一化工具名(与事件 tool 一致)
 * @param {number} params.before_chars 原始 Tool Result 字符数
 * @param {boolean} params.selected    引擎是否产出 candidate
 * @returns {{eligible: boolean, eligibility_reason: string|null}}
 */
function classifyEligibility({ tool, before_chars, selected }) {
  const before = Number(before_chars) || 0;
  if (selected) {
    // 引擎已介入并产出 candidate:无论体量/类型都视为实际机会。
    return { eligible: true, eligibility_reason: null };
  }
  if (before <= 0) {
    return { eligible: false, eligibility_reason: "empty_output" };
  }
  if (!COMPRESSIBLE_TOOLS.has(String(tool || ""))) {
    return { eligible: false, eligibility_reason: "tool_not_in_engine_scope" };
  }
  if (before < MIN_ELIGIBLE_CHARS) {
    return { eligible: false, eligibility_reason: "below_min_compress_chars" };
  }
  // 体量/类型足够但引擎未介入:机会缺口,由策略各分支门槛解释。
  return { eligible: true, eligibility_reason: null };
}

/** 归一化文件路径:统一分隔符/去掉 ./、解析 ..;绝对路径只留短哈希。 */
function normalizeFilePath(rawPath) {
  let s = String(rawPath || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!s) return null;
  s = s.replace(/\\/g, "/");
  const absolute = pathIsAbsoluteLike(s);
  if (!absolute) {
    const norm = posixNormalize(s);
    if (!norm.startsWith("../") && norm !== "..") {
      let key = norm;
      // Windows 文件系统大小写不敏感:统一小写保证不同进程拼写一致的
      // 同文件匹配;非 Windows 保持大小写敏感语义。
      if (process.platform === "win32") key = key.toLowerCase();
      return key || null;
    }
  }
  // 绝对路径 / 逃逸工作目录的路径禁止直接写入 telemetry → 短哈希。
  return "abs:" + sha16(s);
}

/** 归一化查询文本:去首尾空白、压缩内部空白;超长截断(两侧同规则)。 */
function normalizeQuery(rawQuery) {
  let s = String(rawQuery || "").trim();
  if (!s) return null;
  s = s.replace(/\s+/g, " ");
  if (s.length > 240) s = s.slice(0, 240);
  return s;
}

/** shell 命令只留短哈希(命令可能含路径/参数,禁止原文入库)。 */
function commandKey(rawCommand) {
  const s = String(rawCommand || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!s) return null;
  return sha16(s);
}

/**
 * 提取本次调用的资源访问键;无法确定(缺输入字段/非访问类工具)→ null。
 *
 * 工具名口径:优先使用调用方已归一化的 toolName(read_file/grep_search/
 * run_shell_command)。真实 Claude Code hook payload 的 tool_name 是显示名
 * (Read/Grep/Bash/Glob),与归一化名不相等 —— 若直接比较原始名将全部失配,
 * access 恒为 null 并使 recovery 结构性失效(见 telemetry_extended.test.js
 * Case3b 回归)。兼容旧调用:未传 toolName 时回退读 payload 原始名。
 *
 * @param {object} payload hook payload
 * @param {string} [toolName] 调用方归一化后的工具名
 * @returns {{type: "file"|"query"|"command", key: string}|null}
 */
function extractAccess(payload, toolName) {
  if (!payload) return null;
  const tool = String(toolName || payload.tool_name || payload.toolName || "");
  const input = payload.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input
    : payload.toolInput && typeof payload.toolInput === "object"
      ? payload.toolInput
      : {};
  if (tool === "read_file") {
    const fp = input.file_path || input.path;
    if (!fp) return null;
    const key = normalizeFilePath(String(fp));
    return key ? { type: "file", key } : null;
  }
  if (tool === "grep_search") {
    const q = input.pattern || input.query;
    if (!q) return null;
    const key = normalizeQuery(String(q));
    return key ? { type: "query", key } : null;
  }
  if (tool === "run_shell_command") {
    const c = input.command || input.description;
    if (!c) return null;
    const key = commandKey(String(c));
    return key ? { type: "command", key } : null;
  }
  return null;
}

// ---- 内部小工具 ------------------------------------------------------------

function sha16(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

function pathIsAbsoluteLike(s) {
  // 此时分隔符已统一为 "/":盘符绝对路径(C:/…)或 / 开头即视为绝对。
  return /^[a-zA-Z]:\//.test(s) || s.startsWith("/");
}

function posixNormalize(s) {
  // 相对路径轻量归一化(不依赖 path 模块的盘符语义)。
  const parts = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/") || ".";
}

module.exports = {
  MIN_ELIGIBLE_CHARS,
  COMPRESSIBLE_TOOLS,
  scenarioOf,
  classifyEligibility,
  extractAccess,
  normalizeFilePath,
  normalizeQuery,
  commandKey,
};
