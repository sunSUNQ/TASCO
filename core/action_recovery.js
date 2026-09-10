"use strict";

// ============================================================================
// action_recovery.js — Action Recovery Protocol（ECOR v1.1, Patch 1）
// ============================================================================
// Experiment 2 暴露出 Runtime Protocol Mismatch：治理 hook 返回机器错误
// （BLOCK_NATIVE_REPLACE_UNSTABLE 等），但 DeepSeek/opencode 把 hook error
// 当普通工具错误处理，不知道下一步 -> BLOCK → retry → BLOCK 循环。
//
// 本模块把机器错误归一化成“模型可执行指令”：解析 BLOCK 码、hook 给出的
// 生成命令与 next 提示，输出明确的 Expected next action。这是 Tool Protocol
// Normalization，不是 prompt 优化，也不修改核心 hook。
// ============================================================================

// 同时识别 BLOCK_* 与 STOP_*（如 STOP_EVIDENCE_COMPLETE）两类治理码。
const BLOCK_CODE_RE = /\b((?:BLOCK|STOP)_[A-Z0-9_]+)\b/;
const GENERATED_CMD_MARKER = "Use only this generated command:";
const NEXT_MARKER = /Next:\s*([^\n]+)/i;

function extractBlockCode(reason) {
  const match = String(reason || "").match(BLOCK_CODE_RE);
  return match ? match[1] : "";
}

// 从 hook reason 中提取“Use only this generated command:”后面的完整命令行。
function extractGeneratedCommand(reason) {
  const text = String(reason || "");
  const idx = text.indexOf(GENERATED_CMD_MARKER);
  if (idx < 0) return "";
  let rest = text.slice(idx + GENERATED_CMD_MARKER.length).trim();
  // 命令可能跨多行引号片段，取到空行/文件元数据行为止
  const lines = rest.split(/\r?\n/);
  const cmdLines = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^(file|old_|new_|target_|requested_|phase|specReads|verified)/i.test(t)) break;
    cmdLines.push(t);
  }
  if (cmdLines.length === 0) return "";
  let cmd = cmdLines.join(" ");
  // 去掉首尾的成对引号（外层引号包裹整条命令时）
  if (cmd.startsWith('"') && cmd.endsWith('"')) {
    cmd = cmd.slice(1, -1);
  }
  return cmd.trim();
}

function extractTmpDir(reason) {
  const m = String(reason || "").match(/\.code-guard[\\/]ses_[A-Za-z0-9_-]+[\\/]tmp/);
  return m ? m[0] : "";
}

function extractNextHint(reason) {
  const m = String(reason || "").match(NEXT_MARKER);
  return m ? m[1].trim() : "";
}

function normalizeReplaceInstruction({ code, generatedCommand, nextHint, tmpDir }) {
  const lines = [];
  if (code === "BLOCK_NATIVE_REPLACE_UNSTABLE") {
    lines.push(
      "The native edit was blocked because old_string is not stable enough " +
        "(governance safety). Do NOT retry the edit tool."
    );
    if (generatedCommand) {
      lines.push("Execute exactly this generated command:");
      lines.push(`  ${generatedCommand}`);
    }
    lines.push("Expected next action: run the command above directly.");
  } else if (code === "BLOCK_INVALID_SAFE_REPLACE_COMMAND") {
    lines.push(
      "The safe_replace.py invocation was invalid. safe_replace.py requires " +
        "exactly one replace_json path."
    );
    lines.push(
      `Write the replace JSON under ${tmpDir || "<session tmp dir>"} with name ` +
        "safe_replace_<timestamp>_<pid>.json, then run: python safe_replace.py <json path>."
    );
    lines.push("Do not pass line numbers. Do not execute safe_replace_test.json.");
  } else if (code === "BLOCK_INVALID_SLICE_ARGS") {
    lines.push("read_file_slice.py arguments were invalid. Use one of:");
    lines.push('  python read_file_slice.py "<file>" <start_line> <end_line>');
    lines.push('  python read_file_slice.py "<file>" --start-line <N> --end-line <M>');
  } else if (
    /^(STOP_|BLOCK_REPLACE_NEEDS_RECOVERY_SLICE)/.test(code || "") ||
    /STOP_EVIDENCE|verified_code_evidence_missing/i.test(code + " " + (nextHint || ""))
  ) {
    lines.push(
      "Evidence is required before editing. Read the target function body with " +
        "read_file_slice.py <file> <start> <end> or smart_read_file.py --query <symbol>, " +
        "then retry the edit."
    );
  } else if (
    code === "BLOCK_INVALID_SMART_READ" ||
    code === "BLOCK_HELPER_INVALID_ARGS"
  ) {
    lines.push(
      "Helper arguments were invalid. smart_read_file.py usage: " +
        'python smart_read_file.py "<file>" --query "<symbol>" (or --mode). ' +
        "Helpers only run via CLI with the allowlisted arguments."
    );
  } else if (
    /BLOCK_(UNCONTROLLED_|INVALID_)?SAFE_REPLACE_JSON_WRITE/.test(code || "") ||
    code === "BLOCK_SHELL_ADHOC_WRITE"
  ) {
    lines.push(
      "Do NOT create or write the replace JSON yourself. The hook already generated " +
        "it; execute the exact generated command from the error."
    );
  } else if (code === "BLOCK_NATIVE_WRITE_FILE_EXISTING_SOURCE") {
    lines.push(
      "Do not use write_file on an existing source file. Use edit with a stable " +
        "old_string (or the generated safe_replace command)."
    );
  } else {
    lines.push(
      `The action was blocked by governance (${code || "BLOCK"}). Do not retry the ` +
        "same call blindly."
    );
    if (nextHint) lines.push(`Next: ${nextHint}`);
  }
  return lines.join("\n");
}

/**
 * 解析治理拦截原因，返回结构化 recovery 信息。
 */
function parseBlockReason(reason, options) {
  const opts = options || {};
  const text = String(reason || "");
  const code = opts.code || extractBlockCode(text);
  const generatedCommand = extractGeneratedCommand(text);
  const tmpDir = extractTmpDir(text);
  const nextHint = extractNextHint(text);
  const instruction = normalizeReplaceInstruction({
    code,
    generatedCommand,
    nextHint,
    tmpDir,
  });
  return { code, generatedCommand, tmpDir, nextHint, instruction };
}

/**
 * 把原始 deny 错误归一化为带“Expected next action”的模型可执行错误。
 * 保留 err.code = CODE_GUARD_DENY，opencode 语义不变。
 */
function normalizeDenyError(err) {
  const reason = err && err.message ? err.message : String(err);
  const parsed = parseBlockReason(reason);
  const normalized = new Error(
    `[code-guard] ${parsed.instruction}\n\n` +
      (parsed.generatedCommand
        ? `Generated command:\n${parsed.generatedCommand}\n\n`
        : "") +
      `Original reason:\n${reason}`
  );
  normalized.code = "CODE_GUARD_DENY";
  normalized.recovery = parsed;
  return normalized;
}

module.exports = {
  BLOCK_CODE_RE,
  extractBlockCode,
  extractGeneratedCommand,
  extractTmpDir,
  extractNextHint,
  normalizeReplaceInstruction,
  parseBlockReason,
  normalizeDenyError,
};
