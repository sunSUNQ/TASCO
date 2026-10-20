// ============================================================================
// guard_core/runtime_paths.js — Runtime file system paths
// ============================================================================
// 运行时文件统一放在执行目录下的 .code-guard 目录中,并按会话(session_id)
// 分子目录:<执行目录>/.code-guard/<session_id>/。
// 可通过 CODE_GUARD_BASE_DIR 环境变量覆盖根目录。
// ============================================================================

const path = require("path");

const RUNTIME_ROOT =
  process.env.CODE_GUARD_BASE_DIR || path.join(process.cwd(), ".code-guard");

/** 当前会话标识(由入口在解析 payload 后设置)。 */
let ACTIVE_SESSION_ID = "";

/**
 * 将任意 session_id 规整为可用于目录名的安全形式。
 */
function sanitizeSessionId(id) {
  return String(id || "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 80);
}

/**
 * 设置当前会话 id。之后所有运行时文件都会写入该会话的目录。
 */
function setActiveSessionId(id) {
  ACTIVE_SESSION_ID = sanitizeSessionId(id);
}

/**
 * 当前会话目录:<root>/<session_id>;未设置会话时使用根目录。
 */
function sessionDir() {
  return ACTIVE_SESSION_ID
    ? path.join(RUNTIME_ROOT, ACTIVE_SESSION_ID)
    : RUNTIME_ROOT;
}

/**
 * 会话目录下的文件/子目录路径。
 */
function sessionPath(...parts) {
  return path.join(sessionDir(), ...parts);
}

module.exports = {
  BASE_DIR: RUNTIME_ROOT,
  RUNTIME_ROOT,
  sanitizeSessionId,
  setActiveSessionId,
  sessionDir,
  sessionPath,
};
