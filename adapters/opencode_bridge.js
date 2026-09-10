"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const path = require("path");

// opencode 插件运行在 Bun 运行时里，process.execPath 指向 opencode.exe 而
// 不是 node；核心 hook 是 Node 脚本，必须用真实的 node 启动。
// 解析顺序：CODE_GUARD_NODE_BIN 显式指定 -> process.execPath 若是 node ->
// PATH 里查找 node(.exe) -> 兜底 process.execPath / "node"。
function resolveNodeExecutable() {
  const override = String(process.env.CODE_GUARD_NODE_BIN || "").trim();
  if (override) return override;

  const current = process.execPath;
  if (current && looksLikeNode(current)) return current;

  const fromPath = findNodeOnPath();
  if (fromPath) return fromPath;

  return current || "node";
}

function looksLikeNode(executable) {
  const base = path.basename(String(executable || "")).toLowerCase();
  return base === "node" || base === "node.exe";
}

function findNodeOnPath() {
  const exeName = process.platform === "win32" ? "node.exe" : "node";
  const dirs = String(process.env.PATH || "")
    .split(path.delimiter)
    .map((dir) => dir.replace(/^"(.*)"$/, "$1").trim())
    .filter(Boolean);
  for (const dir of dirs) {
    try {
      const candidate = path.join(dir, exeName);
      if (fs.existsSync(candidate)) return candidate;
    } catch (_e) {
      // 忽略无效 PATH 条目
    }
  }
  return "";
}

// 通过子进程调用未修改的核心入口 pre_tool_policy_hook.js / post_tool_policy_hook.js:
// stdin 传 JSON 载荷，读取 stdout 最后一行 JSON 作为结果。
// 这样核心策略文件保持单一来源，适配层只负责协议翻译。
function runHookScript(hookDir, scriptName, payload, env) {
  const scriptPath = path.join(hookDir, scriptName);
  const nodeExecutable = resolveNodeExecutable();
  const timeoutMs = Number(process.env.CODE_GUARD_HOOK_TIMEOUT_MS || 180000);
  const result = spawnSync(nodeExecutable, [scriptPath], {
    cwd: payload.cwd || process.cwd(),
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout: timeoutMs
  });

  if (result.error) throw result.error;

  const stderrText = String(result.stderr || "").slice(0, 2000);
  if (result.status !== 0) {
    throw new Error(
      `${scriptName} exited with code ${result.status}${stderrText ? ": " + stderrText : ""}`
    );
  }

  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length === 0) return {};
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    throw new Error(
      `${scriptName} returned invalid JSON: ${String(result.stdout || "").slice(0, 500)}`
    );
  }
}

module.exports = {
  runHookScript,
  resolveNodeExecutable,
  looksLikeNode,
  findNodeOnPath
};
